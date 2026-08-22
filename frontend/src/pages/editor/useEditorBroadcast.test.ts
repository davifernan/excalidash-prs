import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import { useEditorBroadcast } from "./useEditorBroadcast";
import { boardSettingsSignature } from "./shared";
import { computeElementOrderSig } from "./useEditorElementTracking";

const ref = <T>(value: T) => ({ current: value }) as MutableRefObject<T>;

describe("editor broadcast delivery tracking", () => {
  it("does not mark element versions or ordering as sent until the server acknowledges them", () => {
    let acknowledge: ((value: any) => void) | undefined;
    const emit = vi.fn((_event: string, _payload: unknown, ack?: (value: any) => void) => {
      acknowledge = ack;
    });
    const orderRef = ref("old-order");
    const recordElementVersion = vi.fn();
    const element = { id: "element-1", version: 2 };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        excalidrawAPI: ref<any>({ getFiles: () => ({}) }),
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: orderRef,
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "new-order",
        hasElementChanged: () => true,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion,
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current([element], {}));

    expect(recordElementVersion).not.toHaveBeenCalled();
    expect(orderRef.current).toBe("old-order");
    expect(acknowledge).toBeTypeOf("function");

    act(() => acknowledge?.({ ok: true }));

    expect(recordElementVersion).toHaveBeenCalledWith(element);
    expect(orderRef.current).toBe("new-order");
  });

  it("retries unacknowledged element content instead of losing it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const acknowledgements: Array<(value: any) => void> = [];
    const emit = vi.fn((_event: string, _payload: unknown, ack?: (value: any) => void) => {
      if (ack) acknowledgements.push(ack);
    });
    const element = { id: "element-1", version: 2 };
    let sent = false;
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        excalidrawAPI: ref<any>({ getFiles: () => ({}) }),
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => !sent,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: () => {
          sent = true;
        },
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current([element], {}));
    act(() => acknowledgements[0]?.({ ok: false, error: { code: "invalid-request" } }));
    vi.advanceTimersByTime(101);
    act(() => result.current([element], {}));

    expect(emit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("automatically retries when the socket acknowledgement window expires", () => {
    vi.useFakeTimers();
    const acknowledgements: Array<(error: unknown, response?: unknown) => void> = [];
    const emit = vi.fn(
      (_event: string, _payload: unknown, ack: (error: unknown, response?: unknown) => void) => {
        acknowledgements.push(ack);
      },
    );
    const socket = {
      timeout: vi.fn(() => ({ emit })),
    };
    const recordElementVersion = vi.fn();
    const element = { id: "element-1", version: 2 };
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        excalidrawAPI: ref<any>({ getFiles: () => ({}) }),
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("same-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>(socket),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "same-order",
        hasElementChanged: () => recordElementVersion.mock.calls.length === 0,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion,
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current([element], {}));
    act(() => acknowledgements[0]?.(new Error("timeout")));

    expect(recordElementVersion).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1_000));

    expect(emit).toHaveBeenCalledTimes(2);
    expect(recordElementVersion).not.toHaveBeenCalled();

    act(() => acknowledgements[1]?.(null, { ok: true }));

    expect(recordElementVersion).toHaveBeenCalledTimes(1);
    expect(recordElementVersion).toHaveBeenCalledWith(element);
    vi.useRealTimers();
  });

  it("does not let deleted elements inflate ordering payloads", () => {
    let payload: any;
    const emit = vi.fn((_event: string, value: unknown) => {
      payload = value;
    });
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        excalidrawAPI: ref<any>({ getFiles: () => ({}) }),
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref("old-order"),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: ref(null),
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: ref(boardSettingsSignature(null)),
        socketRef: ref<any>({ emit }),
        debouncedSave: vi.fn(),
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => "new-order",
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );

    act(() => result.current([{ id: "visible" }, { id: "deleted", isDeleted: true }], {}));

    expect(payload.elementOrder).toEqual(["visible"]);
    expect(computeElementOrderSig([{ id: "visible" }, { id: "deleted", isDeleted: true }])).toBe(
      computeElementOrderSig([{ id: "deleted", isDeleted: true }, { id: "visible" }]),
    );
  });
});

describe("saving the settings a board keeps", () => {
  // Broadcasting is throttled to one run per 100ms. Without moving the clock
  // between calls the later ones are merged away, and a test that meant to
  // prove "written once" would prove only "throttled".
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = () => act(() => void vi.advanceTimersByTime(200));

  const harness = (
    appState: MutableRefObject<any>,
    orderSig = "same-order",
    // What the board arrived with. Set once the scene has hydrated, so opening
    // a board writes nothing back.
    settingsBaseline: MutableRefObject<string | null> = ref(
      boardSettingsSignature(appState.current),
    ),
  ) => {
    const debouncedSave = vi.fn();
    const { result } = renderHook(() =>
      useEditorBroadcast({
        drawingId: "drawing-1",
        excalidrawAPI: ref<any>({ getFiles: () => ({}) }),
        lastLocalChangeAtRef: ref(0),
        lastSyncedElementOrderSigRef: ref(orderSig),
        lastSyncedFilesRef: ref({}),
        latestAppStateRef: appState,
        latestFilesRef: ref({}),
        lastPersistedAppStateSigRef: settingsBaseline,
        socketRef: ref<any>({ emit: vi.fn() }),
        debouncedSave,
        debouncedSavePreview: vi.fn(),
        computeElementOrderSig: () => orderSig,
        hasElementChanged: () => false,
        normalizeImageElementStatus: (elements) => elements,
        recordElementVersion: vi.fn(),
        setHasSceneChangesSinceLoad: vi.fn(),
      }),
    );
    return { broadcast: result.current, debouncedSave };
  };

  it("writes a settings change that touches no element", () => {
    // Turning snapping off changes appState and nothing else: no element, no
    // file, no ordering. While the ordering signature was never initialised on
    // load, the first change of a session always looked like an ordering change
    // and carried the settings along by accident. Once that was fixed, the
    // setting stopped being saved and came back on the next reload.
    const appState = ref<any>({ objectsSnapModeEnabled: true });
    const { broadcast, debouncedSave } = harness(appState);

    act(() => broadcast([], {}));
    settle();

    appState.current = { objectsSnapModeEnabled: false };
    act(() => broadcast([], {}));

    expect(debouncedSave).toHaveBeenCalledTimes(1);
    expect(debouncedSave.mock.calls[0][2]).toEqual({ objectsSnapModeEnabled: false });
  });

  it("writes nothing back when a board is merely opened", () => {
    // Excalidraw reports a change of its own once a scene has hydrated. If that
    // counted as a settings change, every open would save the board unchanged:
    // a new version and a fresh modified date for everybody in it, because
    // somebody looked at it.
    const appState = ref<any>({ objectsSnapModeEnabled: true });
    const { broadcast, debouncedSave } = harness(appState);

    act(() => broadcast([], {}));
    settle();
    act(() => broadcast([], {}));
    settle();

    expect(debouncedSave).not.toHaveBeenCalled();
  });

  it("does not write again while the settings stand still", () => {
    const appState = ref<any>({ objectsSnapModeEnabled: true });
    const { broadcast, debouncedSave } = harness(appState);

    appState.current = { objectsSnapModeEnabled: false };
    act(() => broadcast([], {}));
    settle();
    act(() => broadcast([], {}));
    settle();
    act(() => broadcast([], {}));
    settle();

    // Once, for the change itself. Panning and clicking about must not keep
    // writing the same settings back.
    expect(debouncedSave).toHaveBeenCalledTimes(1);
  });
});
