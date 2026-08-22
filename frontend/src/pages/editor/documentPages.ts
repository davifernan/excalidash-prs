import type { Socket } from "socket.io-client";

const DOCUMENT_PAGE_EVENT = "document-page-update";
export const DOCUMENT_PAGE_COMMAND_EVENT = "document-page-command";

/** Which page each document widget on the board is turned to, by element id. */
export type SharedDocumentPages = Readonly<Record<string, number>>;

export type DocumentPageController = {
  pages: SharedDocumentPages;
  /**
   * Ask the room to turn a widget to a page. Nothing changes here — the server
   * decides and sends the result back, so a refused turn simply never happens
   * rather than leaving this client showing a page nobody else is on.
   */
  requestPage: (elementId: string, assetId: string, page: number) => void;
};

const isPage = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * Read a page update from the server.
 *
 * Updates arrive either as the whole board on joining or as a single widget
 * after somebody turned a page, so the result is always merged rather than
 * treated as the complete picture.
 */
export const parseDocumentPageUpdate = (
  value: unknown,
  drawingId: string,
): SharedDocumentPages | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.drawingId !== drawingId || !Array.isArray(data.pages)) return null;
  const pages: Record<string, number> = {};
  for (const entry of data.pages) {
    if (!entry || typeof entry !== "object") continue;
    const { elementId, page } = entry as Record<string, unknown>;
    if (typeof elementId !== "string" || elementId.length === 0 || !isPage(page)) continue;
    pages[elementId] = page;
  }
  return pages;
};

export const bindSocketDocumentPages = ({
  socket,
  drawingId,
  onChange,
}: {
  socket: Socket;
  drawingId: string;
  onChange: (update: (current: SharedDocumentPages) => SharedDocumentPages) => void;
}) => {
  const reset = () => onChange(() => ({}));
  const onUpdate = (value: unknown) => {
    const pages = parseDocumentPageUpdate(value, drawingId);
    if (pages) onChange((current) => ({ ...current, ...pages }));
  };

  reset();
  socket.on(DOCUMENT_PAGE_EVENT, onUpdate);
  return {
    reset,
    dispose() {
      socket.off(DOCUMENT_PAGE_EVENT, onUpdate);
    },
  };
};
