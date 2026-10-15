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
  type PreparedInput,
  type ResolvedModel,
} from "./types.js";
import { hasBox } from "./validation.js";

export async function prepareInput(
  params: ClassifyParams,
  route: ResolvedModel,
  cwd: string,
  signal?: AbortSignal,
): Promise<PreparedInput> {
  if (params.images?.length && !route.images)
    throw new ClassifierError(
      "capability",
      "The selected model does not support images, or experimental Jev images are disabled.",
    );
  if (hasBox(params.questions) && (!route.box || !params.images?.length))
    throw new ClassifierError(
      "capability",
      "box requires an enabled Jev 1.14 model, experimentalImages/experimentalBox and an image.",
    );
  const images: PreparedImage[] = [];
  const clef = route.api === "cloudflare-system-one" && route.images;
  const perImageLimit = (clef ? 4 : 5) * 1024 * 1024;
  const totalLimit = (clef ? 8 : 10) * 1024 * 1024;
  if (clef && (params.images?.length ?? 0) > 4)
    throw new ClassifierError("input", "Clef accepts at most four images.");
  let totalBytes = 0;
  for (const path of params.images ?? []) {
    if (signal?.aborted)
      throw new ClassifierError("aborted", "Classification was cancelled.");
    try {
      if (/^[a-z]+:/i.test(path)) throw new Error();
      const root = await realpath(cwd);
      const target = resolve(root, path);
      const inside = relative(root, target);
      if (
        !inside ||
        inside === ".." ||
        inside.startsWith(".." + sep) ||
        isAbsolute(inside)
      )
        throw new Error();
      // Reject symlink components, not just the final image.
      let current = root;
      for (const part of inside.split(sep)) {
        current = resolve(current, part);
        const entry = await lstat(current);
        if (
          entry.isSymbolicLink() ||
          (current === target && !entry.isFile()) ||
          (current !== target && !entry.isDirectory())
        )
          throw new Error();
      }
      const canonical = await realpath(target);
      if (canonical !== target) throw new Error();
      const file = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        // Validate the actual opened object: checking the path before open is raceable.
        await verifyOpenedPath(file.fd, root, signal);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > perImageLimit)
          throw new Error();
        // Read a bounded number of bytes even if another process grows the file.
        const buffer = Buffer.alloc(perImageLimit + 1);
        let offset = 0;
        while (offset < buffer.length) {
          if (signal?.aborted)
            throw new ClassifierError(
              "aborted",
              "Classification was cancelled.",
            );
          const read = await file.read(
            buffer,
            offset,
            buffer.length - offset,
            null,
          );
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        if (offset > perImageLimit) throw new Error();
        bytes = buffer.subarray(0, offset);
      } finally {
        await file.close();
      }
      totalBytes += bytes.length;
      if (totalBytes > totalLimit) throw new Error();
      const meta = await sharp(bytes, {
        limitInputPixels: 16_777_216,
      }).metadata();
      if (
        !meta.width ||
        !meta.height ||
        !["png", "jpeg", "webp"].includes(meta.format ?? "") ||
        (meta.pages ?? 1) > 1
      )
        throw new Error();
      if (route.api === "system-one") {
        if (meta.format === "webp")
          throw new ClassifierError(
            "input",
            "Jev image assets accept PNG and JPEG only.",
          );
        const pixels = meta.width * meta.height;
        if (
          meta.width < 256 ||
          meta.width > 1568 ||
          meta.height < 256 ||
          meta.height > 1568 ||
          pixels < 78_400 ||
          pixels > 2_458_624
        ) {
          throw new ClassifierError(
            "input",
            "Resize or pad Jev images before sending: each side must be 256–1568 pixels and total area 78400–2458624 pixels. Images are not silently resized.",
          );
        }
      }
      if (
        route.api === "perplexity-decisions" &&
        Math.ceil(meta.width / 32) * Math.ceil(meta.height / 32) > 2048
      )
        throw new ClassifierError(
          "input",
          "Resize Perplexity images to at most 2048 tiles of 32×32 pixels before classifying.",
        );
      await decodeImage(bytes, signal);
      images.push({
        data: bytes.toString("base64"),
        mimeType:
          meta.format === "jpeg"
            ? "image/jpeg"
            : meta.format === "png"
              ? "image/png"
              : "image/webp",
        width: meta.width,
        height: meta.height,
      });
    } catch (error) {
      if (signal?.aborted)
        throw new ClassifierError("aborted", "Classification was cancelled.");
      if (error instanceof ClassifierError) throw error;
      throw new ClassifierError(
        "input",
        "Images must be non-animated PNG/JPEG/WebP regular files inside cwd, without symlinks, and fit the documented byte and pixel limits (Clef: 4 MiB each/8 MiB total; others: 5 MiB each/10 MiB total; 16 megapixels each).",
      );
    }
  }
  return { state: params.state, questions: params.questions, images };
}

async function decodeImage(bytes: Buffer, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    throw new ClassifierError("aborted", "Classification was cancelled.");
  // A real output pipeline decodes every pixel and honors libvips' native timeout.
  const decoder = sharp(bytes, {
    limitInputPixels: 16_777_216,
    failOn: "warning",
  })
    .timeout({ seconds: 10 })
    .raw();
  let cancel = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      cancel = () => {
        decoder.destroy();
        reject(new ClassifierError("aborted", "Classification was cancelled."));
      };
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(() => {
        decoder.destroy();
        reject(new ClassifierError("input", "Image decoding timed out."));
      }, 10_000);
      // Attach both handlers even after cancellation so the native callback cannot reject unhandled.
      decoder.toBuffer().then(() => resolve(), reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

const execFileAsync = promisify(execFile);

/** Verify containment of the opened descriptor, not a raceable pre-open path. */
async function verifyOpenedPath(
  fd: number,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  let openedPath: string;
  if (process.platform === "linux") {
    openedPath = await realpath("/proc/self/fd/" + fd);
  } else if (process.platform === "darwin") {
    // Node does not expose F_GETPATH; the OS lsof utility queries it for this exact fd.
    const { stdout } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-a", "-p", String(process.pid), "-d", String(fd), "-Fn"],
      {
        timeout: 3000,
        maxBuffer: 8192,
        ...(signal ? { signal } : {}),
      },
    );
    const paths = stdout.split("\n").filter((line) => line.startsWith("n"));
    if (paths.length !== 1) throw new Error();
    openedPath = paths[0]!.slice(1);
  } else {
    throw new ClassifierError(
      "capability",
      "Safe local image loading currently supports macOS and Linux only. Text classification remains available.",
    );
  }
  const inside = relative(root, openedPath);
  if (
    !inside ||
    inside === ".." ||
    inside.startsWith(".." + sep) ||
    isAbsolute(inside)
  )
    throw new Error();
}
