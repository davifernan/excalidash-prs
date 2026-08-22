import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { toast } from "sonner";
import { boardSettingsSignature, getFilesDelta, shouldSaveBoardSettings } from "./shared";

const ELEMENT_ORDER_BYTE_LIMIT = 8 * 1024 * 1024;
const ELEMENT_UPDATE_ACK_TIMEOUT_MS = 3_000;
const ELEMENT_UPDATE_RETRY_DELAY_MS = 1_000;

const elementOrderByteLength = (ids: readonly string[]) => {
  const encoder = new TextEncoder();
  return ids.reduce(
    (total, id, index) => total + encoder.encode(JSON.stringify(id)).byteLength + (index ? 1 : 0),
    2,
  );
};

type UseEditorBroadcastParams = {
  drawingId: string | undefined;
  excalidrawAPI: MutableRefObject<any>;
  lastLocalChangeAtRef: MutableRefObject<number>;
  lastSyncedElementOrderSigRef: MutableRefObject<string>;
  lastSyncedFilesRef: MutableRefObject<Record<string, any>>;
  latestAppStateRef: MutableRefObject<any>;
  latestFilesRef: MutableRefObject<any>;
  lastPersistedAppStateSigRef: MutableRefObject<string | null>;
  socketRef: MutableRefObject<any>;
  debouncedSave: (
    drawingId: string,
    elements: readonly any[],
    appState: any,
    files?: Record<string, any>,
  ) => void;
  debouncedSavePreview: (drawingId: string) => void;
  computeElementOrderSig: (elements: readonly any[]) => string;
  hasElementChanged: (element: any) => boolean;
  normalizeImageElementStatus: (
    elements?: readonly any[],
    files?: Record<string, any> | null,
  ) => readonly any[];
  recordElementVersion: (element: any) => void;
  setHasSceneChangesSinceLoad: () => void;
};

export const useEditorBroadcast = ({
  drawingId,
  excalidrawAPI,
  lastLocalChangeAtRef,
  lastSyncedElementOrderSigRef,
  lastSyncedFilesRef,
  latestAppStateRef,
  latestFilesRef,
  lastPersistedAppStateSigRef,
  socketRef,
  debouncedSave,
  debouncedSavePreview,
  computeElementOrderSig,
  hasElementChanged,
  normalizeImageElementStatus,
  recordElementVersion,
  setHasSceneChangesSinceLoad,
}: UseEditorBroadcastParams) => {
  const timeoutRef = useRef<number | null>(null);
  const deliveryRetryTimeoutRef = useRef<number | null>(null);
  const deliveryRetryArgsRef = useRef<[readonly any[], Record<string, any> | undefined] | null>(
    null,
  );
  const emitChangesRef = useRef<
    (elements: readonly any[], currentFiles?: Record<string, any>) => void
  >(() => undefined);
  const lastRunAtRef = useRef(0);
  const trailingArgsRef = useRef<[readonly any[], Record<string, any> | undefined] | null>(null);

  const emitChanges = useCallback(
    (elements: readonly any[], currentFiles?: Record<string, any>) => {
      if (!socketRef.current || !drawingId) return;
      const changes: any[] = [];
      const nextFiles = currentFiles || excalidrawAPI.current?.getFiles() || {};
      const normalizedElements = normalizeImageElementStatus(elements, nextFiles);
      const nextOrderSig = computeElementOrderSig(normalizedElements);
      const shouldSyncOrder = nextOrderSig !== lastSyncedElementOrderSigRef.current;
      normalizedElements.forEach((el) => {
        if (hasElementChanged(el)) {
          changes.push(el);
        }
      });
      const filesDelta = getFilesDelta(lastSyncedFilesRef.current, nextFiles);
      const shouldSyncFiles = Object.keys(filesDelta).length > 0;
      if (Object.keys(nextFiles || {}).length > 0) {
        latestFilesRef.current = nextFiles;
      }
      // A board also remembers settings -- its background, its grid, whether it
      // snaps. Those live in appState, not in any element, so a change to one of
      // them produces no element, file or ordering difference and would reach
      // the server nowhere.
      //
      // The baseline is set once the scene has hydrated, from the state
      // Excalidraw itself reported. Treating "no baseline yet" as a change
      // instead would make the first broadcast of every session write the board
      // back unchanged -- bumping its version and its modified date for
      // everybody, just because somebody opened it.
      const settingsChanged = shouldSaveBoardSettings(
        lastPersistedAppStateSigRef.current,
        latestAppStateRef.current,
      );

      if (changes.length > 0 || shouldSyncFiles || shouldSyncOrder) {
        setHasSceneChangesSinceLoad();
        lastLocalChangeAtRef.current = new Date().getTime();
        const elementOrder = shouldSyncOrder
          ? normalizedElements
              .filter((el: any) => !el?.isDeleted)
              .map((el: any) => el?.id)
              .filter((id): id is string => Boolean(id))
          : undefined;
        const orderBytes = elementOrder ? elementOrderByteLength(elementOrder) : 0;
        const payload = {
          drawingId,
          elements: changes.length > 0 ? changes : [],
          files: shouldSyncFiles ? filesDelta : undefined,
          elementOrder:
            elementOrder && orderBytes <= ELEMENT_ORDER_BYTE_LIMIT ? elementOrder : undefined,
          elementOrderOmittedBytes:
            elementOrder && orderBytes > ELEMENT_ORDER_BYTE_LIMIT ? orderBytes : undefined,
        };
        const acknowledge = (response: any) => {
          if (!response?.ok) {
            const message = response?.error?.message;
            if (typeof message === "string") toast.error(message);
            return;
          }
          changes.forEach((element) => recordElementVersion(element));
          if (shouldSyncOrder) lastSyncedElementOrderSigRef.current = nextOrderSig;
          if (shouldSyncFiles) {
            lastSyncedFilesRef.current = {
              ...lastSyncedFilesRef.current,
              ...filesDelta,
            };
          }
          const warning = response?.warning?.message;
          if (typeof warning === "string") toast.error(warning);
        };
        const socket = socketRef.current;
        if (typeof socket.timeout === "function") {
          socket
            .timeout(ELEMENT_UPDATE_ACK_TIMEOUT_MS)
            .emit("element-update", payload, (error: unknown, response: unknown) => {
              if (!error) {
                acknowledge(response);
                return;
              }
              deliveryRetryArgsRef.current = [normalizedElements, nextFiles];
              if (deliveryRetryTimeoutRef.current !== null) return;
              deliveryRetryTimeoutRef.current = window.setTimeout(() => {
                deliveryRetryTimeoutRef.current = null;
                const args = deliveryRetryArgsRef.current;
                deliveryRetryArgsRef.current = null;
                if (args) emitChangesRef.current(...args);
              }, ELEMENT_UPDATE_RETRY_DELAY_MS);
            });
        } else {
          socket.emit("element-update", payload, acknowledge);
        }
      }

      if (changes.length > 0 || shouldSyncFiles || shouldSyncOrder || settingsChanged) {
        const appState = latestAppStateRef.current;
        if (appState) {
          if (settingsChanged) {
            lastPersistedAppStateSigRef.current = boardSettingsSignature(latestAppStateRef.current);
          }
          debouncedSave(drawingId, normalizedElements, appState, nextFiles);
          debouncedSavePreview(drawingId);
        }
      }
    },
    [
      computeElementOrderSig,
      debouncedSave,
      debouncedSavePreview,
      drawingId,
      excalidrawAPI,
      hasElementChanged,
      lastLocalChangeAtRef,
      lastSyncedElementOrderSigRef,
      lastSyncedFilesRef,
      latestAppStateRef,
      lastPersistedAppStateSigRef,
      latestFilesRef,
      normalizeImageElementStatus,
      recordElementVersion,
      setHasSceneChangesSinceLoad,
      socketRef,
    ],
  );
  emitChangesRef.current = emitChanges;

  const broadcastChanges = useCallback(
    (elements: readonly any[], currentFiles?: Record<string, any>) => {
      const now = new Date().getTime();
      const elapsed = now - lastRunAtRef.current;

      if (elapsed >= 100) {
        if (timeoutRef.current) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
          trailingArgsRef.current = null;
        }
        lastRunAtRef.current = now;
        emitChanges(elements, currentFiles);
        return;
      }

      trailingArgsRef.current = [elements, currentFiles];
      if (timeoutRef.current) return;

      timeoutRef.current = window.setTimeout(() => {
        timeoutRef.current = null;
        const args = trailingArgsRef.current;
        trailingArgsRef.current = null;
        if (!args) return;
        lastRunAtRef.current = new Date().getTime();
        emitChanges(...args);
      }, 100 - elapsed);
    },
    [emitChanges],
  );

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
      if (deliveryRetryTimeoutRef.current !== null) {
        window.clearTimeout(deliveryRetryTimeoutRef.current);
      }
    },
    [],
  );

  return broadcastChanges;
};
