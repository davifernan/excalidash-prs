import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { toast } from "sonner";
import { isAxiosError, uploadDocumentAsset, type UploadDocumentKind } from "../../api";
import { createAssetWidgetElement, PDF_WIDGET_HEIGHT } from "./pdfWidgetElements";

type CanvasApi = {
  getSceneElementsIncludingDeleted: () => readonly unknown[];
  updateScene: (scene: Record<string, unknown>) => void;
};

type DropPoint = { x: number; y: number };

const responseMessage = (error: unknown): string | null => {
  if (!isAxiosError(error)) return null;
  const data = error.response?.data;
  if (typeof data !== "object" || data === null) return null;
  const message = (data as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
};

const getDocumentUploadErrorMessage = (error: unknown, kind: UploadDocumentKind): string => {
  const label = kind === "pdf" ? "PDF" : kind === "markdown" ? "Markdown file" : "text file";
  if (!isAxiosError(error)) return `Failed to upload the ${label}.`;
  const status = error.response?.status;
  const serverMessage = responseMessage(error);
  if (status === 413) {
    const limit = serverMessage?.match(/(\d+(?:\.\d+)?)\s*MB/i)?.[1];
    return limit ? `The file is too large (max ${limit} MB).` : "The file is too large.";
  }
  if (status === 507) return "No storage space is available.";
  if (status === 422) return serverMessage || `The ${label} could not be read.`;
  if (status === 403) {
    return "You can view this board, but you cannot add anything to it.";
  }
  if (status === 415) return serverMessage || "This document type is not supported.";
  return serverMessage || `Failed to upload the ${label}.`;
};

const isPdfFile = (file: File) =>
  file.type.toLowerCase() === "application/pdf" ||
  (file.type === "" && file.name.toLowerCase().endsWith(".pdf"));

const documentKindForFile = (file: File): UploadDocumentKind | null => {
  if (isPdfFile(file)) return "pdf";
  const name = file.name.toLowerCase();
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name.endsWith(".txt")) return "text";
  return null;
};

export const getDocumentDropFiles = (files: File[]): File[] | null =>
  files.length > 0 && files.every((file) => documentKindForFile(file) !== null) ? files : null;

export const addDroppedDocumentWidgets = async ({
  canvasApi,
  drawingId,
  files,
  point,
}: {
  canvasApi: CanvasApi;
  drawingId: string;
  files: File[];
  point: DropPoint;
}) => {
  const elements = [];
  for (const [index, file] of files.entries()) {
    const kind = documentKindForFile(file);
    if (!kind) continue;
    const toastId = `document-upload-${Date.now()}-${index}`;
    toast.loading(`Uploading ${file.name}...`, { id: toastId, description: "0%" });
    try {
      const asset = await uploadDocumentAsset(drawingId, file, kind, (progress) => {
        toast.loading(`Uploading ${file.name}...`, {
          id: toastId,
          description: `${progress}%`,
        });
      });
      elements.push(
        createAssetWidgetElement({
          assetId: asset.id,
          widgetKind: kind,
          x: point.x,
          y: point.y + index * (PDF_WIDGET_HEIGHT + 24),
        }),
      );
      toast.success(`${file.name} added`, { id: toastId });
    } catch (error) {
      toast.error(getDocumentUploadErrorMessage(error, kind), { id: toastId });
    }
  }

  if (elements.length === 0) return;
  canvasApi.updateScene({
    elements: [...canvasApi.getSceneElementsIncludingDeleted(), ...elements],
    appState: {
      selectedElementIds: Object.fromEntries(elements.map((element) => [element.id, true])),
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

export const addDroppedPdfWidgets = addDroppedDocumentWidgets;
