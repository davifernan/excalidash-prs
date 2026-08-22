import type { Socket } from "socket.io-client";

const WORKSHOP_TIMER_EVENT = "workshop-timer-update";
export const WORKSHOP_TIMER_COMMAND_EVENT = "workshop-timer-command";

export type WorkshopTimerStatus = "idle" | "running" | "paused" | "finished";
export type WorkshopTimerAction = "start" | "pause" | "resume" | "stop" | "add-minute";

export type SyncedWorkshopTimerSnapshot = {
  drawingId: string;
  status: WorkshopTimerStatus;
  endsAt: number | null;
  remainingMs: number;
  serverNow: number;
  serverClockOffsetMs: number;
};

export type WorkshopTimerController = {
  snapshot: SyncedWorkshopTimerSnapshot;
  sendCommand: (action: WorkshopTimerAction, durationMs?: number) => void;
};

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export const createIdleWorkshopTimerSnapshot = (
  drawingId: string,
  clientNow = Date.now(),
): SyncedWorkshopTimerSnapshot => ({
  drawingId,
  status: "idle",
  endsAt: null,
  remainingMs: 0,
  serverNow: clientNow,
  serverClockOffsetMs: 0,
});

export const parseWorkshopTimerSnapshot = (
  value: unknown,
  drawingId: string,
  clientReceivedAt = Date.now(),
): SyncedWorkshopTimerSnapshot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.drawingId !== drawingId || !isFiniteTimestamp(data.serverNow)) return null;
  if (
    data.status !== "idle" &&
    data.status !== "running" &&
    data.status !== "paused" &&
    data.status !== "finished"
  ) {
    return null;
  }
  const running = data.status === "running";
  if (running ? !isFiniteTimestamp(data.endsAt) : data.endsAt !== null) return null;
  if (!isFiniteTimestamp(data.remainingMs)) return null;
  return {
    drawingId,
    status: data.status,
    endsAt: running ? (data.endsAt as number) : null,
    remainingMs: data.remainingMs,
    serverNow: data.serverNow,
    serverClockOffsetMs: data.serverNow - clientReceivedAt,
  };
};

export const getWorkshopTimerRemainingMs = (
  snapshot: SyncedWorkshopTimerSnapshot,
  clientNow = Date.now(),
): number => {
  if (snapshot.status === "paused") return snapshot.remainingMs;
  if (snapshot.status !== "running" || snapshot.endsAt === null) return 0;
  const estimatedServerNow = clientNow + snapshot.serverClockOffsetMs;
  return Math.max(0, snapshot.endsAt - estimatedServerNow);
};

export const bindSocketWorkshopTimer = ({
  socket,
  drawingId,
  onChange,
}: {
  socket: Socket;
  drawingId: string;
  onChange: (snapshot: SyncedWorkshopTimerSnapshot) => void;
}) => {
  const reset = () => onChange(createIdleWorkshopTimerSnapshot(drawingId));
  const onTimerUpdate = (value: unknown) => {
    const snapshot = parseWorkshopTimerSnapshot(value, drawingId);
    if (snapshot) onChange(snapshot);
  };

  reset();
  socket.on(WORKSHOP_TIMER_EVENT, onTimerUpdate);
  return {
    reset,
    dispose() {
      socket.off(WORKSHOP_TIMER_EVENT, onTimerUpdate);
    },
  };
};
