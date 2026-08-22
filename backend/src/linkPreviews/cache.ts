import { removeStored } from "../assets/assetStorage";
import type { LinkPreviewConfig } from "../config";

export type LinkPreviewCacheDeps = {
  prisma: any;
  storageDir: string;
  config: LinkPreviewConfig;
  now?: () => number;
};

/** Avoid deleting a blob while another instance is between storing and linking it. */
export const PREVIEW_BLOB_GRACE_MS = 60 * 60 * 1000;

/**
 * Take a blob out of circulation before deleting it.
 *
 * Reference counting on its own is check-then-act: another request can adopt
 * the same bytes by hash in the gap, and then lose the file underneath itself.
 * Moving the row to DELETING first is a claim — a reuse that sees a blob in
 * that state stores its own copy instead.
 */
async function claimForDeletion(deps: LinkPreviewCacheDeps, blobId: string): Promise<boolean> {
  const claimed = await deps.prisma.storedBlob.updateMany({
    where: { id: blobId, state: "READY" },
    data: { state: "DELETING" },
  });
  if (claimed.count === 0) return false;
  const [assets, previews] = await Promise.all([
    deps.prisma.asset.count({ where: { blobId } }),
    deps.prisma.linkPreview.count({
      where: { OR: [{ imageBlobId: blobId }, { faviconBlobId: blobId }] },
    }),
  ]);
  if (assets + previews > 0) {
    // Somebody referenced it after all. Put it back rather than deleting it.
    await deps.prisma.storedBlob.updateMany({
      where: { id: blobId, state: "DELETING" },
      data: { state: "READY" },
    });
    return false;
  }
  return true;
}

async function releaseUnusedBlob(deps: LinkPreviewCacheDeps, blobId: string) {
  const [blob, assets, previews] = await Promise.all([
    deps.prisma.storedBlob.findUnique({
      where: { id: blobId },
      select: { id: true, storageKey: true, createdAt: true },
    }),
    deps.prisma.asset.count({ where: { blobId } }),
    deps.prisma.linkPreview.count({
      where: { OR: [{ imageBlobId: blobId }, { faviconBlobId: blobId }] },
    }),
  ]);
  if (!blob || assets + previews > 0) return false;

  const now = deps.now?.() ?? Date.now();
  // The grace period exists for one case: another instance has stored a blob
  // and has not linked it yet. A blob older than that window cannot be in it,
  // so its bytes go now rather than in an hour. Leaving them would make
  // eviction useless — what decides whether a preview may be stored is what is
  // on disk, so dropping the row while keeping the file frees nothing and the
  // cache can end up empty and still refusing to take anything.
  if (now - new Date(blob.createdAt).getTime() >= PREVIEW_BLOB_GRACE_MS) {
    if (!(await claimForDeletion(deps, blobId))) return true;
    await removeStored(deps.storageDir, blob.storageKey);
    await deps.prisma.storedBlob.deleteMany({ where: { id: blobId } });
    return true;
  }

  await deps.prisma.storedBlob.updateMany({
    where: { id: blobId },
    data: {
      state: "READY",
      deleteAfter: new Date(now + PREVIEW_BLOB_GRACE_MS),
    },
  });
  return true;
}

async function discardRow(deps: LinkPreviewCacheDeps, row: any): Promise<void> {
  await deps.prisma.linkPreview.deleteMany({ where: { id: row.id } });
  const blobIds = [...new Set([row.imageBlobId, row.faviconBlobId].filter(Boolean))] as string[];
  for (const blobId of blobIds) await releaseUnusedBlob(deps, blobId);
}

export async function freshCached(
  deps: LinkPreviewCacheDeps,
  cacheKey: string,
): Promise<any | null> {
  const row = await deps.prisma.linkPreview.findUnique({ where: { cacheKey } });
  if (!row) return null;
  if (row.expiresAt.getTime() > (deps.now?.() ?? Date.now())) {
    const lastAccessedAt = new Date(deps.now?.() ?? Date.now());
    await deps.prisma.linkPreview
      .update({ where: { id: row.id }, data: { lastAccessedAt } })
      .catch(() => undefined);
    return { ...row, lastAccessedAt };
  }
  await discardRow(deps, row);
  return null;
}

export async function replaceCachedRow(
  deps: LinkPreviewCacheDeps,
  key: string,
  create: Record<string, unknown>,
  update: Record<string, unknown>,
) {
  const previous = await deps.prisma.linkPreview.findUnique({ where: { cacheKey: key } });
  const row = await deps.prisma.linkPreview.upsert({
    where: { cacheKey: key },
    create,
    update,
  });
  const currentIds = new Set([row.imageBlobId, row.faviconBlobId].filter(Boolean));
  const replacedIds = [previous?.imageBlobId, previous?.faviconBlobId].filter(
    (id): id is string => Boolean(id) && !currentIds.has(id),
  );
  for (const blobId of new Set(replacedIds)) await releaseUnusedBlob(deps, blobId);
  return row;
}

async function previewCacheBytes(prisma: any, ownerUserId?: string): Promise<number> {
  const result = await prisma.storedBlob.aggregate({
    where: {
      OR: ownerUserId
        ? [
            { linkPreviewImages: { some: { ownerUserId } } },
            { linkPreviewFavicons: { some: { ownerUserId } } },
          ]
        : [{ linkPreviewImages: { some: {} } }, { linkPreviewFavicons: { some: {} } }],
    },
    _sum: { storedBytes: true },
  });
  return result._sum.storedBytes ?? 0;
}

/** All preview-origin bytes still occupying disk, including released race orphans. */
export async function previewDiskBytes(prisma: any): Promise<number> {
  const result = await prisma.storedBlob.aggregate({
    where: {
      OR: [
        { purpose: "LINK_PREVIEW" },
        { linkPreviewImages: { some: {} } },
        { linkPreviewFavicons: { some: {} } },
      ],
    },
    _sum: { storedBytes: true },
  });
  return result._sum.storedBytes ?? 0;
}

/** Evict per-user excess and then global LRU entries until cache art is under budget. */
export async function evictLinkPreviewCache(
  deps: LinkPreviewCacheDeps,
  userId?: string,
  force = false,
): Promise<number> {
  let removed = 0;
  const batch = Math.max(1, deps.config.cleanupBatchSize);
  if (userId) {
    let excess = Math.max(
      0,
      (await deps.prisma.linkPreview.count({ where: { ownerUserId: userId } })) -
        deps.config.maxEntriesPerUser,
    );
    while (excess > 0) {
      const rows = await deps.prisma.linkPreview.findMany({
        where: { ownerUserId: userId },
        orderBy: [{ lastAccessedAt: "asc" }, { id: "asc" }],
        take: Math.min(batch, excess),
      });
      if (rows.length === 0) break;
      for (const row of rows) await discardRow(deps, row);
      removed += rows.length;
      excess -= rows.length;
    }

    let userBytes = await previewCacheBytes(deps.prisma, userId);
    const userTarget = deps.config.maxBytesPerUser * 0.9;
    while (userBytes > deps.config.maxBytesPerUser) {
      const rows = await deps.prisma.linkPreview.findMany({
        where: { ownerUserId: userId },
        orderBy: [{ lastAccessedAt: "asc" }, { id: "asc" }],
        take: batch,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        if (userBytes <= userTarget) break;
        await discardRow(deps, row);
        removed += 1;
        userBytes = await previewCacheBytes(deps.prisma, userId);
      }
    }
  }

  // Measured the same way admission measures it. Counting only referenced rows
  // here while admission counts every preview byte on disk is how eviction
  // could report success and still leave no room.
  let used = await previewDiskBytes(deps.prisma);
  if (!force && used <= deps.config.cacheBudgetBytes) return removed;
  const target = force ? 0 : deps.config.cacheBudgetBytes * 0.9;
  while (used > target) {
    const rows = await deps.prisma.linkPreview.findMany({
      orderBy: [{ lastAccessedAt: "asc" }, { id: "asc" }],
      take: batch,
    });
    if (rows.length === 0) break;
    for (const row of rows) await discardRow(deps, row);
    removed += rows.length;
    const next = await previewDiskBytes(deps.prisma);
    if (next >= used) break;
    used = next;
  }
  return removed;
}

async function deleteOrphanBlob(deps: LinkPreviewCacheDeps, blob: any): Promise<boolean> {
  if (!(await claimForDeletion(deps, blob.id))) return false;
  await removeStored(deps.storageDir, blob.storageKey);
  const result = await deps.prisma.storedBlob.deleteMany({ where: { id: blob.id } });
  return result.count > 0;
}

export async function collectExpiredLinkPreviews(
  deps: LinkPreviewCacheDeps,
): Promise<{ previews: number; blobs: number }> {
  const now = deps.now?.() ?? Date.now();
  const batch = Math.max(1, deps.config.cleanupBatchSize);
  let previews = 0;
  for (;;) {
    const expired = await deps.prisma.linkPreview.findMany({
      where: { expiresAt: { lte: new Date(now) } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: batch,
    });
    if (expired.length === 0) break;
    for (const row of expired) await discardRow(deps, row);
    previews += expired.length;
  }

  let blobs = 0;
  for (;;) {
    const orphans = await deps.prisma.storedBlob.findMany({
      where: {
        purpose: "LINK_PREVIEW",
        state: "READY",
        assets: { none: {} },
        linkPreviewImages: { none: {} },
        linkPreviewFavicons: { none: {} },
        OR: [
          { deleteAfter: { lte: new Date(now) } },
          { deleteAfter: null, createdAt: { lte: new Date(now - PREVIEW_BLOB_GRACE_MS) } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: batch,
    });
    if (orphans.length === 0) break;
    let progressed = false;
    for (const blob of orphans) {
      if (await deleteOrphanBlob(deps, blob)) {
        blobs += 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return { previews, blobs };
}
