import type { Socket } from "socket.io-client";
import { buildRemoteSceneUpdate } from "./shared";

// This mirrors the server's transport budget so an oversized selection becomes
// the same compact marker before it reaches the socket.
export const REMOTE_SELECTION_LIMITS = { payloadBytes: 256 * 1024 } as const;
const SELECTION_THROTTLE_MS = 50;

type ExcalidrawApi = {
  getAppState: () => any;
  updateScene: (scene: any) => void;
};

type RemoteSelection = { selectedElementIds: string[] } | { allSelected: true };

const LARGE_SELECTION_SUFFIX = " · large selection";

// Keeping the signal in Excalidraw's existing collaborator name makes it
// visible in both the avatar and cursor renderers without inventing element ids.
export const withLargeSelectionStatus = (username: unknown, active: boolean): string => {
  const current = typeof username === "string" && username ? username : "Participant";
  const base = current.endsWith(LARGE_SELECTION_SUFFIX)
    ? current.slice(0, -LARGE_SELECTION_SUFFIX.length)
    : current;
  return active ? `${base}${LARGE_SELECTION_SUFFIX}` : base;
};

const parseRemoteSelectedElementIds = (value: unknown): Record<string, true> | null => {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
    return null;
  }
  return Object.fromEntries(value.map((id) => [id, true])) as Record<string, true>;
};

const selectedIdsFromAppState = (appState: any): string[] =>
  Object.entries(appState?.selectedElementIds || {})
    .filter(([id, selected]) => selected === true && id.length > 0)
    .map(([id]) => id)
    .sort();

const selectionForWire = (drawingId: string, ids: string[]): RemoteSelection => {
  const selectedElementIds: string[] = [];
  const encoder = new TextEncoder();
  let payloadBytes = encoder.encode(JSON.stringify({ drawingId, selectedElementIds })).byteLength;
  for (const id of ids) {
    const nextBytes =
      encoder.encode(JSON.stringify(id)).byteLength + (selectedElementIds.length ? 1 : 0);
    if (payloadBytes + nextBytes > REMOTE_SELECTION_LIMITS.payloadBytes) {
      return { allSelected: true };
    }
    selectedElementIds.push(id);
    payloadBytes += nextBytes;
  }
  return { selectedElementIds };
};

export const bindRemoteSelection = ({
  socket,
  drawingId,
  api,
  throttleMs = SELECTION_THROTTLE_MS,
}: {
  socket: Socket;
  drawingId: string;
  api: ExcalidrawApi;
  throttleMs?: number;
}) => {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastSentSignature: string | null = null;
  let pendingSelection: RemoteSelection | null = null;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (selection: RemoteSelection) => {
    lastSentAt = Date.now();
    lastSentSignature = JSON.stringify(selection);
    socket.emit("selection-update", { drawingId, ...selection });
  };

  const clearTimer = () => {
    if (sendTimer !== null) clearTimeout(sendTimer);
    sendTimer = null;
  };

  const publish = (appState: any) => {
    const selection = selectionForWire(drawingId, selectedIdsFromAppState(appState));
    const signature = JSON.stringify(selection);
    if (signature === lastSentSignature) {
      pendingSelection = null;
      clearTimer();
      return;
    }
    const remaining = throttleMs - (Date.now() - lastSentAt);
    if (remaining <= 0) {
      pendingSelection = null;
      clearTimer();
      send(selection);
      return;
    }
    pendingSelection = selection;
    if (sendTimer !== null) return;
    sendTimer = setTimeout(() => {
      sendTimer = null;
      const nextSelection = pendingSelection;
      pendingSelection = null;
      if (nextSelection) send(nextSelection);
    }, remaining);
  };

  const applySelection = (collaborators: Map<string, any>, payload: any) => {
    if (payload?.drawingId !== drawingId || typeof payload?.presenceId !== "string") return;
    const existing = collaborators.get(payload.presenceId) || { id: payload.presenceId };
    const allSelected = payload.allSelected === true && payload.selectedElementIds === undefined;
    const selectedElementIds = allSelected
      ? {}
      : parseRemoteSelectedElementIds(payload.selectedElementIds);
    if (!selectedElementIds) return;
    const { selectionAllSelected: _previousMarker, ...rest } = existing;
    collaborators.set(payload.presenceId, {
      ...rest,
      username: withLargeSelectionStatus(existing.username, allSelected),
      selectedElementIds,
      ...(allSelected ? { selectionAllSelected: true } : {}),
    });
  };

  const onSelection = (payload: any) => {
    const collaborators = new Map<string, any>(api.getAppState().collaborators || []);
    applySelection(collaborators, payload);
    const { sceneUpdate } = buildRemoteSceneUpdate({ collaborators });
    if (sceneUpdate) api.updateScene(sceneUpdate);
  };

  const onSnapshot = (payload: any) => {
    if (payload?.drawingId !== drawingId || !Array.isArray(payload?.selections)) return;
    const collaborators = new Map<string, any>(api.getAppState().collaborators || []);
    for (const selection of payload.selections) {
      applySelection(collaborators, { drawingId, ...selection });
    }
    const { sceneUpdate } = buildRemoteSceneUpdate({ collaborators });
    if (sceneUpdate) api.updateScene(sceneUpdate);
  };

  const reset = () => {
    clearTimer();
    pendingSelection = null;
    lastSentAt = Number.NEGATIVE_INFINITY;
    lastSentSignature = null;
  };

  socket.on("selection-update", onSelection);
  socket.on("selection-snapshot", onSnapshot);
  return {
    publish,
    reset,
    dispose() {
      reset();
      socket.off("selection-update", onSelection);
      socket.off("selection-snapshot", onSnapshot);
    },
  };
};
