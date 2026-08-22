import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type ImageLimits = {
  maxPixels: number;
  maxDimension: number;
  maxOutputBytes: number;
  timeoutMs: number;
};

class PreviewImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewImageError";
  }
}

type RasterFormat = "png" | "jpeg" | "gif" | "webp" | "ico";

/** Resource policy is passed before any input path, so it governs decoder allocation. */
export function imageMagickResourceArgs(limits: ImageLimits): string[] {
  return [
    "-limit",
    "memory",
    "64MiB",
    "-limit",
    "map",
    "128MiB",
    "-limit",
    "disk",
    "0",
    "-limit",
    "area",
    String(limits.maxPixels),
    "-limit",
    "width",
    String(limits.maxDimension),
    "-limit",
    "height",
    String(limits.maxDimension),
    "-limit",
    // ImageMagick refuses at the limit rather than above it, so 1 rejects even
    // a single-image file: every preview image failed to re-encode, and the
    // catch below reported it as an unsafe image. 2 permits exactly one image,
    // which is all a preview ever needs — an animation is refused here, before
    // a frame is decoded, and the frame count below never has to see it.
    "list-length",
    "2",
    "-limit",
    "thread",
    "1",
  ];
}

/** Magic bytes, not a remote Content-Type, decide which decoder is allowed. */
export function sniffRasterFormat(bytes: Buffer): RasterFormat | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a") return "gif";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "gif";
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return "ico";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

export function parseImageIdentity(
  raw: string,
  limits: ImageLimits,
  allowMultiple = false,
): { width: number; height: number } {
  const frames = raw
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (frames.length > 1 && !allowMultiple) {
    throw new PreviewImageError("Animated images are not accepted for previews.");
  }
  let width = 0;
  let height = 0;
  for (const frame of frames) {
    const match = frame.match(/^(PNG|JPEG|GIF|WEBP|ICO)\s+(\d+)\s+(\d+)$/i);
    if (!match) throw new PreviewImageError("The image decoder returned invalid dimensions.");
    const frameWidth = Number(match[2]);
    const frameHeight = Number(match[3]);
    if (
      !Number.isSafeInteger(frameWidth) ||
      !Number.isSafeInteger(frameHeight) ||
      frameWidth < 1 ||
      frameHeight < 1
    ) {
      throw new PreviewImageError("The image has invalid dimensions.");
    }
    if (frameWidth * frameHeight > limits.maxPixels) {
      throw new PreviewImageError("The image exceeds the pixel limit.");
    }
    if (frameWidth > limits.maxDimension || frameHeight > limits.maxDimension) {
      throw new PreviewImageError("The image exceeds the decoder dimension limit.");
    }
    width = Math.max(width, frameWidth);
    height = Math.max(height, frameHeight);
  }
  return { width, height };
}

/** Decode in a bounded child process, resize, re-encode, and deliberately keep no metadata. */
export async function sanitizePreviewImage(bytes: Buffer, limits: ImageLimits): Promise<Buffer> {
  const format = sniffRasterFormat(bytes);
  if (!format) throw new PreviewImageError("The response is not a supported raster image.");

  const dir = await mkdtemp(join(tmpdir(), "link-preview-"));
  const input = join(dir, `input.${format === "jpeg" ? "jpg" : format}`);
  const output = join(dir, "output.webp");
  const resourceArgs = imageMagickResourceArgs(limits);
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    // One deadline for the whole job, not one per program. Handing the same
    // limit to identify and then again to convert makes a ten-second setting
    // mean twenty seconds of work.
    const deadline = Date.now() + limits.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());

    let identity: string;
    try {
      ({ stdout: identity } = await run(
        "identify",
        [...resourceArgs, "-ping", "-format", "%m %w %h\n", input],
        { timeout: remaining(), maxBuffer: 64 * 1024 },
      ));
    } catch {
      throw new PreviewImageError("The image could not be decoded safely.");
    }
    parseImageIdentity(identity, limits);

    try {
      await run(
        "convert",
        [
          ...resourceArgs,
          `${input}[0]`,
          "-auto-orient",
          "-thumbnail",
          `${limits.maxDimension}x${limits.maxDimension}>`,
          "-strip",
          "-quality",
          "82",
          output,
        ],
        { timeout: remaining(), maxBuffer: 64 * 1024 },
      );
    } catch {
      throw new PreviewImageError("The image could not be re-encoded safely.");
    }
    const outputSize = (await stat(output)).size;
    if (outputSize < 1 || outputSize > limits.maxOutputBytes) {
      throw new PreviewImageError("The sanitized image exceeds the byte limit.");
    }
    const sanitized = await readFile(output);
    return sanitized;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
