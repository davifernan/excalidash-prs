import type { Server, Socket } from "socket.io";
import type { PrismaClient } from "../generated/client";
import type { AuthModeService } from "../auth/authMode";
import {
  canEditDrawing,
  canViewDrawing,
  getDrawingAccess,
  parseShareLinkToken,
  type DrawingPrincipal,
} from "../authz/sharing";
import { createSocketAuthenticator } from "./socketAuth";
import {
  createCollaborationAccessController,
  type CollaborationAccessController,
} from "./collaborationAccess";
import { createSocketFollowManager } from "./socketFollow";
import {
  createApiKeySocketRevoker,
  registerApiKeySocketRevoker,
  registerUserSocketRechecker,
} from "./socketRevocation";
import { DRAWINGS_READ_SCOPE, DRAWINGS_WRITE_SCOPE } from "../auth/apiKeys";
import { startNonOverlappingSocketAccessSweep } from "./socketAccessSweep";
import { createSocketCredentialGuard } from "./socketCredentials";
import {
  derivePresenceColor,
  deriveGuestName,
  toPresenceColor,
  toPresenceInitials,
  toPresenceName,
} from "./socketPresence";
import {
  PresenceRegistry,
  toPublicPresence,
  type PresenceEntry,
  type PresenceKind,
} from "./presenceRegistry";
import {
  createKeyedByteLimiter,
  createKeyedRateLimiter,
  createRateLimiter,
  parseDrawingId,
  ELEMENT_UPDATE_TRAFFIC_LIMITS,
  type ElementUpdateTrafficLimits,
  SOCKET_LIMITS,
  SOCKET_QUEUE_LIMITS,
} from "./socketProtocol";
import { ActiveAccountCache } from "./activeAccountCache";
import { getDrawingMembership } from "../authz/membership";
import { ipKeyGenerator } from "express-rate-limit";
import { resolveSocketClientAddress, type TrustProxySetting } from "./socketClientAddress";
import { registerCoreRoomEvents } from "./socketCoreRoomEvents";
import {
  registerSelectionRoomEvent,
  SELECTION_LIMITS,
  SELECTION_SNAPSHOT_EVENT,
} from "./socketSelection";
import { registerCursorChatRoomEvent, CURSOR_CHAT_LIMITS } from "./socketCursorChat";
import { createWorkshopTimerManager, registerWorkshopTimerRoomEvent } from "./socketWorkshopTimer";
import {
  createDocumentPageManager,
  DOCUMENT_PAGE_EVENT,
  registerDocumentPageRoomEvent,
} from "./socketDocumentPages";
import { createSocketInviteHereManager } from "./socketInviteHere";
import { createRoomEventFeedback, type RoomEventAck } from "./socketRoomEvent";

type RegisterSocketHandlersDeps = {
  io: Server;
  prisma: PrismaClient;
  authModeService: AuthModeService;
  jwtSecret: string;
  accessRecheckIntervalMs?: number;
  /** Shared with the HTTP side so the dashboard can read presence too. */
  presences?: PresenceRegistry;
  elementUpdateTrafficLimits?: ElementUpdateTrafficLimits;
  /**
   * The same setting the HTTP side uses. Without it every socket behind a
   * reverse proxy reports the proxy's address -- and shares one budget.
   */
  trustProxy?: TrustProxySetting;
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

export const registerSocketHandlers = ({
  io,
  prisma,
  authModeService,
  jwtSecret,
  accessRecheckIntervalMs = 5_000,
  presences = new PresenceRegistry(),
  elementUpdateTrafficLimits = ELEMENT_UPDATE_TRAFFIC_LIMITS,
  trustProxy = false,
}: RegisterSocketHandlersDeps): CollaborationAccessController => {
  const principals = new Map<string, DrawingPrincipal>();
  const connectedSockets = new Map<string, Socket>();
  const credentialChecks = new Map<string, Promise<boolean>>();
  const drawingBySocket = new Map<string, string>();
  // Keyed by who, not by which connection: a per-socket budget for activity
  // pings resets on reconnect, and reconnecting is free.
  // Budgets that outlive a connection. Everything a client can repeat by
  // opening another tab belongs here: the tab is free, the budget must not be.
  // Joining and following stay per connection on purpose -- those refuse
  // somebody outright, and an office behind one address is one actor here.
  const allowActivity = createKeyedRateLimiter(20, 10_000);
  // Four times the per-connection allowance: two tabs and a phone are normal,
  // fifty connections are not, and the point is to stop the budget growing with
  // them rather than to punish a second window.
  const allowCursorMove = createKeyedRateLimiter(40 * 4, 1_000);
  const allowElementUpdateEvents = createKeyedRateLimiter(120 * 4, 1_000);
  // The old two 10k-key maps allowed 20k live buckets total. Actor+board keys
  // multiply faster, so four 5k-key maps retain that same 20k worst case; each
  // map purges expired windows and refuses new keys rather than evicting a live
  // bucket that an attacker could then recreate with a reset budget.
  const elementBudgetMaxKeys = 5_000;
  const allowAccountBoardElementBytes = createKeyedByteLimiter(
    elementUpdateTrafficLimits.accountBytesPerWindow,
    elementUpdateTrafficLimits.windowMs,
    elementBudgetMaxKeys,
  );
  const allowAnonymousBoardElementBytes = createKeyedByteLimiter(
    elementUpdateTrafficLimits.anonymousBytesPerWindow,
    elementUpdateTrafficLimits.windowMs,
    elementBudgetMaxKeys,
  );
  const allowAccountActorElementBytes = createKeyedByteLimiter(
    elementUpdateTrafficLimits.accountActorBytesPerWindow,
    elementUpdateTrafficLimits.windowMs,
    elementBudgetMaxKeys,
  );
  const allowAnonymousActorElementBytes = createKeyedByteLimiter(
    elementUpdateTrafficLimits.anonymousActorBytesPerWindow,
    elementUpdateTrafficLimits.windowMs,
    elementBudgetMaxKeys,
  );

  const allowSelection = createKeyedRateLimiter(SELECTION_LIMITS.eventsPerSecond * 4, 1_000);
  const allowCursorChat = createKeyedRateLimiter(CURSOR_CHAT_LIMITS.eventsPerSecond * 4, 1_000);
  const shareTokenBySocket = new Map<string, string>();
  const workshopTimers = createWorkshopTimerManager({ io });
  const documentPages = createDocumentPageManager({ io, prisma });
  let followManager: ReturnType<typeof createSocketFollowManager>;
  let inviteHereManager: ReturnType<typeof createSocketInviteHereManager>;
  const activeAccounts = new ActiveAccountCache(async (userId) => {
    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { isActive: true },
    });
    return Boolean(account?.isActive);
  });

  io.use(createSocketAuthenticator({ prisma, authModeService, jwtSecret, principals }));

  const emitPresence = (drawingId: string) => {
    const apiKeySocketIds = Array.from(drawingBySocket.entries())
      .filter(
        ([socketId, currentDrawingId]) =>
          currentDrawingId === drawingId && Boolean(principals.get(socketId)?.apiKey),
      )
      .map(([socketId]) => socketId);
    // Every Socket.IO connection already owns a private room named after its
    // socket id. Excluding those rooms preserves the one collaboration-room
    // lifecycle used by drawing updates and avoids a second presence-only room
    // that every join, leave, board switch, revoke, and disconnect must maintain.
    const recipients = apiKeySocketIds.length
      ? io.to(roomName(drawingId)).except(apiKeySocketIds)
      : io.to(roomName(drawingId));
    recipients.emit("presence-update", presences.listPublic(drawingId));
  };

  const getPresence = (socketId: string): PresenceEntry | null => {
    const drawingId = drawingBySocket.get(socketId);
    return drawingId ? presences.get(drawingId, socketId) : null;
  };

  const removeFromDrawing = async (socket: Socket, reason: string, leaveSocketRoom = true) => {
    const drawingId = drawingBySocket.get(socket.id);
    shareTokenBySocket.delete(socket.id);
    if (!drawingId) return;
    followManager.clearSocket(socket.id, reason);
    inviteHereManager.clearSocket(socket.id, drawingId);
    drawingBySocket.delete(socket.id);
    presences.leave(drawingId, socket.id);
    if (presences.list(drawingId).length === 0) workshopTimers.clear(drawingId);
    if (leaveSocketRoom) await socket.leave(roomName(drawingId));
    emitPresence(drawingId);
  };

  const getAccess = (socketId: string, drawingId: string, shareToken?: string | null) =>
    getDrawingAccess({
      prisma,
      principal: principals.get(socketId) || null,
      drawingId,
      isUserActive: (userId) => activeAccounts.get(userId),
      shareToken: shareToken === undefined ? shareTokenBySocket.get(socketId) : shareToken,
    });

  const apiKeyHasScope = (socketId: string, scope: string) => {
    const apiKey = principals.get(socketId)?.apiKey;
    return !apiKey || apiKey.scopes.includes(scope);
  };

  const canSocketView = (socketId: string, access: Awaited<ReturnType<typeof getAccess>>) =>
    canViewDrawing(access) && apiKeyHasScope(socketId, DRAWINGS_READ_SCOPE);

  const canSocketEdit = (socketId: string, access: Awaited<ReturnType<typeof getAccess>>) =>
    canEditDrawing(access) && apiKeyHasScope(socketId, DRAWINGS_WRITE_SCOPE);

  const requireAccess = async (socket: Socket, drawingId: string, requireEdit = false) => {
    if (drawingBySocket.get(socket.id) !== drawingId || !socket.rooms.has(roomName(drawingId))) {
      return null;
    }
    if (!(await credentialChecks.get(socket.id))) return null;
    const access = await getAccess(socket.id, drawingId);
    if (
      connectedSockets.get(socket.id) !== socket ||
      drawingBySocket.get(socket.id) !== drawingId ||
      !socket.rooms.has(roomName(drawingId))
    ) {
      return null;
    }
    if (!canSocketView(socket.id, access)) {
      await removeFromDrawing(socket, "access-revoked");
      socket.emit("error", { message: "You do not have access to this drawing" });
      return null;
    }
    if (requireEdit && !canSocketEdit(socket.id, access)) {
      socket.emit("error", { message: "Read-only access: cannot edit this drawing" });
      return null;
    }
    return access;
  };

  followManager = createSocketFollowManager({
    io,
    connectedSockets,
    drawingBySocket,
    getPresence,
    getAccess,
    requireAccess: (socket, drawingId) => requireAccess(socket, drawingId),
    removeFromDrawing: (socket, reason) => removeFromDrawing(socket, reason),
  });
  inviteHereManager = createSocketInviteHereManager({
    connectedSockets,
    getPresence,
    requireAccess,
  });

  const disconnectApiKey = createApiKeySocketRevoker({
    connectedSockets,
    principals,
    removeFromDrawing,
  });
  const credentialGuard = createSocketCredentialGuard({
    prisma,
    connectedSockets,
    principals,
    removeFromDrawing,
    disconnectApiKey,
  });

  io.on("connection", (socket) => {
    // Registration precedes the final credential read. A concurrent revoke
    // must therefore either find this socket in the map or win the final read;
    // there is no gap in which both mechanisms can miss it.
    connectedSockets.set(socket.id, socket);
    const credentialCheck = credentialGuard.verifyRegisteredSocket(socket);
    credentialChecks.set(socket.id, credentialCheck);
    let joinRevision = 0;
    let joinQueue = Promise.resolve();
    let pendingJoins = 0;
    // Who a shared budget belongs to. An account is itself; anyone else is
    // their address, normalised the way the HTTP limiter does it -- a raw
    // address hands anyone with an IPv6 range a fresh budget per connection.
    const actorKey = () => {
      const principal = principals.get(socket.id);
      return principal && !principal.allowInactive
        ? `account:${principal.userId}`
        : // Resolved the way Express resolves req.ip. Behind a proxy the raw
          // handshake address is the proxy for everyone, which would hand every
          // anonymous visitor one shared budget.
          `address:${ipKeyGenerator(resolveSocketClientAddress(socket.handshake, trustProxy)) || "unknown"}`;
    };
    const allowJoin = createRateLimiter(10, 60_000);
    const leaveRoomFeedback = createRoomEventFeedback(socket, "leave-room", 60_000);
    const allowFollow = createRateLimiter(12, 60_000);
    const allowViewport = createRateLimiter(30, 1_000);
    // Unfollowing has its own budget: it returns before the shared seam so it
    // can still overtake a slow follow and cancel it, which means it would
    // otherwise be the one room event with no limit at all.
    const allowUnfollow = createRateLimiter(12, 60_000);
    followManager.registerHandlers(socket, allowFollow, allowViewport, allowUnfollow);
    registerCoreRoomEvents({
      socket,
      getPresence,
      requireAccess,
      setActive: (drawingId, presenceId, active) =>
        presences.setActive(drawingId, presenceId, active),
      emitPresence,
      allowActivity: () => allowActivity(actorKey()),
      allowCursorMove: () => allowCursorMove(actorKey()),
      allowElementUpdate: (drawingId, serializedBytes) => {
        const key = actorKey();
        if (!allowElementUpdateEvents(key)) return false;
        // Rate is not the only unit that matters: 120 small updates a second
        // are harmless and 120 large ones are not. Budgets are per actor and
        // board, with an overall cap so that opening more boards cannot buy
        // unlimited throughput.
        const boardKey = JSON.stringify([key, drawingId]);
        if (key.startsWith("account:")) {
          return (
            allowAccountBoardElementBytes(boardKey, serializedBytes) &&
            allowAccountActorElementBytes(key, serializedBytes)
          );
        }
        if (serializedBytes > SOCKET_LIMITS.anonymousElementUpdateBytes) return false;
        return (
          allowAnonymousBoardElementBytes(boardKey, serializedBytes) &&
          allowAnonymousActorElementBytes(key, serializedBytes)
        );
      },
    });
    registerSelectionRoomEvent({
      socket,
      presences,
      requireAccess,
      allow: () => allowSelection(actorKey()),
    });
    registerCursorChatRoomEvent({
      socket,
      requireAccess,
      allow: () => allowCursorChat(actorKey()),
    });
    registerWorkshopTimerRoomEvent({ socket, timers: workshopTimers, requireAccess });
    registerDocumentPageRoomEvent({ socket, pages: documentPages, requireAccess });
    inviteHereManager.registerHandlers(socket);

    socket.on("join-room", (data: unknown, ack?: (value: unknown) => void) => {
      const rejectJoin = (code: string, message: string) => {
        const error = { code, message };
        socket.emit("error", error);
        ack?.({ ok: false, error });
      };
      if (!allowJoin()) {
        rejectJoin("rate-limited", "Join room rate limit exceeded");
        return;
      }
      if (!data || typeof data !== "object") {
        rejectJoin("invalid-request", "Invalid join room request");
        return;
      }
      const payload = data as Record<string, unknown>;
      const drawingId = parseDrawingId(payload.drawingId);
      const shareToken = parseShareLinkToken(payload.shareToken);
      if (!drawingId) {
        rejectJoin("invalid-request", "Invalid drawing id");
        return;
      }
      if (pendingJoins >= SOCKET_QUEUE_LIMITS.joins) {
        rejectJoin("queue-full", "Too many pending join room requests");
        return;
      }
      pendingJoins += 1;
      const revision = ++joinRevision;
      const run = async () => {
        const isCurrentJoin = () =>
          connectedSockets.get(socket.id) === socket && revision === joinRevision;

        if (!(await credentialCheck) || !isCurrentJoin()) {
          ack?.({
            ok: false,
            error: {
              code: "authentication-failed",
              message: "Authentication failed",
            },
          });
          return;
        }
        const access = await getAccess(socket.id, drawingId, shareToken);
        if (!isCurrentJoin()) return;
        if (!canSocketView(socket.id, access)) {
          socket.emit("error", { message: "You do not have access to this drawing" });
          ack?.({
            ok: false,
            error: {
              code: "access-denied",
              message: "You do not have access to this drawing",
            },
          });
          return;
        }
        const previousDrawingId = drawingBySocket.get(socket.id);
        if (previousDrawingId && previousDrawingId !== drawingId) {
          await removeFromDrawing(socket, "board-changed");
          if (!isCurrentJoin()) return;
        }
        const clientUser =
          payload.user && typeof payload.user === "object"
            ? (payload.user as Record<string, unknown>)
            : {};
        const principal = principals.get(socket.id) || null;
        // Auth switched off gives every visitor the same standing identity,
        // which is another way of saying nobody has one. That is the only case
        // where the browser's own name and colour are all anyone has -- and it
        // is told apart by allowInactive, which the authenticator sets for
        // exactly that principal. The bootstrap *id* is no signal: once auth is
        // on, it belongs to a real administrator with a real name.
        const isSharedBootstrapIdentity = principal?.allowInactive === true;
        const isAccount = Boolean(principal?.userId) && !isSharedBootstrapIdentity;
        let name = toPresenceName(clientUser.name);
        let color = derivePresenceColor(socket.id);
        let kind: PresenceKind = "guest";
        const membershipLevel =
          isAccount && principal
            ? access === "owner"
              ? "owner"
              : (await getDrawingMembership({ prisma, userId: principal.userId, drawingId }))?.level
            : null;
        if (!isCurrentJoin()) return;
        if (membershipLevel && principal) {
          // A standing membership has a name the server can check. An account
          // arriving only through a link is still a guest, so the server gives
          // it a per-connection guest identity instead of exposing its account.
          const account = await prisma.user.findUnique({
            where: { id: principal.userId },
            select: { name: true },
          });
          if (!isCurrentJoin()) return;
          if (account) name = toPresenceName(account.name);
          color = derivePresenceColor(principal.userId);
          kind = membershipLevel === "owner" ? "owner" : "member";
        } else if (isSharedBootstrapIdentity) {
          color = toPresenceColor(clientUser.color);
        } else {
          name = deriveGuestName(socket.id);
        }
        await socket.join(roomName(drawingId));
        if (!isCurrentJoin()) {
          await socket.leave(roomName(drawingId));
          return;
        }
        const presence: PresenceEntry = {
          presenceId: socket.id,
          accountId: principal?.userId || null,
          name,
          initials: toPresenceInitials(name),
          color,
          kind,
          isActive: true,
          selectedElementIds: {},
          allSelected: false,
        };
        drawingBySocket.set(socket.id, drawingId);
        if (shareToken) shareTokenBySocket.set(socket.id, shareToken);
        else shareTokenBySocket.delete(socket.id);
        presences.join(drawingId, presence);
        emitPresence(drawingId);
        socket.emit(SELECTION_SNAPSHOT_EVENT, presences.selectionSnapshot(drawingId));
        socket.emit("workshop-timer-update", workshopTimers.snapshot(drawingId));
        // Somebody arriving mid-meeting should see the page the room is on,
        // not page one. Sent only to this socket; nobody else has to repaint.
        documentPages
          .snapshot(drawingId)
          .then((pages) => socket.emit(DOCUMENT_PAGE_EVENT, pages))
          .catch((error) => {
            console.error("Document page snapshot failed while joining a board:", error);
          });
        followManager.invalidateAccess(socket.id);
        ack?.({ ok: true, presence: toPublicPresence(presence) });
      };
      const result = joinQueue.then(run, run);
      joinQueue = result.then(
        () => {
          pendingJoins -= 1;
        },
        () => {
          pendingJoins -= 1;
        },
      );
      return result;
    });

    socket.on("leave-room", async (data: unknown, ack?: RoomEventAck) => {
      joinRevision += 1;
      if (!allowJoin()) {
        leaveRoomFeedback.rateLimited();
        return;
      }
      const drawingId =
        data && typeof data === "object"
          ? parseDrawingId((data as Record<string, unknown>).drawingId)
          : null;
      if (!drawingId) {
        leaveRoomFeedback.invalid(ack);
        return;
      }
      if (drawingId && drawingBySocket.get(socket.id) === drawingId) {
        await removeFromDrawing(socket, "left-room");
      }
      leaveRoomFeedback.succeeded(ack);
    });

    socket.on("disconnect", async () => {
      joinRevision += 1;
      connectedSockets.delete(socket.id);
      credentialChecks.delete(socket.id);
      shareTokenBySocket.delete(socket.id);
      await removeFromDrawing(socket, "disconnected", false);
      principals.delete(socket.id);
    });
  });

  const recheckSockets = async (matches: (socketId: string, drawingId: string) => boolean) => {
    const candidates = Array.from(connectedSockets.values()).filter((socket) => {
      const drawingId = drawingBySocket.get(socket.id);
      return Boolean(drawingId && matches(socket.id, drawingId));
    });
    await Promise.all(
      candidates.map(async (socket) => {
        const drawingId = drawingBySocket.get(socket.id);
        if (!drawingId) return;
        followManager.invalidateAccess(socket.id);
        const access = await getAccess(socket.id, drawingId);
        if (
          !canSocketView(socket.id, access) &&
          connectedSockets.get(socket.id) === socket &&
          drawingBySocket.get(socket.id) === drawingId
        ) {
          await removeFromDrawing(socket, "access-revoked");
          socket.emit("error", {
            message: "You do not have access to this drawing",
          });
        }
      }),
    );
  };

  const controller = createCollaborationAccessController({
    prisma,
    principals,
    recheckSockets,
    disconnectInactiveUserSockets: credentialGuard.disconnectInactiveUserSockets,
    disconnectApiKey,
    invalidateUserStatus: (userId) => activeAccounts.invalidate(userId),
  });

  registerApiKeySocketRevoker(disconnectApiKey);
  registerUserSocketRechecker(controller.recheckUserAccess);
  // Expiring link shares have no route invocation at expiry time. A periodic
  // server-side sweep bounds passive clients' access even if they send nothing.
  startNonOverlappingSocketAccessSweep(() => recheckSockets(() => true), accessRecheckIntervalMs);

  return controller;
};
