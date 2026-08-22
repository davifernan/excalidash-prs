import { convertToExcalidrawElements } from "@excalidraw/excalidraw";

export const PDF_WIDGET_LINK = "excalidash://pdf-widget";
export const ASSET_WIDGET_LINK = "excalidash://asset-widget";
const PDF_WIDGET_WIDTH = 480;
export const PDF_WIDGET_HEIGHT = 680;
const TEXT_WIDGET_WIDTH = 520;
const TEXT_WIDGET_HEIGHT = 560;

export type AssetWidgetKind = "pdf" | "markdown" | "text";

export type PdfWidgetCustomData = {
  schemaVersion: 1;
  widgetKind: "pdf";
  assetId: string;
};

export type AssetWidgetData = {
  schemaVersion: 1;
  widgetKind: AssetWidgetKind;
  assetId: string;
};

type EmbeddableLike = {
  type?: string;
  link?: string | null;
  customData?: Record<string, unknown>;
};

const isPdfWidgetLink = (link: string) => link === PDF_WIDGET_LINK;
const isAssetWidgetLink = (link: string) => link === ASSET_WIDGET_LINK || isPdfWidgetLink(link);

/**
 * Whether Excalidraw may embed this link.
 *
 * Returning a boolean here answers for every link, which is why wiring
 * `isPdfWidgetLink` in directly switched off Excalidraw's own embeds: pasting a
 * YouTube or Vimeo link stopped producing a player and fell back to plain text.
 * `undefined` means "no opinion", so anything that is not our own widget is
 * judged by Excalidraw's normal rules again.
 */
export const validateEmbeddableLink = (link: string): true | undefined =>
  isAssetWidgetLink(link) ? true : undefined;

export const getAssetWidgetData = (element: EmbeddableLike): AssetWidgetData | null => {
  const customData = element.customData;
  if (
    element.type !== "embeddable" ||
    !element.link ||
    !isAssetWidgetLink(element.link) ||
    !customData ||
    Object.keys(customData).length !== 3 ||
    customData.schemaVersion !== 1 ||
    !["pdf", "markdown", "text"].includes(String(customData.widgetKind)) ||
    typeof customData.assetId !== "string" ||
    customData.assetId.length === 0 ||
    (element.link === PDF_WIDGET_LINK && customData.widgetKind !== "pdf")
  ) {
    return null;
  }
  return customData as AssetWidgetData;
};

export const getPdfWidgetAssetId = (element: EmbeddableLike): string | null => {
  const data = getAssetWidgetData(element);
  return data?.widgetKind === "pdf" ? data.assetId : null;
};

export const createAssetWidgetElement = ({
  assetId,
  widgetKind,
  x,
  y,
}: {
  assetId: string;
  widgetKind: AssetWidgetKind;
  x: number;
  y: number;
}) => {
  const width = widgetKind === "pdf" ? PDF_WIDGET_WIDTH : TEXT_WIDGET_WIDTH;
  const height = widgetKind === "pdf" ? PDF_WIDGET_HEIGHT : TEXT_WIDGET_HEIGHT;
  const customData: AssetWidgetData = { schemaVersion: 1, widgetKind, assetId };
  const [baseElement] = convertToExcalidrawElements([
    { type: "rectangle", x: x - width / 2, y: y - height / 2, width, height },
  ]);
  return {
    ...baseElement,
    type: "embeddable" as const,
    link: ASSET_WIDGET_LINK,
    customData,
  };
};

export const createPdfWidgetElement = ({
  assetId,
  x,
  y,
}: {
  assetId: string;
  x: number;
  y: number;
}) => {
  const customData: PdfWidgetCustomData = {
    schemaVersion: 1,
    widgetKind: "pdf",
    assetId,
  };
  const [baseElement] = convertToExcalidrawElements([
    {
      type: "rectangle",
      x: x - PDF_WIDGET_WIDTH / 2,
      y: y - PDF_WIDGET_HEIGHT / 2,
      width: PDF_WIDGET_WIDTH,
      height: PDF_WIDGET_HEIGHT,
    },
  ]);
  return {
    ...baseElement,
    type: "embeddable" as const,
    link: PDF_WIDGET_LINK,
    customData,
  };
};
