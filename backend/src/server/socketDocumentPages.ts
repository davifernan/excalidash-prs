import type { Server, Socket } from "socket.io";
import { parseDrawingId } from "./socketProtocol";
import { registerAuthorizedRoomEvent, type RoomEventPayload } from "./socketRoomEvent";

export const DOCUMENT_PAGE_EVENT = "document-page-update";
const DOCUMENT_PAGE_COMMAND_EVENT = "document-page-command";

export const DOCUMENT_PAGE_LIMITS = {
  commandsPerMinute: 120,
  /**
   * How many widgets one board may track. A page turn creates a row keyed by an
   * element id the client chooses, so without a ceiling a single account could
   * write rows for endless invented ids. Far above any real board.
   */
  widgetsPerDrawing: 200,
  /**
   * Only PDFs report a page count to the server; Markdown and text are split
   * into pages in the browser, where the reader's width decides. For those this
   * is the only bound the server can apply, and the widget clamps whatever it
   * receives to the pages it actually has.
   */
  maxPageWithoutCount: 10_000,
} as const;

const ELEMENT_ID = /^[\w-]{1,64}$/;

export type DocumentPage = { elementId: string; assetId: string; page: number };
export type DocumentPageSnapshot = { drawingId: string; pages: DocumentPage[] };

export type DocumentPageCommand = RoomEventPayload & {
  elementId: string;
  assetId: string;
  page: number;
};

const roomName = (drawingId: string) => `drawing_${drawingId}`;

export const parseDocumentPageCommand = (value: unknown): DocumentPageCommand | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const drawingId = parseDrawingId(data.drawingId);
  if (!drawingId) return null;
  const { elementId, assetId, page } = data;
  if (typeof elementId !== "string" || !ELEMENT_ID.test(elementId)) return null;
  if (typeof assetId !== "string" || !ELEMENT_ID.test(assetId)) return null;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
  if (page > DOCUMENT_PAGE_LIMITS.maxPageWithoutCount) return null;
  return { drawingId, elementId, assetId, page };
};

/**
 * The room's shared page for every document widget on a board.
 *
 * The client asks; the server decides. Nothing here believes the sender about
 * which document a widget shows or how many pages it has: the asset has to be
 * attached to this very board, and the page has to exist. What goes out to the
 * room is the server's own record, never the request that caused it.
 */
export const createDocumentPageManager = ({
  io,
  prisma,
}: {
  io: Pick<Server, "to">;
  prisma: any;
}) => {
  const snapshot = async (drawingId: string): Promise<DocumentPageSnapshot> => {
    const rows = await prisma.documentPageView.findMany({
      where: { drawingId },
      select: { elementId: true, assetId: true, page: true },
      take: DOCUMENT_PAGE_LIMITS.widgetsPerDrawing,
    });
    return { drawingId, pages: rows };
  };

  const set = async (payload: DocumentPageCommand): Promise<void> => {
    const attached = await prisma.drawingAsset.findUnique({
      where: { drawingId_assetId: { drawingId: payload.drawingId, assetId: payload.assetId } },
      select: { asset: { select: { pageCount: true, status: true } } },
    });
    // A document nobody put on this board has no page to turn, and saying so
    // would tell the sender whether the id exists somewhere else.
    if (!attached?.asset || attached.asset.status !== "READY") return;
    const pageCount = attached.asset.pageCount;
    if (typeof pageCount === "number" && payload.page > pageCount) return;

    const existing = await prisma.documentPageView.findUnique({
      where: {
        drawingId_elementId: { drawingId: payload.drawingId, elementId: payload.elementId },
      },
      select: { page: true },
    });
    if (!existing) {
      const tracked = await prisma.documentPageView.count({
        where: { drawingId: payload.drawingId },
      });
      if (tracked >= DOCUMENT_PAGE_LIMITS.widgetsPerDrawing) return;
    } else if (existing.page === payload.page) {
      // Nothing moved. Skip the write and the broadcast rather than making
      // every reader repaint because somebody clicked a disabled-looking arrow.
      return;
    }

    await prisma.documentPageView.upsert({
      where: {
        drawingId_elementId: { drawingId: payload.drawingId, elementId: payload.elementId },
      },
      create: {
        drawingId: payload.drawingId,
        elementId: payload.elementId,
        assetId: payload.assetId,
        page: payload.page,
      },
      update: { assetId: payload.assetId, page: payload.page },
    });

    const page: DocumentPage = {
      elementId: payload.elementId,
      assetId: payload.assetId,
      page: payload.page,
    };
    io.to(roomName(payload.drawingId)).emit(DOCUMENT_PAGE_EVENT, {
      drawingId: payload.drawingId,
      pages: [page],
    } satisfies DocumentPageSnapshot);
  };

  return { set, snapshot };
};

export type DocumentPageManager = ReturnType<typeof createDocumentPageManager>;

export const registerDocumentPageRoomEvent = ({
  socket,
  pages,
  requireAccess,
}: {
  socket: Socket;
  pages: DocumentPageManager;
  requireAccess: (socket: Socket, drawingId: string, requireEdit?: boolean) => Promise<unknown>;
}): void => {
  registerAuthorizedRoomEvent({
    socket,
    event: DOCUMENT_PAGE_COMMAND_EVENT,
    limit: DOCUMENT_PAGE_LIMITS.commandsPerMinute,
    windowMs: 60_000,
    parse: parseDocumentPageCommand,
    requireAccess,
    // Turning the page for everybody is a change to what the room sees, so it
    // takes the same right as changing anything else on the board. A visitor
    // who may only look still pages through the document on their own screen.
    requireEdit: true,
    handle: pages.set,
  });
};
