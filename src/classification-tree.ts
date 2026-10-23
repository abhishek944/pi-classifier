import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { verifyOpenedPath } from "./inputs.js";
import {
  ClassifierError,
  isRecord,
  type ClassifyTreeParams,
  type ClassificationTree,
  type ClassificationTreeNode,
} from "./types.js";
import { validateParams } from "./validation.js";

const MAX_TREE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 32;

function invalid(message: string): never {
  throw new ClassifierError("input", message);
}

export async function loadTreeInput(
  value: unknown,
  cwd: string,
  signal?: AbortSignal,
): Promise<Omit<ClassifyTreeParams, "tree"> & { tree: ClassificationTree }> {
  cancelled(signal);
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["state", "tree", "instructions", "images"].includes(key),
    )
  )
    invalid(
      "Expected state, tree and optional instructions/images; the route is selected in settings.",
    );
  if (
    value.instructions !== undefined &&
    (typeof value.instructions !== "string" ||
      !value.instructions.trim() || value.instructions.length > 8192)
  )
    invalid("Tree instructions must be a non-empty string of at most 8192 characters.");
  // Reuse existing state/image-path validation without making a provider request.
  const base = validateParams({
    state: value.state,
    questions: { tree: { type: "bool", instructions: "Validate tree input." } },
    ...(value.images !== undefined ? { images: value.images } : {}),
  });
  const raw =
    typeof value.tree === "string"
      ? await readTreeFile(value.tree, cwd, signal)
      : value.tree;
  if (!isRecord(raw) || Object.keys(raw).some((key) => key !== "roots"))
    invalid("Classification tree must be an object containing roots.");
  const ancestors = new Set<object>();
  const roots = nodes(raw.roots, 1, ancestors, { bytes: 0 });
  const tree = { roots };
  if (Buffer.byteLength(JSON.stringify(tree)) > MAX_TREE_BYTES)
    invalid("Classification tree must be at most 2 MiB.");
  cancelled(signal);
  const result: Omit<ClassifyTreeParams, "tree"> & { tree: ClassificationTree } = {
    state: base.state,
    tree,
  };
  if (typeof value.instructions === "string")
    result.instructions = value.instructions;
  if (base.images !== undefined) result.images = base.images;
  return result;
}

function nodes(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  budget: { bytes: number },
): ClassificationTreeNode[] {
  if (!Array.isArray(value) || (depth === 1 && value.length === 0))
    invalid(
      "Classification tree roots must be non-empty and children must be arrays when supplied.",
    );
  if (depth > MAX_DEPTH && value.length > 0)
    invalid("Classification tree must be at most 32 levels deep.");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some((key) => !["id", "description", "children"].includes(key)) ||
      typeof entry.id !== "string" ||
      !entry.id.trim() || entry.id.length > 128 ||
      (entry.description !== undefined &&
        (typeof entry.description !== "string" || entry.description.length > 4096))
    )
      invalid(
        "Each classification tree node needs a non-empty id of at most 128 characters, optional description up to 4096 characters, and optional children.",
      );
    if (ids.has(entry.id)) invalid("Classification tree node IDs must be unique among siblings.");
    if (ancestors.has(entry)) invalid("Classification tree must not contain cycles.");
    ids.add(entry.id);
    ancestors.add(entry);
    const node: ClassificationTreeNode = { id: entry.id };
    if (typeof entry.description === "string") node.description = entry.description;
    // Bound normalization itself, including shared JS subtrees that expand when serialized.
    budget.bytes += Buffer.byteLength(JSON.stringify(node));
    if (budget.bytes > MAX_TREE_BYTES) invalid("Classification tree must be at most 2 MiB.");
    if (entry.children !== undefined)
      node.children = nodes(entry.children, depth + 1, ancestors, budget);
    ancestors.delete(entry);
    return node;
  });
}

async function readTreeFile(
  path: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!path.trim() || path.length > 4096 || /^[a-z]+:/i.test(path))
    invalid(
      "Classification tree must be an inline roots object or a local JSON path inside cwd, not a URL.",
    );
  let bytes: Buffer;
  try {
    const root = await realpath(cwd);
    const target = resolve(root, path);
    const inside = relative(root, target);
    if (
      !inside || inside === ".." ||
      inside.startsWith(".." + sep) || isAbsolute(inside)
    )
      throw new Error();
    let current = root;
    for (const part of inside.split(sep)) {
      cancelled(signal);
      current = resolve(current, part);
      const entry = await lstat(current);
      if (
        entry.isSymbolicLink() ||
        (current === target ? !entry.isFile() : !entry.isDirectory())
      )
        throw new Error();
    }
    if (await realpath(target) !== target) throw new Error();
    const file = await open(
      target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      await verifyOpenedPath(file.fd, root, signal);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_TREE_BYTES)
        throw new Error();
      const buffer = Buffer.alloc(MAX_TREE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        cancelled(signal);
        const next = await file.read(buffer, offset, buffer.length - offset, null);
        if (!next.bytesRead) break;
        offset += next.bytesRead;
      }
      if (offset > MAX_TREE_BYTES) throw new Error();
      bytes = buffer.subarray(0, offset);
    } finally {
      await file.close();
    }
  } catch (error) {
    cancelled(signal);
    if (error instanceof ClassifierError) throw error;
    invalid(
      "Classification tree must be a readable regular file inside cwd, without symlink components, and at most 2 MiB.",
    );
  }
  cancelled(signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalid("Classification tree file must contain valid UTF-8 JSON.");
  }
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ClassifierError("aborted", "Classification was cancelled.");
}
