import { randomUUID } from "crypto";
import type { Socket } from "socket.io";
import type { PresenceEntry } from "./presenceRegistry";
import { parseDrawingId, parseSceneBounds, type SceneBounds } from "./socketProtocol";
import { registerAuthorizedRoomEvent, type RoomEventPayload } from "./socketRoomEvent";

const INVITE_HERE_LIMITS = {
  durationMs: 15_000,
  cooldownMs: 5_000,
  responseEventsPerWindow: 4,
} as const;

type InviteRequest = RoomEventPayload & { sceneBounds: SceneBounds };
type InviteResponse = RoomEventPayload & {
  invitationId: string;
  decision: "accepted" | "declined";
};

type ActiveInvitation = {
  invitationId: string;
  drawingId: string;
  inviterPresenceId: string;
  expiresAt: number;
  arrivedPersonKeys: Set<string>;
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

const parseInviteHereRequest = (value: unknown): InviteRequest | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  const sceneBounds = parseSceneBounds(data.sceneBounds);
  return drawingId && sceneBounds ? { drawingId, sceneBounds } : null;
};

const parseInviteHereResponse = (value: unknown): InviteResponse | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  const invitationId =
    typeof data.invitationId === "string" && data.invitationId.length <= 100
      ? data.invitationId
      : null;
  const decision =
    data.decision === "accepted" || data.decision === "declined" ? data.decision : null;
  return drawingId && invitationId && decision ? { drawingId, invitationId, decision } : null;
};

export const createSocketInviteHereManager = ({
  connectedSockets,
  getPresence,
  requireAccess,
}: {
  connectedSockets: Map<string, Socket>;
  getPresence: (socketId: string) => PresenceEntry | null;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
}) => {
  const activeByDrawing = new Map<string, ActiveInvitation>();

  const emitStatus = (invitation: ActiveInvitation) => {
    connectedSockets.get(invitation.inviterPresenceId)?.emit("invite-here-status", {
      drawingId: invitation.drawingId,
      invitationId: invitation.invitationId,
      expiresAt: invitation.expiresAt,
      arrivedCount: invitation.arrivedPersonKeys.size,
    });
  };

  const registerHandlers = (socket: Socket) => {
    registerAuthorizedRoomEvent({
      socket,
      event: "invite-here",
      limit: 1,
      windowMs: INVITE_HERE_LIMITS.cooldownMs,
      parse: parseInviteHereRequest,
      requireAccess,
      requireEdit: true,
      handle: (payload) => {
        const inviter = getPresence(socket.id);
        if (!inviter) return;
        const invitation: ActiveInvitation = {
          invitationId: randomUUID(),
          drawingId: payload.drawingId,
          inviterPresenceId: socket.id,
          expiresAt: Date.now() + INVITE_HERE_LIMITS.durationMs,
          arrivedPersonKeys: new Set(),
        };
        activeByDrawing.set(payload.drawingId, invitation);
        emitStatus(invitation);
        socket.to(roomName(payload.drawingId)).emit("invite-here", {
          drawingId: payload.drawingId,
          invitationId: invitation.invitationId,
          inviterName: inviter.name,
          sceneBounds: payload.sceneBounds,
          expiresAt: invitation.expiresAt,
        });
      },
    });

    registerAuthorizedRoomEvent({
      socket,
      event: "invite-here-response",
      limit: INVITE_HERE_LIMITS.responseEventsPerWindow,
      windowMs: INVITE_HERE_LIMITS.durationMs,
      parse: parseInviteHereResponse,
      requireAccess,
      handle: (payload) => {
        const invitation = activeByDrawing.get(payload.drawingId);
        if (!invitation || invitation.invitationId !== payload.invitationId) return;
        if (Date.now() >= invitation.expiresAt) {
          activeByDrawing.delete(payload.drawingId);
          return;
        }
        if (payload.decision !== "accepted" || invitation.inviterPresenceId === socket.id) return;
        const presence = getPresence(socket.id);
        if (!presence) return;
        // Accounts are people across tabs. Anonymous visitors have no honest
        // person identifier, so only repeat responses from one socket collapse.
        const personKey = presence.accountId
          ? `account:${presence.accountId}`
          : `presence:${presence.presenceId}`;
        if (invitation.arrivedPersonKeys.has(personKey)) return;
        invitation.arrivedPersonKeys.add(personKey);
        emitStatus(invitation);
      },
    });
  };

  return {
    registerHandlers,
    clearSocket(socketId: string, drawingId: string) {
      const invitation = activeByDrawing.get(drawingId);
      if (invitation?.inviterPresenceId === socketId) activeByDrawing.delete(drawingId);
    },
  };
};
