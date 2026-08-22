import type { Server, Socket } from "socket.io";
import { parseDrawingId } from "./socketProtocol";
import { registerAuthorizedRoomEvent, type RoomEventPayload } from "./socketRoomEvent";

export const WORKSHOP_TIMER_EVENT = "workshop-timer-update";
export const WORKSHOP_TIMER_COMMAND_EVENT = "workshop-timer-command";
const WORKSHOP_TIMER_LIMITS = {
  commandsPerMinute: 12,
  minDurationMs: 1_000,
  maxDurationMs: 24 * 60 * 60 * 1_000,
  extensionMs: 60_000,
} as const;

export type WorkshopTimerStatus = "idle" | "running" | "paused" | "finished";
export type WorkshopTimerSnapshot = {
  drawingId: string;
  status: WorkshopTimerStatus;
  endsAt: number | null;
  remainingMs: number;
  serverNow: number;
};

type TimerState =
  | { status: "running"; endsAt: number; timeout: ReturnType<typeof setTimeout> }
  | { status: "paused"; remainingMs: number }
  | { status: "finished" };

export type WorkshopTimerAction = "start" | "pause" | "resume" | "stop" | "add-minute";
export type WorkshopTimerCommand = RoomEventPayload & {
  action: WorkshopTimerAction;
  durationMs?: number;
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

const parseWorkshopTimerCommand = (value: unknown): WorkshopTimerCommand | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  if (!drawingId) return null;
  if (data.action === "start") {
    const durationMs = data.durationMs;
    if (
      typeof durationMs !== "number" ||
      !Number.isInteger(durationMs) ||
      durationMs < WORKSHOP_TIMER_LIMITS.minDurationMs ||
      durationMs > WORKSHOP_TIMER_LIMITS.maxDurationMs
    ) {
      return null;
    }
    return { drawingId, action: "start", durationMs };
  }
  if (
    data.action === "pause" ||
    data.action === "resume" ||
    data.action === "stop" ||
    data.action === "add-minute"
  ) {
    return { drawingId, action: data.action };
  }
  return null;
};

export const createWorkshopTimerManager = ({
  io,
  now = Date.now,
}: {
  io: Pick<Server, "to">;
  now?: () => number;
}) => {
  const states = new Map<string, TimerState>();

  const snapshot = (drawingId: string): WorkshopTimerSnapshot => {
    const serverNow = now();
    const state = states.get(drawingId);
    if (!state) return { drawingId, status: "idle", endsAt: null, remainingMs: 0, serverNow };
    if (state.status === "running") {
      return {
        drawingId,
        status: "running",
        endsAt: state.endsAt,
        remainingMs: Math.max(0, state.endsAt - serverNow),
        serverNow,
      };
    }
    if (state.status === "paused") {
      return {
        drawingId,
        status: "paused",
        endsAt: null,
        remainingMs: state.remainingMs,
        serverNow,
      };
    }
    return { drawingId, status: "finished", endsAt: null, remainingMs: 0, serverNow };
  };

  const emit = (drawingId: string) => {
    io.to(roomName(drawingId)).emit(WORKSHOP_TIMER_EVENT, snapshot(drawingId));
  };

  const clearScheduledFinish = (state: TimerState | undefined) => {
    if (state?.status === "running") clearTimeout(state.timeout);
  };

  const finish = (drawingId: string, expectedEndsAt: number) => {
    const current = states.get(drawingId);
    if (current?.status !== "running" || current.endsAt !== expectedEndsAt) return;
    states.set(drawingId, { status: "finished" });
    emit(drawingId);
  };

  const scheduleRunning = (drawingId: string, endsAt: number) => {
    clearScheduledFinish(states.get(drawingId));
    const timeout = setTimeout(() => finish(drawingId, endsAt), Math.max(0, endsAt - now()));
    states.set(drawingId, { status: "running", endsAt, timeout });
  };

  const command = (payload: WorkshopTimerCommand) => {
    const current = states.get(payload.drawingId);
    const serverNow = now();
    if (payload.action === "start" && payload.durationMs !== undefined) {
      scheduleRunning(payload.drawingId, serverNow + payload.durationMs);
    } else if (payload.action === "pause" && current?.status === "running") {
      clearScheduledFinish(current);
      const remainingMs = Math.max(0, current.endsAt - serverNow);
      states.set(
        payload.drawingId,
        remainingMs > 0 ? { status: "paused", remainingMs } : { status: "finished" },
      );
    } else if (payload.action === "resume" && current?.status === "paused") {
      scheduleRunning(payload.drawingId, serverNow + current.remainingMs);
    } else if (payload.action === "stop") {
      clearScheduledFinish(current);
      states.delete(payload.drawingId);
    } else if (payload.action === "add-minute" && current?.status === "running") {
      const remainingMs = Math.min(
        WORKSHOP_TIMER_LIMITS.maxDurationMs,
        Math.max(0, current.endsAt - serverNow) + WORKSHOP_TIMER_LIMITS.extensionMs,
      );
      scheduleRunning(payload.drawingId, serverNow + remainingMs);
    } else if (payload.action === "add-minute" && current?.status === "paused") {
      states.set(payload.drawingId, {
        status: "paused",
        remainingMs: Math.min(
          WORKSHOP_TIMER_LIMITS.maxDurationMs,
          current.remainingMs + WORKSHOP_TIMER_LIMITS.extensionMs,
        ),
      });
    } else {
      return;
    }
    emit(payload.drawingId);
  };

  const clear = (drawingId: string) => {
    clearScheduledFinish(states.get(drawingId));
    states.delete(drawingId);
  };

  return { clear, command, snapshot };
};

export type WorkshopTimerManager = ReturnType<typeof createWorkshopTimerManager>;

export const registerWorkshopTimerRoomEvent = ({
  socket,
  timers,
  requireAccess,
}: {
  socket: Socket;
  timers: WorkshopTimerManager;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
}): void => {
  registerAuthorizedRoomEvent({
    socket,
    event: WORKSHOP_TIMER_COMMAND_EVENT,
    limit: WORKSHOP_TIMER_LIMITS.commandsPerMinute,
    windowMs: 60_000,
    parse: parseWorkshopTimerCommand,
    requireAccess,
    requireEdit: true,
    handle: timers.command,
  });
};
