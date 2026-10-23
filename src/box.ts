import sharp, { type Sharp } from "sharp";
import { loadLocalImage } from "./inputs.js";
import { ClassifierError, isRecord } from "./types.js";

export type ClassifierBoxMode = "overlay" | "crop";

export type ClassifierBoxEdges = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

/** Pixel coordinates in the source image. */
export type ClassifierBoxPixelBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ClassifierBoxResult = {
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
  pixelBox: ClassifierBoxPixelBox;
  mode: ClassifierBoxMode;
};

type ClassifierBoxParams = {
  image: string;
  box: ClassifierBoxEdges;
  mode: ClassifierBoxMode;
};

const MAX_PIXELS = 16_777_216;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const RENDER_TIMEOUT_SECONDS = 10;
const RENDER_TIMEOUT_MS = RENDER_TIMEOUT_SECONDS * 1000;
const MAX_PATH_LENGTH = 4096;

/**
 * Render a normalized box on a local image, or crop to it, without a provider
 * request or disk write. File containment, byte limits and full decoding are
 * owned by loadLocalImage; this module owns coordinates, rendering and output
 * limits.
 */
export async function renderClassifierBox(
  params: unknown,
  options: { cwd: string; signal?: AbortSignal },
): Promise<ClassifierBoxResult> {
  cancelled(options.signal);
  const parsed = validateBoxParams(params);
  const image = await loadLocalImage(
    parsed.image,
    options.cwd,
    options.signal,
  );
  cancelled(options.signal);
  const pixelBox = toPixelBox(parsed.box, image.width, image.height);

  let rendered: { data: Buffer; width: number; height: number };
  try {
    const source = sharp(Buffer.from(image.data, "base64"), {
      limitInputPixels: MAX_PIXELS,
      failOn: "warning",
    }).timeout({ seconds: RENDER_TIMEOUT_SECONDS });
    rendered =
      parsed.mode === "crop"
        ? await renderPng(source.extract(pixelBox), options.signal)
        : await renderPng(
            source.composite([
              {
                input: Buffer.from(
                  overlaySvg(image.width, image.height, pixelBox),
                ),
                top: 0,
                left: 0,
              },
            ]),
            options.signal,
          );
  } catch (error) {
    cancelled(options.signal);
    if (error instanceof ClassifierError) throw error;
    if (error instanceof Error && /time(d)?\s*out/i.test(error.message))
      throw new ClassifierError("input", "Box rendering timed out.");
    throw new ClassifierError(
      "input",
      "Could not render the box image. Use a non-animated PNG/JPEG/WebP inside cwd and a valid box.",
    );
  }
  cancelled(options.signal);
  if (rendered.data.length > MAX_OUTPUT_BYTES)
    throw new ClassifierError(
      "input",
      "The box output PNG is larger than 10 MiB. Use crop or a smaller region.",
    );
  return {
    data: rendered.data.toString("base64"),
    mimeType: "image/png",
    width: rendered.width,
    height: rendered.height,
    pixelBox,
    mode: parsed.mode,
  };
}

function validateBoxParams(value: unknown): ClassifierBoxParams {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["image", "box", "mode"].includes(key))
  )
    invalid("Expected image, box and optional mode; unknown fields are rejected.");
  const image = value.image;
  if (
    typeof image !== "string" ||
    !image.trim() ||
    image.length > MAX_PATH_LENGTH
  )
    invalid("image must be a local PNG/JPEG/WebP path inside cwd.");
  const candidate = value.box;
  if (
    !isRecord(candidate) ||
    Object.keys(candidate).some(
      (key) => !["top", "bottom", "left", "right"].includes(key),
    )
  )
    invalid("box must contain only top, bottom, left and right.");
  const { top, bottom, left, right } = candidate;
  if (
    !isNormalized(top) ||
    !isNormalized(bottom) ||
    !isNormalized(left) ||
    !isNormalized(right)
  )
    invalid(
      "box edges must be finite normalized numbers between 0 and 1.",
    );
  if (top >= bottom || left >= right)
    invalid("box must have top < bottom and left < right.");
  const mode = value.mode ?? "overlay";
  if (mode !== "overlay" && mode !== "crop")
    invalid("mode must be overlay or crop.");
  return { image, box: { top, bottom, left, right }, mode };
}

function isNormalized(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/** Floor/ceil edges, then clamp to the source so the region always has pixels. */
function toPixelBox(
  box: ClassifierBoxEdges,
  width: number,
  height: number,
): ClassifierBoxPixelBox {
  const left = Math.min(Math.max(Math.floor(box.left * width), 0), width - 1);
  const top = Math.min(Math.max(Math.floor(box.top * height), 0), height - 1);
  const right = Math.min(
    Math.max(Math.ceil(box.right * width), left + 1),
    width,
  );
  const bottom = Math.min(
    Math.max(Math.ceil(box.bottom * height), top + 1),
    height,
  );
  return { left, top, width: right - left, height: bottom - top };
}

/** Fixed rectangle built only from computed integers, so no caller text enters the SVG. */
function overlaySvg(
  width: number,
  height: number,
  box: ClassifierBoxPixelBox,
): string {
  const stroke = Math.max(
    2,
    Math.min(8, Math.round(Math.min(width, height) / 200)),
  );
  const inset = Math.floor(stroke / 2);
  const insetFits = box.width > inset * 2 && box.height > inset * 2;
  const x = insetFits ? box.left + inset : box.left;
  const y = insetFits ? box.top + inset : box.top;
  const rectWidth = Math.max(1, box.width - (insetFits ? inset * 2 : 0));
  const rectHeight = Math.max(1, box.height - (insetFits ? inset * 2 : 0));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="${x}" y="${y}" width="${rectWidth}" height="${rectHeight}" fill="none" stroke="#ff2d55" stroke-width="${stroke}"/>` +
    `</svg>`
  );
}

async function renderPng(
  pipeline: Sharp,
  signal?: AbortSignal,
): Promise<{ data: Buffer; width: number; height: number }> {
  cancelled(signal);
  let cancel = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ data: Buffer; width: number; height: number }>(
      (resolve, reject) => {
        let settled = false;
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          action();
        };
        cancel = () => {
          pipeline.destroy();
          settle(() =>
            reject(
              new ClassifierError("aborted", "Box rendering was cancelled."),
            ),
          );
        };
        signal?.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => {
          pipeline.destroy();
          settle(() =>
            reject(new ClassifierError("input", "Box rendering timed out.")),
          );
        }, RENDER_TIMEOUT_MS);
        pipeline.png().toBuffer({ resolveWithObject: true }).then(
          ({ data, info }) =>
            settle(() =>
              resolve({ data, width: info.width, height: info.height }),
            ),
          (error: unknown) => settle(() => reject(error)),
        );
      },
    );
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

function invalid(message: string): never {
  throw new ClassifierError("input", message);
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ClassifierError("aborted", "Box rendering was cancelled.");
}
