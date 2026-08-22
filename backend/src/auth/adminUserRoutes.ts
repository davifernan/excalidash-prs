import bcrypt from "bcrypt";
import { Request, Response } from "express";
import { Prisma } from "../generated/client";
import { logAuditEvent } from "../utils/audit";
import type { RegisterAdminRoutesDeps } from "./adminRoutes";
import { registerAdminUserPasswordRoutes } from "./adminUserPasswordRoutes";
import { adminCreateUserSchema, adminRoleUpdateSchema, adminUpdateUserSchema } from "./schemas";
import crypto from "crypto";
import { hashTokenForStorage } from "./tokenSecurity";
import { buildUserInviteEmail } from "../mail/templates/userInvite";
import { disconnectApiKeySockets, recheckActiveUserSockets } from "../server/socketRevocation";
import { COMPANY_ARCHIVE_USER_EMAIL } from "./userOffboarding";
import { revokeUserCredentials } from "./userCredentialRevocation";
import { registerAdminUserOffboardingRoutes } from "./adminUserOffboardingRoutes";

const INVITE_VALID_DAYS = 7;
export const registerAdminUserRoutes = (deps: RegisterAdminRoutesDeps) => {
  const {
    router,
    prisma,
    requireAuth,
    accountActionRateLimiter,
    ensureAuthEnabled,
    requireAdmin,
    findUserByIdentifier,
    countActiveAdmins,
    sanitizeText,
    config,
    requireCsrf,
    mailer,
  } = deps;

  /** Invitation links always point at the first configured frontend origin. */
  const resolveFrontendBaseUrl = (): string => {
    const raw = config.frontendUrl?.split(",")[0]?.trim();
    const withProtocol = raw
      ? /^https?:\/\//i.test(raw)
        ? raw
        : `http://${raw}`
      : "http://localhost:6767";
    return withProtocol.replace(/\/$/, "");
  };
  router.post("/admins", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!requireCsrf(req, res)) return;
      if (!requireAdmin(req, res)) return;
      const parsed = adminRoleUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Bad request",
          message: "Invalid admin update payload",
        });
      }
      const target = await findUserByIdentifier(parsed.data.identifier);
      if (!target) {
        return res.status(404).json({ error: "Not found", message: "User not found" });
      }
      if (target.id === req.user.id && parsed.data.role !== "ADMIN") {
        return res.status(409).json({
          error: "Conflict",
          message: "You cannot change your own role from ADMIN",
        });
      }
      if (target.role === "ADMIN" && parsed.data.role !== "ADMIN" && target.isActive) {
        const admins = await countActiveAdmins();
        if (admins <= 1) {
          return res.status(409).json({
            error: "Conflict",
            message: "There must be at least one active admin",
          });
        }
      }
      const updated = await prisma.user.update({
        where: { id: target.id },
        data: { role: parsed.data.role },
        select: {
          id: true,
          username: true,
          email: true,
          name: true,
          role: true,
          mustResetPassword: true,
          isActive: true,
        },
      });
      res.json({ user: updated });
    } catch (error) {
      console.error("Admin role update error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to update user role",
      });
    }
  });
  /**
   * Every API key on the instance, with its owner.
   *
   * The per-account routes deliberately scope to the caller, so an admin had
   * no way to see which machine credentials exist — only to hear about them.
   */
  router.get("/users/api-keys", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!requireAdmin(req, res)) return;
      const keys = await prisma.apiKey.findMany({
        orderBy: [{ createdAt: "desc" }],
        select: {
          id: true,
          name: true,
          prefix: true,
          scopes: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true, username: true } },
        },
      });
      res.json({ apiKeys: keys });
    } catch (error) {
      console.error("List API keys error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to list API keys",
      });
    }
  });

  /** Revoking is kept separate from deleting: the record stays auditable. */
  router.delete("/users/api-keys/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!requireCsrf(req, res)) return;
      if (!requireAdmin(req, res)) return;
      const existing = await prisma.apiKey.findUnique({
        where: { id: req.params.id },
        select: { id: true, revokedAt: true, userId: true },
      });
      if (!existing) {
        return res.status(404).json({ error: "Not found", message: "API key not found" });
      }
      if (!existing.revokedAt) {
        await prisma.apiKey.update({
          where: { id: existing.id },
          data: { revokedAt: new Date() },
        });
      }
      await disconnectApiKeySockets(existing.id);
      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user!.id,
          action: "admin_api_key_revoked",
          resource: `apiKey:${existing.id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { ownerUserId: existing.userId },
        });
      }
      res.json({ revoked: true });
    } catch (error) {
      console.error("Revoke API key error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to revoke API key",
      });
    }
  });

  router.get("/users", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!requireAdmin(req, res)) return;
      const users = await prisma.user.findMany({
        where: { email: { not: COMPANY_ARCHIVE_USER_EMAIL } },
        orderBy: [{ createdAt: "asc" }],
        select: {
          id: true,
          username: true,
          email: true,
          name: true,
          role: true,
          mustResetPassword: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      res.json({ users });
    } catch (error) {
      console.error("List users error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to list users",
      });
    }
  });
  router.post(
    "/users",
    requireAuth,
    accountActionRateLimiter,
    async (req: Request, res: Response) => {
      try {
        if (!(await ensureAuthEnabled(res))) return;
        if (!requireCsrf(req, res)) return;
        if (!requireAdmin(req, res)) return;
        const parsed = adminCreateUserSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Validation error",
            message: "Invalid user payload",
          });
        }
        const {
          email,
          password,
          name,
          username,
          role,
          mustResetPassword,
          isActive,
          oidcOnly,
          sendInvite,
        } = parsed.data;
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (existingUser) {
          return res.status(409).json({
            error: "Conflict",
            message: "User with this email already exists",
          });
        }
        if (username) {
          const existingUsername = await prisma.user.findFirst({
            where: { username },
            select: { id: true },
          });
          if (existingUsername) {
            return res.status(409).json({
              error: "Conflict",
              message: "User with this username already exists",
            });
          }
        }
        if (oidcOnly && !config.oidc.enabled) {
          return res.status(409).json({
            error: "Conflict",
            message: "OIDC-only invited users require OIDC to be enabled.",
          });
        }
        // An invited account still needs a real hash: redeeming the link goes
        // through the password reset flow, which refuses accounts without one.
        // The value is random and never leaves the server.
        const invitePassword =
          !oidcOnly && !password ? crypto.randomBytes(24).toString("base64url") : null;
        const effectivePassword = password ?? invitePassword;
        const passwordHash =
          oidcOnly || !effectivePassword ? "" : await bcrypt.hash(effectivePassword, 10);
        const sanitizedName = sanitizeText(name, 100);
        const user = await prisma.user.create({
          data: {
            email,
            username: username ?? null,
            passwordHash,
            name: sanitizedName,
            role: role ?? "USER",
            mustResetPassword: oidcOnly ? false : (mustResetPassword ?? false),
            isActive: isActive ?? true,
          },
          select: {
            id: true,
            username: true,
            email: true,
            name: true,
            role: true,
            mustResetPassword: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        // An invitation carries a single-use link, never a password: a mailbox
        // keeps its contents indefinitely.
        let invited = false;
        let invitationError: string | null = null;
        if (sendInvite && !oidcOnly) {
          if (!mailer?.enabled) {
            invitationError = "Email delivery is not configured on this server.";
          } else {
            try {
              const inviteToken = crypto.randomBytes(32).toString("hex");
              const expiresAt = new Date();
              expiresAt.setDate(expiresAt.getDate() + INVITE_VALID_DAYS);
              await prisma.passwordResetToken.create({
                data: {
                  userId: user.id,
                  token: hashTokenForStorage(inviteToken),
                  expiresAt,
                },
              });
              const baseUrl = resolveFrontendBaseUrl();
              const mail = buildUserInviteEmail({
                inviteUrl: `${baseUrl}/reset-password-confirm?token=${inviteToken}`,
                instanceUrl: baseUrl,
                expiresInDays: INVITE_VALID_DAYS,
              });
              const result = await mailer.send({
                to: user.email,
                subject: mail.subject,
                html: mail.html,
                text: mail.text,
                idempotencyKey: `user-invite/${crypto.randomUUID()}`,
              });
              invited = result.delivered;
              if (result.delivered === false) {
                invitationError = `The invitation email was not delivered${result.reason ? `: ${result.reason}` : "."}`;
              }
            } catch (error) {
              console.error(`[mail] Invitation for ${user.email} failed:`, error);
              invitationError = "The invitation could not be prepared or sent.";
            }
          }
          if (invitationError) {
            console.error(
              `[mail] Invitation for ${user.email} was not delivered: ${invitationError}`,
            );
          }
        }
        if (config.enableAuditLogging) {
          await logAuditEvent({
            userId: req.user.id,
            action: "admin_user_created",
            resource: `user:${user.id}`,
            ipAddress: req.ip || req.connection.remoteAddress || undefined,
            userAgent: req.headers["user-agent"] || undefined,
            details: { createdUserId: user.id },
          });
        }
        // The admin needs to know whether they still have to pass credentials on.
        res.status(201).json({
          user,
          invited,
          invitationError,
          // The random password is disclosed only to the creating admin and
          // only when email delivery failed, so the account remains usable.
          temporaryPassword: sendInvite && !invited ? invitePassword : null,
        });
      } catch (error) {
        console.error("Create user error:", error);
        res.status(500).json({
          error: "Internal server error",
          message: "Failed to create user",
        });
      }
    },
  );
  router.patch("/users/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!(await ensureAuthEnabled(res))) return;
      if (!requireCsrf(req, res)) return;
      if (!requireAdmin(req, res)) return;
      const userId = String(req.params.id || "").trim();
      if (!userId) {
        return res.status(400).json({ error: "Bad request", message: "Invalid user id" });
      }
      const parsed = adminUpdateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Bad request", message: "Invalid update payload" });
      }
      if (userId === req.user.id && parsed.data.isActive === false) {
        return res.status(409).json({
          error: "Conflict",
          message: "You cannot deactivate your own account",
        });
      }
      if (userId === req.user.id && parsed.data.role && parsed.data.role !== "ADMIN") {
        return res.status(409).json({
          error: "Conflict",
          message: "You cannot change your own role from ADMIN",
        });
      }
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, isActive: true },
      });
      if (!current) {
        return res.status(404).json({ error: "Not found", message: "User not found" });
      }
      const nextRole = typeof parsed.data.role === "undefined" ? current.role : parsed.data.role;
      const nextActive =
        typeof parsed.data.isActive === "undefined" ? current.isActive : parsed.data.isActive;
      const removingAdmin =
        current.role === "ADMIN" &&
        current.isActive &&
        (nextRole !== "ADMIN" || nextActive === false);
      if (removingAdmin) {
        const admins = await countActiveAdmins();
        if (admins <= 1) {
          return res.status(409).json({
            error: "Conflict",
            message: "There must be at least one active admin",
          });
        }
      }
      const data: Record<string, unknown> = {};
      if (typeof parsed.data.username !== "undefined") data.username = parsed.data.username;
      if (typeof parsed.data.name !== "undefined") data.name = sanitizeText(parsed.data.name, 100);
      if (typeof parsed.data.role !== "undefined") data.role = parsed.data.role;
      if (typeof parsed.data.mustResetPassword !== "undefined")
        data.mustResetPassword = parsed.data.mustResetPassword;
      if (typeof parsed.data.isActive !== "undefined") data.isActive = parsed.data.isActive;
      const updateUser = (tx: Pick<typeof prisma, "user">) =>
        tx.user.update({
          where: { id: userId },
          data,
          select: {
            id: true,
            username: true,
            email: true,
            name: true,
            role: true,
            mustResetPassword: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      let revokedApiKeyIds: string[] = [];
      const canRevokeStoredCredentials =
        typeof prisma.$transaction === "function" &&
        Boolean(prisma.refreshToken) &&
        Boolean(prisma.apiKey);
      const updated =
        current.isActive && nextActive === false && canRevokeStoredCredentials
          ? await prisma.$transaction(async (tx) => {
              const saved = await updateUser(tx);
              revokedApiKeyIds = await revokeUserCredentials(tx, userId, new Date());
              return saved;
            })
          : await updateUser(prisma);
      if (current.isActive && !updated.isActive) {
        // The transaction is the revocation point. Do not acknowledge it
        // until every local user/API-key socket has been disconnected.
        await Promise.all([
          recheckActiveUserSockets(updated.id),
          ...revokedApiKeyIds.map(disconnectApiKeySockets),
        ]);
      }
      if (config.enableAuditLogging) {
        await logAuditEvent({
          userId: req.user.id,
          action: "admin_user_updated",
          resource: `user:${updated.id}`,
          ipAddress: req.ip || req.connection.remoteAddress || undefined,
          userAgent: req.headers["user-agent"] || undefined,
          details: { updatedUserId: updated.id, fields: Object.keys(data) },
        });
      }
      res.json({ user: updated });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return res.status(409).json({
          error: "Conflict",
          message: "User with this username already exists",
        });
      }
      console.error("Update user error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to update user",
      });
    }
  });

  registerAdminUserOffboardingRoutes(deps);
  registerAdminUserPasswordRoutes(deps);
};
