import express from "express";
import { canViewDrawing, getDrawingAccess } from "../../authz/sharing";
import { toPublicTrashCollectionId } from "./trash";
import type { DrawingRouteContext } from "./drawingRouteContext";

export const registerDrawingReadRoutes = (app: express.Express, context: DrawingRouteContext) => {
  const {
    prisma,
    optionalAuth,
    asyncHandler,
    parseJsonField,
    getRequestPrincipal,
    getShareToken,
    respondWithAuthErrorIfPresent,
  } = context;
  app.get(
    "/drawings/:id",
    optionalAuth,
    asyncHandler(async (req, res) => {
      const principal = await getRequestPrincipal(req);

      const { id } = req.params;
      const access = await getDrawingAccess({
        prisma,
        principal,
        drawingId: id,
        shareToken: getShareToken(req),
      });
      if (!canViewDrawing(access)) {
        if (respondWithAuthErrorIfPresent(req, res)) return;
        if (!principal) {
          return res.status(403).json({
            error: "Invalid share link",
            code: "SHARE_LINK_INVALID",
            message: "This share link is no longer valid. Ask the owner for a new link.",
          });
        }
        return res.status(404).json({
          error: "Drawing not found",
          message: "Drawing does not exist",
        });
      }

      // Name every column this route is allowed to read. A `select` rather than
      // an `include` is the point: with `include` the row carries every column
      // the table has, and the response below only removed the ones somebody
      // remembered. The next column with an id in it would have travelled the
      // same way — silently, because nothing here would have had to change.
      const drawing = await prisma.drawing.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          elements: true,
          appState: true,
          files: true,
          preview: true,
          version: true,
          userId: true,
          collectionId: true,
          createdAt: true,
          updatedAt: true,
          createdBy: { select: { name: true } },
        },
      });
      if (!drawing) {
        return res.status(404).json({
          error: "Drawing not found",
          message: "Drawing does not exist",
        });
      }

      const isOwner = principal?.kind === "user" && principal.userId === drawing.userId;
      return res.json({
        id: drawing.id,
        name: drawing.name,
        preview: drawing.preview,
        version: drawing.version,
        createdAt: drawing.createdAt,
        updatedAt: drawing.updatedAt,
        // Who drew it is worth showing; which account row that is, is not. That
        // goes for the owner as well: this route answers anonymous share-link
        // visitors, and an account id handed to one of them identifies the same
        // person on every other board they are ever linked to.
        ...(isOwner ? { userId: drawing.userId } : {}),
        creatorName: drawing.createdBy?.name ?? null,
        // Collections (and trash mapping) are owner-scoped. For shared/public access, avoid leaking
        // owner collection ids like `trash:<ownerId>` and avoid implying the viewer can organize it.
        collectionId: isOwner
          ? toPublicTrashCollectionId(drawing.collectionId, drawing.userId)
          : null,
        elements: parseJsonField(drawing.elements, []),
        appState: parseJsonField(drawing.appState, {}),
        files: parseJsonField(drawing.files, {}),
        accessLevel: access,
      });
    }),
  );
};
