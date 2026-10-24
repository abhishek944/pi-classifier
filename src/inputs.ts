import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import {
  ClassifierError,
  type ClassifyParams,
  type PreparedImage,
  type PreparedLocalImage,
  type PreparedInput,
  type ResolvedModel,
} from "./types.js";
import { hasBox } from "./validation.js";
import { imageReferences } from "./image-content.js";

/** Programmatic image ingress. Never accepted as model-facing tool arguments. */
export interface MemoryImage {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

export async function prepareInput(
  params: ClassifyParams,
  route: ResolvedModel,
  cwd: string,
  signal?: AbortSignal,
  memoryImages: readonly MemoryImage[] = [],
): Promise<PreparedInput> {
  const imageCount = (params.images?.length ?? 0) + memoryImages.length;
  if (imageCount && !route.images)
    throw new ClassifierError("capability", "The selected model does not support images, or experimental Jev images are disabled.");
  if (hasBox(params.questions) && (!route.box || !imageCount))
    throw new ClassifierError("capability", "box requires an enabled Jev 1.14 model, experimentalImages/experimentalBox and an image.");
  const clef = route.api === "cloudflare-system-one" && route.images;
  const maxImages = clef ? 4 : route.api === "perplexity-decisions" ? 8 : 5;
  if (imageCount > maxImages)
    throw new ClassifierError("input", "The selected route accepts at most " + maxImages + " images in this package.");
  if (imageReferences(params.state).length && !["system-one", "openai-decisions", "perplexity-decisions"].includes(route.api))
    throw new ClassifierError("capability", "This route does not support explicit image references in state; use shared image paths instead.");
  for (const question of Object.values(params.questions)) {
    if (imageReferences(question.instructions).length && !["system-one", "openai-decisions"].includes(route.api))
      throw new ClassifierError("capability", "Image references in question instructions require Jev or OpenAI Decisions.");
    if ("criteria" in question && question.criteria && Object.values(question.criteria).some((entry) => imageReferences(entry).length) && route.api !== "system-one")
      throw new ClassifierError("capability", "Image references in criteria require a Jev assets-protocol route.");
  }
  // Reject unsupported URL placement before opening any local files.
  for (const source of params.images ?? []) {
    if (typeof source !== "string" && "url" in source) {
      if (route.api !== "openai-decisions")
        throw new ClassifierError("capability", "Hosted image URLs are supported only by OpenAI Decisions routes. No URL was fetched.");
      try {
        const url = new URL(source.url);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash)
          throw new Error();
      } catch {
        throw new ClassifierError("input", "Image URLs must be absolute HTTP(S) URLs without credentials or fragments.");
      }
    }
  }
  const images: PreparedImage[] = [];
  let totalBytes = 0;
  const sources = [
    ...(params.images ?? []).map((source) => ({ source })),
    ...memoryImages.map((memory) => ({ memory })),
  ];
  for (const entry of sources) {
    cancelled(signal);
    const maxBytes = (clef ? 4 : 5) * 1024 * 1024;
    let image: PreparedLocalImage;
    let id: string | undefined;
    if ("memory" in entry) {
      image = await prepareImageBytes(entry.memory.bytes, signal, maxBytes, entry.memory.mimeType);
    } else {
      const source = entry.source;
      if (typeof source !== "string" && "url" in source) {
        images.push({ id: source.id, url: source.url });
        continue;
      }
      image = await loadLocalImage(typeof source === "string" ? source : source.path, cwd, signal, maxBytes);
      if (typeof source !== "string") id = source.id;
    }
    totalBytes += Buffer.byteLength(image.data, "base64");
    if (totalBytes > (clef ? 8 : 10) * 1024 * 1024)
      throw new ClassifierError("input", "Images exceed the selected route's total upload byte limit.");
    if (route.api === "system-one") {
      if (image.mimeType === "image/webp")
        throw new ClassifierError("input", "Jev image assets accept PNG and JPEG only.");
      const pixels = image.width * image.height;
      if (image.width < 280 || image.width > 1568 || image.height < 280 || image.height > 1568 || pixels < 78_400 || pixels > 2_458_624)
        throw new ClassifierError("input", "Resize or pad Jev images before sending: each side must be 280–1568 pixels and total area 78400–2458624 pixels. Images are not silently resized.");
    }
    if (route.api === "perplexity-decisions" && Math.ceil(image.width / 32) * Math.ceil(image.height / 32) > 2048)
      throw new ClassifierError("input", "Resize Perplexity images to at most 2048 tiles of 32×32 pixels before classifying.");
    images.push(id === undefined ? image : { ...image, id });
  }
  return { state: params.state, questions: params.questions, images };
}

/** Bounded, fully decoded local image; shared by uploads and local box rendering. */
export async function loadLocalImage(
  path: string,
  cwd: string,
  signal?: AbortSignal,
  maxBytes = 5 * 1024 * 1024,
): Promise<PreparedLocalImage> {
  cancelled(signal);
  try {
    if (/^[a-z]+:/i.test(path)) throw new Error();
    const root = await realpath(cwd);
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (!inside || inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) throw new Error();
    // Reject symlink components, not just the final image.
    let current = root;
    for (const part of inside.split(sep)) {
      current = resolve(current, part);
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || (current === target && !entry.isFile()) || (current !== target && !entry.isDirectory())) throw new Error();
    }
    if (await realpath(target) !== target) throw new Error();
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      // Verify the opened object as well: pre-open path checks alone are raceable.
      await verifyOpenedPath(file.fd, root, signal);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error();
      // A bounded read also handles files grown concurrently after stat().
      const buffer = Buffer.alloc(maxBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        cancelled(signal);
        const read = await file.read(buffer, offset, buffer.length - offset, null);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset > maxBytes) throw new Error();
      bytes = buffer.subarray(0, offset);
    } finally { await file.close(); }
    return await prepareImageBytes(bytes, signal, maxBytes);
  } catch (error) {
    cancelled(signal);
    if (error instanceof ClassifierError) throw error;
    throw new ClassifierError("input", "Images must be non-animated PNG/JPEG/WebP regular files inside cwd, without symlinks, within the documented byte limit and 16 megapixels each.");
  }
}

/** The same full-decode boundary for files and transient Driver captures. */
async function prepareImageBytes(
  input: Uint8Array,
  signal: AbortSignal | undefined,
  maxBytes: number,
  declaredMime?: MemoryImage["mimeType"],
): Promise<PreparedLocalImage> {
  cancelled(signal);
  if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > maxBytes)
    throw new ClassifierError("input", "Image bytes exceed the selected route's limit.");
  try {
    const bytes = Buffer.from(input);
    const meta = await sharp(bytes, { limitInputPixels: 16_777_216 }).metadata();
    if (!meta.width || !meta.height || !["png", "jpeg", "webp"].includes(meta.format ?? "") || (meta.pages ?? 1) > 1) throw new Error();
    const mimeType = meta.format === "jpeg" ? "image/jpeg" : meta.format === "png" ? "image/png" : "image/webp";
    if (declaredMime !== undefined && declaredMime !== mimeType) throw new Error();
    await decodeImage(bytes, signal);
    cancelled(signal);
    return { data: bytes.toString("base64"), mimeType, width: meta.width, height: meta.height };
  } catch (error) {
    cancelled(signal);
    if (error instanceof ClassifierError) throw error;
    throw new ClassifierError("input", "Image bytes must decode as a still PNG/JPEG/WebP matching the declared MIME type, within 16 megapixels.");
  }
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ClassifierError("aborted", "Classification was cancelled.");
}

async function decodeImage(bytes: Buffer, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  // Output through a raw pipeline decodes every pixel and honors the native timeout.
  const decoder = sharp(bytes, { limitInputPixels: 16_777_216, failOn: "warning" }).timeout({ seconds: 10 }).raw();
  let cancel = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = () => { decoder.destroy(); reject(new ClassifierError("aborted", "Classification was cancelled.")); };
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => { decoder.destroy(); reject(new ClassifierError("input", "Image decoding timed out.")); }, 10_000);
      // Keep a rejection handler attached even after cancellation destroys the pipeline.
      decoder.toBuffer().then(() => resolve(), reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

const execFileAsync = promisify(execFile);

/** Verify containment of the opened descriptor, not a raceable pre-open path. */
export async function verifyOpenedPath(fd: number, root: string, signal?: AbortSignal): Promise<void> {
  let openedPath: string;
  if (process.platform === "linux") openedPath = await realpath("/proc/self/fd/" + fd);
  else if (process.platform === "darwin") {
    // Node does not expose F_GETPATH; the OS utility queries this exact descriptor.
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-a", "-p", String(process.pid), "-d", String(fd), "-Fn"], {
      timeout: 3000, maxBuffer: 8192, ...(signal ? { signal } : {}),
    });
    const paths = stdout.split("\n").filter((line) => line.startsWith("n"));
    if (paths.length !== 1) throw new Error();
    openedPath = paths[0]!.slice(1);
  } else throw new ClassifierError("capability", "Safe local file loading currently supports macOS and Linux only. Inline text/JSON and hosted-image classification remain available.");
  const inside = relative(root, openedPath);
  if (!inside || inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside)) throw new Error();
}
