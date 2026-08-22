import { API_URL, api } from "./client";
import { addShareTokenToUrl } from "./shareToken";

export type PdfAsset = {
  id: string;
  kind: "PDF";
  name: string;
  sizeBytes: number | null;
  pageCount: number;
};

export type TextAsset = {
  id: string;
  kind: "MARKDOWN" | "TEXT";
  name: string;
  sizeBytes: number | null;
  pageCount: null;
};

export type DocumentAsset = PdfAsset | TextAsset;
export type UploadDocumentKind = "pdf" | "markdown" | "text";

const assetPath = (drawingId: string, assetId: string) =>
  `/drawings/${encodeURIComponent(drawingId)}/assets/${encodeURIComponent(assetId)}`;

const contentTypeFor = (kind: UploadDocumentKind) => {
  if (kind === "markdown") return "text/markdown; charset=utf-8";
  if (kind === "text") return "text/plain; charset=utf-8";
  return "application/pdf";
};

export const uploadDocumentAsset = async (
  drawingId: string,
  file: File,
  kind: UploadDocumentKind,
  onProgress?: (percent: number) => void,
): Promise<DocumentAsset> => {
  const response = await api.post<DocumentAsset>(
    `/drawings/${encodeURIComponent(drawingId)}/assets`,
    file,
    {
      params: { name: file.name },
      headers: { "Content-Type": contentTypeFor(kind) },
      onUploadProgress: (event) => {
        if (!event.total) return;
        onProgress?.(Math.min(100, Math.round((event.loaded * 100) / event.total)));
      },
    },
  );
  return response.data;
};

export const getPdfAsset = async (drawingId: string, assetId: string): Promise<PdfAsset> => {
  const response = await api.get<PdfAsset>(assetPath(drawingId, assetId));
  return response.data;
};

export const getDocumentAsset = async (
  drawingId: string,
  assetId: string,
): Promise<DocumentAsset> => {
  const response = await api.get<DocumentAsset>(assetPath(drawingId, assetId));
  return response.data;
};

export const getDocumentContent = async (drawingId: string, assetId: string): Promise<string> => {
  const response = await api.get<string>(`${assetPath(drawingId, assetId)}/content`, {
    responseType: "text",
  });
  return response.data;
};

const absoluteApiUrl = (path: string) => `${API_URL.replace(/\/$/, "")}${path}`;

export const getPdfPageUrl = (drawingId: string, assetId: string, page: number) =>
  addShareTokenToUrl(absoluteApiUrl(`${assetPath(drawingId, assetId)}/pages/${page}`));

export const getPdfOriginalUrl = (drawingId: string, assetId: string) =>
  addShareTokenToUrl(absoluteApiUrl(`${assetPath(drawingId, assetId)}/original`));

export const getDocumentOriginalUrl = getPdfOriginalUrl;
