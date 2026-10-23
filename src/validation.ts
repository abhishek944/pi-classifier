import {
  ClassifierError,
  isRecord,
  type ClassifyParams,
  type Question,
} from "./types.js";
import { imageReferences, isImageReference, questionImageReferences } from "./image-content.js";

function invalid(message: string): never {
  throw new ClassifierError("input", message);
}
const imageId = /^[a-zA-Z0-9_-]{1,64}$/;

function content(value: unknown, maxLength: number, nonempty = false): boolean {
  if (typeof value === "string") return value.length <= maxLength && (!nonempty || Boolean(value.trim()));
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) return false;
  if (!value.every((part) => typeof part === "string" || isImageReference(part))) return false;
  validateJson(value, 0);
  return Buffer.byteLength(JSON.stringify(value)) <= maxLength &&
    (!nonempty || value.some((part) => typeof part !== "string" || Boolean(part.trim())));
}

export function validateParams(value: unknown): ClassifyParams {
  if (!isRecord(value) || Object.keys(value).some((key) => !["state", "questions", "images"].includes(key)))
    invalid("Expected state, questions and optional images; provider/model are selected in settings.");
  if (!(typeof value.state === "string" || Array.isArray(value.state) || isRecord(value.state)))
    invalid("state must be text, a JSON object or an array.");
  validateJson(value.state, 0);
  if (!isRecord(value.questions)) invalid("questions must be a map keyed by question ID.");
  const entries = Object.entries(value.questions);
  if (entries.length < 1 || entries.length > 32) invalid("Supply between 1 and 32 questions.");
  for (const [id, question] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !isRecord(question))
      invalid("Question IDs must be 1–64 letters, digits, underscores or hyphens.");
    if (Object.keys(question).some((key) => !["type", "instructions", "criteria"].includes(key)))
      invalid("Unknown question field.");
    if (!content(question.instructions, 16_384, true))
      invalid("Each question needs non-empty text or ordered text/image-reference instructions, at most 16384 characters/bytes.");
    if (question.type === "bool") {
      if (question.criteria !== undefined && (!isRecord(question.criteria) ||
        Object.entries(question.criteria).some(([key, entry]) => !["true", "false"].includes(key) || !content(entry, 4096))))
        invalid("bool criteria must contain optional true/false descriptions or image content.");
    } else if (question.type === "choice") {
      if (!isRecord(question.criteria)) invalid("choice criteria must map labels to descriptions.");
      const criteria = Object.entries(question.criteria);
      if (criteria.length < 1 || criteria.some(([key, entry]) => !key.trim() || key.length > 128 || !content(entry, 4096)))
        invalid("choice requires at least one label with a text or image-content description.");
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10 ||
        question.criteria.some((entry) => !content(entry, 4096, true)))
        invalid("score criteria must contain 2–10 non-empty ordered descriptions or image content.");
    } else if (question.type === "box") {
      if (question.criteria !== undefined) invalid("box does not accept criteria.");
    } else invalid("Question type must be bool, choice, score or box.");
  }
  const ids = new Set<string>();
  if (value.images !== undefined) {
    if (!Array.isArray(value.images) || value.images.length > 8)
      invalid("images must contain at most eight local paths or named path/url descriptors; route-specific limits also apply.");
    for (const image of value.images) {
      if (typeof image === "string") {
        if (!image.trim() || image.length > 4096) invalid("Image paths must be non-empty, at most 4096 characters.");
        continue;
      }
      if (!isRecord(image) || typeof image.id !== "string" || !imageId.test(image.id) ||
        Object.keys(image).some((key) => !["id", "path", "url"].includes(key)) ||
        (Object.hasOwn(image, "path") === Object.hasOwn(image, "url")))
        invalid("Named images require a unique id and exactly one path or url.");
      const source = image.path ?? image.url;
      if (typeof source !== "string" || !source.trim() || source.length > 4096)
        invalid("Image path/url must be non-empty, at most 4096 characters.");
      if (ids.has(image.id)) invalid("Named image IDs must be unique.");
      ids.add(image.id);
    }
  }
  const references = [...imageReferences(value.state), ...questionImageReferences(value.questions as Record<string, Question>)];
  for (const id of references) if (!ids.has(id)) invalid("Every image reference must name an image descriptor in images.");
  for (const id of ids) if (!references.includes(id)) invalid("Every named image must be referenced in state, instructions or criteria.");
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024)
    invalid("Classification text and questions must be at most 2 MiB.");
  return value as unknown as ClassifyParams;
}

function validateJson(value: unknown, depth: number): void {
  if (depth > 32) invalid("JSON content must be at most 32 levels deep.");
  if (isImageReference(value)) {
    if (Object.keys(value).length !== 1 || typeof value.$image !== "string" || !imageId.test(value.$image))
      invalid("An image reference must be exactly {$image: id} with a 1–64 character image ID.");
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const entry of value) validateJson(entry, depth + 1);
    return;
  }
  if (isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const entry of Object.values(value)) validateJson(entry, depth + 1);
    return;
  }
  invalid("Content must contain only finite JSON values.");
}

export function hasBox(questions: Record<string, Question>): boolean {
  return Object.values(questions).some((question) => question.type === "box");
}
