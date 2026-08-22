import type { PrismaClient } from "../generated/client";
import { normalizeDrawingPermission, type DrawingPermission } from "./sharing";

/**
 * Membership is deliberately narrower than access.
 *
 * `getDrawingAccess` folds an active share link into the answer, because
 * possession of the URL is meant to grant access. That is right for opening a
 * drawing and wrong for everything that reveals *who else is here*: a signed-in
 * account that merely holds a public link is not part of the team, and must not
 * learn the roster or see presence from the dashboard.
 *
 * So this module answers a different question — "does this account have a claim
 * of its own on this drawing, and where does it come from?" — and never consults
 * link shares.
 *
 * The caller is responsible for having established that the account is active.
 */
export type MembershipSource = "drawing-owner" | "collection-owner" | "direct" | "collection-share";

export type MembershipLevel = DrawingPermission | "owner";

export type DrawingMembership = {
  level: MembershipLevel;
  sources: MembershipSource[];
};

const LEVEL_RANK: Record<MembershipLevel, number> = { view: 1, edit: 2, owner: 3 };

const addClaim = (
  memberships: Map<string, DrawingMembership>,
  drawingId: string,
  level: MembershipLevel,
  source: MembershipSource,
) => {
  const existing = memberships.get(drawingId);
  if (!existing) {
    memberships.set(drawingId, { level, sources: [source] });
    return;
  }
  if (!existing.sources.includes(source)) existing.sources.push(source);
  if (LEVEL_RANK[level] > LEVEL_RANK[existing.level]) existing.level = level;
};

const uniqueIds = (values: readonly unknown[]): string[] =>
  Array.from(
    new Set(values.filter((value): value is string => typeof value === "string" && !!value)),
  );

/**
 * One batched lookup for many drawings: four queries regardless of how many ids
 * are asked about, so a dashboard page costs the same as a single card.
 * Drawings the account has no claim on are simply absent from the map — callers
 * must not distinguish "not a member" from "does not exist".
 */
export const getDrawingMemberships = async (params: {
  prisma: PrismaClient;
  userId: string;
  drawingIds: readonly string[];
}): Promise<Map<string, DrawingMembership>> => {
  const memberships = new Map<string, DrawingMembership>();
  const ids = uniqueIds(params.drawingIds);
  if (!params.userId || ids.length === 0) return memberships;

  const drawings = await params.prisma.drawing.findMany({
    where: { id: { in: ids } },
    select: { id: true, userId: true, collectionId: true },
  });
  if (drawings.length === 0) return memberships;

  const presentIds = drawings.map((drawing) => drawing.id);
  const collectionIds = uniqueIds(drawings.map((drawing) => drawing.collectionId));

  const [permissions, ownedCollections, collectionShares] = await Promise.all([
    params.prisma.drawingPermission.findMany({
      where: { drawingId: { in: presentIds }, granteeUserId: params.userId },
      select: { drawingId: true, permission: true },
    }),
    collectionIds.length
      ? params.prisma.collection.findMany({
          where: { id: { in: collectionIds }, userId: params.userId },
          select: { id: true },
        })
      : Promise.resolve([] as { id: string }[]),
    collectionIds.length
      ? params.prisma.collectionShare.findMany({
          where: { collectionId: { in: collectionIds }, granteeUserId: params.userId },
          select: { collectionId: true, role: true },
        })
      : Promise.resolve([] as { collectionId: string; role: string }[]),
  ]);

  const permissionByDrawing = new Map<string, DrawingPermission | null>(
    permissions.map((row) => [row.drawingId, normalizeDrawingPermission(row.permission)] as const),
  );
  const ownedCollectionIds = new Set(ownedCollections.map((row) => row.id));
  const shareByCollection = new Map<string, DrawingPermission | null>(
    collectionShares.map(
      (row) => [row.collectionId, normalizeDrawingPermission(row.role)] as const,
    ),
  );

  for (const drawing of drawings) {
    if (drawing.userId === params.userId) {
      addClaim(memberships, drawing.id, "owner", "drawing-owner");
    }
    const direct = permissionByDrawing.get(drawing.id);
    if (direct) addClaim(memberships, drawing.id, direct, "direct");
    if (!drawing.collectionId) continue;
    if (ownedCollectionIds.has(drawing.collectionId)) {
      addClaim(memberships, drawing.id, "owner", "collection-owner");
      continue;
    }
    const shared = shareByCollection.get(drawing.collectionId);
    if (shared) addClaim(memberships, drawing.id, shared, "collection-share");
  }

  return memberships;
};

export const getDrawingMembership = async (params: {
  prisma: PrismaClient;
  userId: string;
  drawingId: string;
}): Promise<DrawingMembership | null> => {
  const memberships = await getDrawingMemberships({
    prisma: params.prisma,
    userId: params.userId,
    drawingIds: [params.drawingId],
  });
  return memberships.get(params.drawingId) ?? null;
};

const canManageSharing = (membership: DrawingMembership | null): boolean =>
  membership?.level === "owner";

/**
 * Who may hand this board to someone else.
 *
 * Not the same as `Drawing.userId`: a board created inside a shared collection
 * belongs to whoever drew it, while the collection's owner already has owner
 * access to it. Checking only the row's own userId made the editor offer a share
 * button that answered 404 -- the same word, "owner", meaning two things one
 * route apart.
 */
export const controlsDrawing = async (params: {
  prisma: PrismaClient;
  userId: string;
  drawingId: string;
}): Promise<boolean> => canManageSharing(await getDrawingMembership(params));
