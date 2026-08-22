import crypto from "crypto";
import type { Prisma, PrismaClient } from "../generated/client";
import { revokeUserCredentials } from "./userCredentialRevocation";

export const COMPANY_ARCHIVE_USER_EMAIL = "deleted-boards@placeholder.excalidash.invalid";
const COMPANY_ARCHIVE_USER_NAME = "Deleted user boards";

export class UserOffboardingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type TransactionClient = Prisma.TransactionClient;

const resolveCompanyArchiveUser = async (tx: TransactionClient): Promise<string> => {
  const existing = await tx.user.findUnique({
    where: { email: COMPANY_ARCHIVE_USER_EMAIL },
    select: { id: true, name: true, isActive: true, role: true },
  });
  if (existing) {
    if (
      existing.name !== COMPANY_ARCHIVE_USER_NAME ||
      existing.isActive ||
      existing.role !== "USER"
    ) {
      throw new UserOffboardingError(409, "The reserved company archive account is already in use");
    }
    return existing.id;
  }

  const created = await tx.user.create({
    data: {
      email: COMPANY_ARCHIVE_USER_EMAIL,
      username: null,
      name: COMPANY_ARCHIVE_USER_NAME,
      // The account is permanently inactive. A random non-bcrypt value also
      // makes local password verification impossible if it is exposed by a
      // future regression.
      passwordHash: crypto.randomBytes(32).toString("hex"),
      role: "USER",
      mustResetPassword: false,
      isActive: false,
    },
    select: { id: true },
  });
  return created.id;
};

export type UserOffboardingResult = {
  successorUserId: string;
  transferredDrawings: number;
  revokedApiKeyIds: string[];
};

/**
 * Permanently remove one human identity while retaining company-owned board
 * data. This is deliberately separate from ordinary account deactivation.
 */
export const offboardUserAndTransferBoards = async (params: {
  prisma: PrismaClient;
  userId: string;
  successorUserId: string | null;
  useCompanyArchive: boolean;
}): Promise<UserOffboardingResult> =>
  params.prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({
      where: { id: params.userId },
      select: { id: true, email: true, username: true },
    });
    if (!target) throw new UserOffboardingError(404, "User not found");

    const successorUserId = params.useCompanyArchive
      ? await resolveCompanyArchiveUser(tx)
      : params.successorUserId;
    if (!successorUserId || successorUserId === params.userId) {
      throw new UserOffboardingError(
        400,
        "Choose a different successor or the company archive account",
      );
    }
    if (!params.useCompanyArchive) {
      const successor = await tx.user.findUnique({
        where: { id: successorUserId },
        select: { id: true, isActive: true },
      });
      if (!successor?.isActive) {
        throw new UserOffboardingError(409, "The selected successor must be an active user");
      }
    }

    const now = new Date();
    await tx.user.update({
      where: { id: params.userId },
      data: { isActive: false },
    });
    const revokedApiKeyIds = await revokeUserCredentials(tx, params.userId, now);

    // Collections are personal organization. Boards are retained, detached
    // from those collections, and assigned to the chosen company custodian.
    const transferred = await tx.drawing.updateMany({
      where: { userId: params.userId },
      data: { userId: successorUserId, collectionId: null },
    });
    const auditIdentifiers = [params.userId, target.email, target.username].filter(
      (value): value is string => Boolean(value),
    );
    const personalAuditClauses: Prisma.AuditLogWhereInput[] = [
      { userId: params.userId },
      ...auditIdentifiers.flatMap((identifier) => [
        { resource: { contains: identifier } },
        { details: { contains: identifier } },
      ]),
    ];
    await Promise.all([
      tx.s3File.updateMany({
        where: { userId: params.userId },
        data: { userId: successorUserId },
      }),
      tx.asset.updateMany({
        where: { ownerUserId: params.userId },
        data: { ownerUserId: successorUserId },
      }),
      tx.asset.updateMany({
        where: { uploadedByUserId: params.userId },
        data: { uploadedByUserId: null },
      }),
      // Creator ids are strings rather than relations, so cascades cannot
      // remove their link to the departing person.
      tx.drawingPermission.updateMany({
        where: { createdByUserId: params.userId },
        data: { createdByUserId: successorUserId },
      }),
      tx.drawingLinkShare.updateMany({
        where: { createdByUserId: params.userId },
        data: { createdByUserId: successorUserId },
      }),
      tx.collectionShare.updateMany({
        where: { createdByUserId: params.userId },
        data: { createdByUserId: successorUserId },
      }),
      tx.library.deleteMany({ where: { id: `user_${params.userId}` } }),
      tx.auditLog.deleteMany({
        where: { OR: personalAuditClauses },
      }),
    ]);

    // Cascades remove credentials, OIDC identities, reset tokens, personal
    // collections and grants. All board/document ownership was moved first.
    await tx.user.delete({ where: { id: params.userId } });

    return {
      successorUserId,
      transferredDrawings: transferred.count,
      revokedApiKeyIds,
    };
  });
