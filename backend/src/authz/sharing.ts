import type { PrismaClient } from "../generated/client";
import crypto from "crypto";
import { hashTokenForStorage } from "../auth/tokenSecurity";

export type DrawingPermission = "view" | "edit";
export type DrawingAccess = "none" | DrawingPermission | "owner";

export type DrawingPrincipal = {
  kind: "user";
  userId: string;
  /**
   * Only the auth-disabled bootstrap identity may represent an inactive row.
   * Real JWT/API-key principals must be revalidated on access; the live socket
   * path may coalesce this one status read for a few hundred milliseconds and
   * explicitly invalidates it on account changes.
   */
  allowInactive?: boolean;
  apiKey?: {
    id: string;
    scopes: readonly string[];
  };
};

export const normalizeDrawingPermission = (input: unknown): DrawingPermission | null => {
  if (input === "view" || input === "edit") return input;
  return null;
};

export const buildShareLinkToken = (): string => crypto.randomBytes(24).toString("base64url");

export const hashShareLinkToken = (token: string): string => hashTokenForStorage(token);

export const parseShareLinkToken = (input: unknown): string | null => {
  if (typeof input !== "string") return null;
  const token = input.trim();
  return /^[A-Za-z0-9_-]{32}$/.test(token) ? token : null;
};

export const shareLinkTokenFromRequest = (req: {
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
}): string | null =>
  parseShareLinkToken(req.headers["x-share-token"]) ?? parseShareLinkToken(req.query.shareToken);

export const shareLinkTokenMatches = (providedToken: string, storedHash: string): boolean => {
  const actual = Buffer.from(hashShareLinkToken(providedToken), "hex");
  const storedHashIsValid = /^[0-9a-f]{64}$/i.test(storedHash);
  const expected = Buffer.from(storedHashIsValid ? storedHash : "0".repeat(64), "hex");
  const matches = crypto.timingSafeEqual(actual, expected);
  return storedHashIsValid && matches;
};

export const getDrawingAccess = async (params: {
  prisma: PrismaClient;
  principal: DrawingPrincipal | null;
  drawingId: string;
  shareToken?: string | null;
  now?: Date;
  isUserActive?: (userId: string) => Promise<boolean>;
}): Promise<DrawingAccess> => {
  const nowMs = (params.now ?? new Date()).getTime();

  let baseAccess: DrawingAccess = "none";

  // User-based access (owner or explicit ACL).
  if (params.principal?.kind === "user") {
    if (!params.principal.allowInactive) {
      const accountIsActive = params.isUserActive
        ? await params.isUserActive(params.principal.userId)
        : Boolean(
            (
              await params.prisma.user.findUnique({
                where: { id: params.principal.userId },
                select: { isActive: true },
              })
            )?.isActive,
          );
      // An authenticated inactive account must not retain access through a
      // public-link fallback on an already established connection.
      if (!accountIsActive) return "none";
    }
    const drawing = await params.prisma.drawing.findUnique({
      where: { id: params.drawingId },
      select: { userId: true, collectionId: true },
    });
    if (!drawing) return "none";
    if (drawing.userId === params.principal.userId) return "owner";

    const perm = await params.prisma.drawingPermission.findUnique({
      where: {
        drawingId_granteeUserId: {
          drawingId: params.drawingId,
          granteeUserId: params.principal.userId,
        },
      },
      select: { permission: true },
    });
    baseAccess = maxAccess(baseAccess, normalizeDrawingPermission(perm?.permission) ?? "none");

    // Both claims are always evaluated. Stopping at the direct permission let a
    // narrow one hide a wider inherited one: someone with edit on the collection
    // lost the right to write the moment they were also granted view on a single
    // drawing in it, which reads as a share and behaves as a revocation.
    if (drawing.collectionId) {
      // The collection's owner controls what is in it, including boards created
      // there by someone they shared it with.
      const ownedCollection = await params.prisma.collection.findFirst({
        where: {
          id: drawing.collectionId,
          userId: params.principal.userId,
        },
        select: { id: true },
      });
      if (ownedCollection) {
        baseAccess = "owner";
      } else {
        const collectionShare = await params.prisma.collectionShare.findFirst({
          where: {
            collectionId: drawing.collectionId,
            granteeUserId: params.principal.userId,
          },
          select: { role: true },
        });
        baseAccess = maxAccess(
          baseAccess,
          normalizeDrawingPermission(collectionShare?.role) ?? "none",
        );
      }
    }
  }

  // Link access is additive to account access, but only possession of the
  // current secret activates it. The drawing id is an object identifier, not
  // an authorization credential.
  const linkPolicy = params.shareToken
    ? await getActiveLinkShareAccess({
        prisma: params.prisma,
        drawingId: params.drawingId,
        shareToken: params.shareToken,
        nowMs,
      })
    : null;
  const linkAccess: DrawingAccess = linkPolicy ?? "none";

  return maxAccess(baseAccess, linkAccess);
};

export const canViewDrawing = (access: DrawingAccess): access is Exclude<DrawingAccess, "none"> =>
  access !== "none";

export const canEditDrawing = (
  access: DrawingAccess,
): access is Extract<DrawingAccess, "edit" | "owner"> => access === "edit" || access === "owner";

export const isOwnerAccess = (access: DrawingAccess): boolean => access === "owner";

const getActiveLinkShareAccess = async (params: {
  prisma: PrismaClient;
  drawingId: string;
  shareToken: string;
  nowMs: number;
}): Promise<DrawingPermission | null> => {
  const linkShare = await params.prisma.drawingLinkShare.findFirst({
    where: {
      drawingId: params.drawingId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(params.nowMs) } }],
    },
    orderBy: { createdAt: "desc" },
    select: { permission: true, tokenHash: true },
  });
  if (!linkShare || !shareLinkTokenMatches(params.shareToken, linkShare.tokenHash)) return null;
  return normalizeDrawingPermission(linkShare?.permission);
};

const accessRank = (access: DrawingAccess): number => {
  switch (access) {
    case "owner":
      return 3;
    case "edit":
      return 2;
    case "view":
      return 1;
    default:
      return 0;
  }
};

const maxAccess = (a: DrawingAccess, b: DrawingAccess): DrawingAccess =>
  accessRank(a) >= accessRank(b) ? a : b;
