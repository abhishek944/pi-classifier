import {
  ClassifierError,
  isRecord,
  type ClassifyParams,
  type Question,
} from "./types.js";

function invalid(message: string): never {
  throw new ClassifierError("input", message);
}

export function validateParams(value: unknown): ClassifyParams {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["state", "questions", "images"].includes(key),
    )
  )
    invalid(
      "Expected state, questions and optional images; provider/model are selected in settings.",
    );
  if (
    !(
      typeof value.state === "string" ||
      Array.isArray(value.state) ||
      isRecord(value.state)
    )
  )
    invalid("state must be text, a JSON object or an array.");
  validateJson(value.state, 0);
  if (!isRecord(value.questions))
    invalid("questions must be a map keyed by question ID.");
  const entries = Object.entries(value.questions);
  if (entries.length < 1 || entries.length > 32)
    invalid("Supply between 1 and 32 questions.");
  for (const [id, question] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !isRecord(question))
      invalid(
        "Question IDs must be 1–64 letters, digits, underscores or hyphens.",
      );
    if (
      Object.keys(question).some(
        (key) => !["type", "instructions", "criteria"].includes(key),
      )
    )
      invalid("Unknown question field.");
    if (
      typeof question.instructions !== "string" ||
      !question.instructions.trim() ||
      question.instructions.length > 16_384
    )
      invalid(
        "Each question needs non-empty instructions, at most 16384 characters.",
      );
    if (question.type === "bool") {
      if (
        question.criteria !== undefined &&
        (!isRecord(question.criteria) ||
          Object.entries(question.criteria).some(
            ([key, entry]) =>
              !["true", "false"].includes(key) ||
              typeof entry !== "string" ||
              entry.length > 4096,
          ))
      )
        invalid("bool criteria must contain optional true/false descriptions.");
    } else if (question.type === "choice") {
      if (!isRecord(question.criteria))
        invalid("choice criteria must map labels to descriptions.");
      const criteria = Object.entries(question.criteria);
      if (
        criteria.length < 1 ||
        criteria.length > 64 ||
        criteria.some(
          ([key, entry]) =>
            !key.trim() ||
            key.length > 128 ||
            typeof entry !== "string" ||
            entry.length > 4096,
        )
      )
        invalid("choice requires 1–64 labels with string descriptions.");
    } else if (question.type === "score") {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2 ||
        question.criteria.length > 10 ||
        question.criteria.some(
          (entry) =>
            typeof entry !== "string" || !entry.trim() || entry.length > 4096,
        )
      )
        invalid(
          "score criteria must contain 2–10 non-empty ordered descriptions.",
        );
    } else if (question.type === "box") {
      if (question.criteria !== undefined)
        invalid("box does not accept criteria.");
    } else invalid("Question type must be bool, choice, score or box.");
  }
  if (
    value.images !== undefined &&
    (!Array.isArray(value.images) ||
      value.images.length > 5 ||
      value.images.some(
        (path) =>
          typeof path !== "string" || !path.trim() || path.length > 4096,
      ))
  )
    invalid("images must contain at most five local file paths.");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
    invalid("Classification text and questions must be at most 2 MiB.");
  return value as unknown as ClassifyParams;
}

function validateJson(value: unknown, depth: number): void {
  if (depth > 32) invalid("state must be at most 32 levels deep.");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const entry of value) validateJson(entry, depth + 1);
    return;
  }
  if (
    isRecord(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    for (const entry of Object.values(value)) validateJson(entry, depth + 1);
    return;
  }
  invalid("state must contain only finite JSON values.");
}

export function hasBox(questions: Record<string, Question>): boolean {
  return Object.values(questions).some((question) => question.type === "box");
}
