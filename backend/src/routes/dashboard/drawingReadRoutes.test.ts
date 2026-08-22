import express from "express";
import { describe, expect, it, vi } from "vitest";
import { registerDrawingReadRoutes } from "./drawingReadRoutes";

const invoke = async (app: express.Express, principal: any) => {
  const layer = (app as any).router.stack.find(
    (candidate: any) => candidate.route?.path === "/drawings/:id" && candidate.route.methods.get,
  );
  const req: any = {
    params: { id: "drawing-1" },
    body: {},
    query: {},
    headers: {},
    connection: {},
  };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  (app as any).__principal = principal;
  for (const handlerLayer of layer.route.stack) {
    await handlerLayer.handle(req, res, () => undefined);
  }
  return res;
};

// The row a future migration produces: everything the route knows about, plus a
// column nobody has taught it to hide yet. `secretRecoveryToken` stands in for
// the next `userId` — the one that has not been added to the table yet.
const rowWithAnUnknownColumn = {
  id: "drawing-1",
  name: "Board",
  elements: "[]",
  appState: "{}",
  files: "{}",
  preview: null,
  version: 3,
  userId: "account-1",
  createdByUserId: "account-2",
  collectionId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  createdBy: { name: "Drawer" },
  secretRecoveryToken: "a-column-added-after-this-route-was-written",
};

// `grantee` gets an explicit `view` share so the non-owner case reaches the
// projection instead of stopping at the access check.
const buildApp = ({ grantee }: { grantee?: string } = {}) => {
  const prisma: any = {
    user: { findUnique: vi.fn().mockResolvedValue({ isActive: true }) },
    drawing: { findUnique: vi.fn().mockResolvedValue(rowWithAnUnknownColumn) },
    drawingPermission: {
      findUnique: vi.fn(async ({ where }: any) =>
        where?.drawingId_granteeUserId?.granteeUserId === grantee ? { permission: "view" } : null,
      ),
    },
    drawingLinkShare: { findFirst: vi.fn().mockResolvedValue(null) },
    collection: { findFirst: vi.fn().mockResolvedValue(null) },
    collectionShare: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const app = express();
  registerDrawingReadRoutes(app, {
    prisma,
    optionalAuth: (req: any, _res: any, next: any) => next(),
    asyncHandler: (handler: any) => async (req: any, res: any, next: any) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        next(error);
      }
    },
    parseJsonField: (_value: unknown, fallback: unknown) => fallback,
    getRequestPrincipal: async () => (app as any).__principal,
    getShareToken: () => null,
    respondWithAuthErrorIfPresent: () => false,
  } as any);
  return app;
};

describe("drawing read projection", () => {
  // A whitelist is only worth the name if an unknown column cannot ride along.
  // Rewrite the handler to spread the row (`...row`) and this fails: the extra
  // column lands in the response untouched.
  it("does not hand out a column the route was never taught about", async () => {
    const owner = await invoke(buildApp(), { kind: "user", userId: "account-1" });

    expect(owner.statusCode).toBe(200);
    expect(owner.payload).not.toHaveProperty("secretRecoveryToken");
    expect(owner.payload).not.toHaveProperty("createdByUserId");
  });

  it("answers with exactly the fields it means to answer with", async () => {
    const owner = await invoke(buildApp(), { kind: "user", userId: "account-1" });

    expect(Object.keys(owner.payload).sort()).toEqual(
      [
        "accessLevel",
        "appState",
        "collectionId",
        "createdAt",
        "creatorName",
        "elements",
        "files",
        "id",
        "name",
        "preview",
        "updatedAt",
        "userId",
        "version",
      ].sort(),
    );
  });

  it("still keeps the owner's account id from anyone who is not the owner", async () => {
    const stranger = await invoke(buildApp({ grantee: "account-9" }), {
      kind: "user",
      userId: "account-9",
    });

    expect(stranger.payload).not.toHaveProperty("userId");
    expect(stranger.payload).not.toHaveProperty("secretRecoveryToken");
    // The name of whoever drew it stays — that is the part worth showing.
    expect(stranger.payload.creatorName).toBe("Drawer");
  });
});
