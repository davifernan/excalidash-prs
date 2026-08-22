/**
 * Arming the note tool, and putting a note where somebody clicked.
 *
 * Excalidraw has a documented seam for exactly this: an active tool of type
 * `custom` makes it create nothing of its own on pointer-down and hand the
 * event to the host instead. So the note is ours to build, while panning,
 * zooming, selection and every other canvas behaviour stay Excalidraw's.
 *
 * Getting the cursor into the new note lives in stickyPlacement, because the
 * shortcut for the next note needs exactly the same steps.
 */
import { useEffect, useState } from "react";
import { insertStickyNote } from "./stickyPlacement";
import {
  DEFAULT_STICKY_COLOR,
  STICKY_SHORTCUT,
  createStickyNote,
  type StickyColor,
} from "./stickyNote";

/**
 * Whether a keystroke belongs to something being typed into.
 *
 * A shortcut that fires while somebody is renaming a board would put the letter
 * on the canvas instead of in the name.
 */
const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.isContentEditable === true
  );
};

const STICKY_TOOL = "sticky";

type Options = {
  excalidrawAPI: { current: any };
  containerRef: React.RefObject<HTMLElement>;
  canEdit: boolean;
};

export function useStickyNotes({ excalidrawAPI, containerRef, canEdit }: Options) {
  const [armed, setArmed] = useState(false);
  const [color, setColor] = useState<StickyColor>(DEFAULT_STICKY_COLOR);

  const setTool = (tool: any) => excalidrawAPI.current?.setActiveTool?.(tool);
  const armTool = () => setTool({ type: "custom", customType: STICKY_TOOL });
  const dropTool = () => setTool({ type: "selection" });

  /**
   * Watching for the tool being taken out of our hand.
   *
   * Arming is ours to record, but putting the tool down is not: Escape, another
   * tool, the toolbar all go through Excalidraw and never tell us. Without this
   * the button stayed lit and the ghost note kept following the pointer after
   * the tool was long gone.
   *
   * The subscription only exists while armed, which is also what keeps it
   * honest: on mount the editor has not handed over its API yet, and an effect
   * that ran once then would find nothing to subscribe to and never try again.
   */
  useEffect(() => {
    const api = excalidrawAPI.current;
    if (!armed || !api?.onChange) return;

    return api.onChange(() => {
      const tool = excalidrawAPI.current?.getAppState?.()?.activeTool;
      if (tool?.type !== "custom" || tool.customType !== STICKY_TOOL) setArmed(false);
    });
  }, [armed, excalidrawAPI]);

  const disarm = () => {
    setArmed(false);
    dropTool();
  };

  const arm = () => {
    if (!canEdit) return;
    if (armed) {
      setArmed(false);
      dropTool();
    } else {
      setArmed(true);
      armTool();
    }
  };

  // Subscribed only while the tool is armed.
  //
  // That is not an optimisation. On mount the editor has not handed over its
  // API yet, so an effect that ran once would find nothing to subscribe to and
  // never try again — the button would arm the tool and the click would do
  // nothing. Arming happens long after the editor is ready, which makes it the
  // right moment to attach.
  //
  // It also means the handler always holds the colour the button currently
  // shows, with no stale closure to reason about.
  useEffect(() => {
    const api = excalidrawAPI.current;
    if (!armed || !canEdit || !api?.onPointerDown) return;

    return api.onPointerDown((activeTool: any, pointerDownState: any) => {
      if (activeTool?.type !== "custom" || activeTool.customType !== STICKY_TOOL) return;

      // Back to selection straight away: one click, one note. Staying armed
      // would drop another note on every later click on the board.
      api.setActiveTool?.({ type: "selection" });

      const { x, y } = pointerDownState.origin;
      insertStickyNote(api, containerRef.current, createStickyNote(x, y, color), color);
    });
  }, [armed, canEdit, color, containerRef, excalidrawAPI]);

  // The tool answers to a key like every other tool does.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canEdit) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== STICKY_SHORTCUT) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTyping(event.target)) return;
      if (excalidrawAPI.current?.getAppState?.()?.editingTextElement) return;

      event.preventDefault();
      if (armed) {
        setArmed(false);
        dropTool();
      } else {
        setArmed(true);
        armTool();
      }
    };

    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [armed, canEdit, containerRef, excalidrawAPI]);

  return { armed, color, arm, disarm, setColor };
}
