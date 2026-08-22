/**
 * Making the text fit the note instead of the note fit the text.
 *
 * Excalidraw grows a container downwards when its label no longer fits. That is
 * right for a labelled box and wrong for a sticky note: a wall of notes only
 * reads as a wall while the notes stay the same size. Miro and tldraw both keep
 * the shape and shrink the writing, and that is what this does.
 *
 * The measuring is not ours. `restoreElements` with `refreshDimensions` runs
 * Excalidraw's own wrapping and text metrics over a throwaway copy of the note
 * and hands back what the label would become — so a size accepted here is a
 * size Excalidraw agrees with, to the pixel. Reimplementing the wrapping would
 * mean maintaining a second answer to the same question, and the two would
 * drift apart on the first CJK line break.
 */
import { restoreElements } from "@excalidraw/excalidraw";

/** Excalidraw's own padding between a container and its label, per side. */
const BOUND_TEXT_PADDING = 5;

/**
 * Sizes to fall back through, largest first.
 *
 * A ladder rather than every whole number: each step has to be visible, or
 * notes in a row end up at 17, 18 and 19 point and look accidental instead of
 * deliberate. Below 8 the writing is unreadable anyway, so that is the floor.
 */
export const FONT_SIZE_LADDER = [36, 28, 20, 16, 12, 10, 8] as const;

/**
 * The sizes to try for a note whose chosen size is `base`, largest first.
 *
 * The chosen size is the ceiling: text never grows past what the author picked,
 * it only gives way when there is no room — and it climbs back as soon as there
 * is, so deleting a sentence undoes the shrink.
 */
export function ladderFrom(base: number): number[] {
  return [base, ...FONT_SIZE_LADDER.filter((size) => size < base)];
}

export type StickyFit = {
  fontSize: number;
  /** The wrapped text, with the line breaks Excalidraw would have chosen. */
  text: string;
  width: number;
  height: number;
  x: number;
  y: number;
  /** False when even the smallest size overflows, so the caller can say so. */
  fits: boolean;
};

/**
 * Lay a label out at one font size without touching anything real.
 *
 * The copy is handed `text: originalText` on purpose. Excalidraw wraps whatever
 * is in `text`, and after an earlier fit that field already carries line breaks
 * — wrapping it again would keep those breaks and report a taller label than
 * the smaller font actually needs.
 */
function layoutAt(container: any, text: any, fontSize: number): StickyFit | null {
  const probe = {
    ...text,
    fontSize,
    text: text.originalText ?? text.text ?? "",
  };

  const restored = restoreElements([container, probe], null, {
    repairBindings: true,
    refreshDimensions: true,
  }) as any[];

  const laidOut = restored.find((element) => element.id === text.id);
  if (!laidOut) return null;

  return {
    fontSize,
    text: laidOut.text,
    width: laidOut.width,
    height: laidOut.height,
    x: laidOut.x,
    y: laidOut.y,
    fits: true,
  };
}

/**
 * The largest size from the ladder whose label still fits the note.
 *
 * Walks down rather than binary-searching: the ladder is a handful of entries,
 * and a walk cannot pick a size that the step above would also have passed.
 */
export function fitTextToNote(container: any, text: any, baseFontSize: number): StickyFit | null {
  if (!container || !text) return null;

  const available = container.height - BOUND_TEXT_PADDING * 2;
  let smallest: StickyFit | null = null;

  for (const fontSize of ladderFrom(baseFontSize)) {
    const candidate = layoutAt(container, text, fontSize);
    if (!candidate) continue;
    smallest = candidate;
    if (candidate.height <= available) return candidate;
  }

  // Nothing fits. Keeping the smallest beats refusing: a note somebody pasted
  // an essay into still shows its opening lines instead of turning blank.
  return smallest ? { ...smallest, fits: false } : null;
}
