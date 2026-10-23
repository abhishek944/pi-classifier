import { randomUUID } from "node:crypto";
import { postJson } from "./http.js";
import {
  ClassifierError,
  isRecord,
  type Answer,
  type ClassifierResult,
  type PreparedImage,
  type PreparedInput,
  type Question,
  type ResolvedModel,
} from "./types.js";

/**
 * Provider protocol adapters. Every request goes through the shared `postJson` boundary, which
 * owns timeouts, cancellation, bounded reads and safe errors. Each adapter call classifies once;
 * route orchestration belongs to classify.ts. Answers are rebuilt field by field from validated values, so raw provider
 * bodies and provider error text never reach callers.
 */

const OPENAI_LABEL = "OpenAI Decisions";
const PERPLEXITY_LABEL = "Perplexity Decisions";
const TYPESAFE_LABEL = "TypeSafe System One";
const CLOUDFLARE_LABEL = "Cloudflare Workers AI";
const EPSILON = 1e-6;
const DISTRIBUTION_TOLERANCE = 0.01;

export async function classifyWithProvider(
  route: ResolvedModel,
  input: PreparedInput,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  switch (route.api) {
    case "openai-decisions":
      return classifyOpenAi(route, input, apiKey, signal);
    case "perplexity-decisions":
      return classifyPerplexity(route, input, apiKey, signal);
    case "system-one":
      return classifySystemOne(route, input, apiKey, signal);
    case "microsoft-system-one":
      return classifyMicrosoft(route, input, apiKey, signal);
    case "cloudflare-system-one":
      return classifyCloudflare(route, input, apiKey, signal);
    default:
      throw new ClassifierError(
        "configuration",
        "Unsupported classifier API protocol.",
      );
  }
}

/* Shared validation ------------------------------------------------------- */

function fail(message: string): never {
  throw new ClassifierError("response", message);
}

function unsupportedBox(): ClassifierError {
  return new ClassifierError(
    "capability",
    "The selected route does not support box questions. Box requires an experimental Jev 1.14 route with images enabled.",
  );
}

function probability(label: string, value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    fail(label + " returned an invalid " + field + ".");
  return value;
}

function unitInterval(label: string, value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < -EPSILON ||
    value > 1 + EPSILON
  ) {
    fail(label + " returned an invalid " + field + ".");
  }
  return Math.min(1, Math.max(0, value));
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizedUsage(
  value: unknown,
): ClassifierResult["usage"] | undefined {
  if (!isRecord(value)) return undefined;
  const input = tokenCount(value.input_tokens);
  const output = tokenCount(value.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const total =
    tokenCount(value.total_tokens) ?? tokenCount((input ?? 0) + (output ?? 0));
  if (total === undefined) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
    totalTokens: total,
  };
}

function finish(
  route: ResolvedModel,
  answers: Record<string, Answer>,
  usage: ClassifierResult["usage"] | undefined,
  requestId: string | undefined,
): ClassifierResult {
  const result: ClassifierResult = {
    provider: route.route,
    model: route.model,
    answers,
  };
  if (usage !== undefined) result.usage = usage;
  if (requestId !== undefined) result.requestId = requestId;
  return result;
}

function dataUrl(image: PreparedImage): string {
  return "data:" + image.mimeType + ";base64," + image.data;
}

/* Answer parsing for map-shaped answers (Perplexity, System One, Clef) --- */

function labelProbabilities(
  label: string,
  id: string,
  value: unknown,
  labels: string[],
): Record<string, number> {
  if (!isRecord(value))
    fail(label + " returned invalid probabilities for " + id + ".");
  const result = Object.create(null) as Record<string, number>;
  for (const [key, entry] of Object.entries(value)) {
    if (!labels.includes(key))
      fail(
        label +
          " returned an unknown option in the probabilities for " +
          id +
          ".",
      );
    result[key] = probability(
      label,
      entry,
      "probability for " + id + "." + key,
    );
  }
  for (const key of labels) {
    if (!Object.hasOwn(result, key))
      fail(label + " did not return a probability for " + id + "." + key + ".");
  }
  return checkDistribution(label, id, result);
}

/** Probability mass must be close to 1; it is never renormalized on the caller's behalf. */
function checkDistribution(
  label: string,
  id: string,
  probabilities: Record<string, number>,
): Record<string, number> {
  let total = 0;
  for (const value of Object.values(probabilities)) total += value;
  if (Math.abs(total - 1) > DISTRIBUTION_TOLERANCE)
    fail(
      label + " returned probabilities that do not sum to 1 for " + id + ".",
    );
  return probabilities;
}

function levelProbabilities(
  label: string,
  id: string,
  value: unknown,
  levels: number,
): Record<string, number> {
  if (!isRecord(value))
    fail(label + " returned invalid probabilities for " + id + ".");
  const result = Object.create(null) as Record<string, number>;
  for (const [key, entry] of Object.entries(value)) {
    const index = Number(key);
    if (
      !/^\d+$/.test(key) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= levels
    ) {
      fail(
        label +
          " returned an unknown level in the probabilities for " +
          id +
          ".",
      );
    }
    const normalized = String(index);
    if (Object.hasOwn(result, normalized))
      fail(label + " returned duplicate probabilities for " + id + ".");
    result[normalized] = probability(
      label,
      entry,
      "probability for " + id + "." + key,
    );
  }
  for (let index = 0; index < levels; index += 1) {
    if (!Object.hasOwn(result, String(index)))
      fail(
        label + " did not return a probability for " + id + "." + index + ".",
      );
  }
  return checkDistribution(label, id, result);
}

function scoreValue(
  label: string,
  id: string,
  value: unknown,
  levels: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(label + " returned an invalid score for " + id + ".");
  const maximum = levels - 1;
  if (value < -EPSILON || value > maximum + EPSILON)
    fail(label + " returned a score outside the rubric for " + id + ".");
  return Math.min(maximum, Math.max(0, value));
}

function parseBox(
  label: string,
  id: string,
  value: unknown,
  confidence: unknown,
): Answer {
  if (!isRecord(value))
    fail(label + " returned an invalid box for " + id + ".");
  const top = unitInterval(label, value.top, "box edge for " + id);
  const bottom = unitInterval(label, value.bottom, "box edge for " + id);
  const left = unitInterval(label, value.left, "box edge for " + id);
  const right = unitInterval(label, value.right, "box edge for " + id);
  if (left >= right)
    fail(
      label +
        " returned a box for " +
        id +
        " whose left edge is not before its right edge.",
    );
  if (top >= bottom)
    fail(
      label +
        " returned a box for " +
        id +
        " whose top edge is not above its bottom edge.",
    );
  return {
    type: "box",
    box: { top, bottom, left, right },
    confidence: probability(label, confidence, "confidence for " + id),
  };
}

function parseTypedAnswer(
  label: string,
  id: string,
  question: Question,
  answer: unknown,
): Answer {
  if (!isRecord(answer))
    fail(label + " returned an invalid answer for " + id + ".");
  if (answer.type === "refusal") return { type: "refusal" };
  if (question.type === "bool") {
    if (answer.type !== "noul")
      fail(label + " did not return a yes/no answer for " + id + ".");
    return {
      type: "bool",
      probability: probability(label, answer.noul, "probability for " + id),
    };
  }
  if (question.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string")
      fail(label + " did not return a choice answer for " + id + ".");
    if (!Object.hasOwn(question.criteria, answer.choice))
      fail(label + " returned an unknown choice for " + id + ".");
    const probabilities = labelProbabilities(
      label,
      id,
      answer.probabilities,
      Object.keys(question.criteria),
    );
    return {
      type: "choice",
      choice: answer.choice,
      probabilities,
      confidence: probability(label, answer.confidence, "confidence for " + id),
    };
  }
  if (question.type === "score") {
    if (answer.type !== "score")
      fail(label + " did not return a score answer for " + id + ".");
    const base = {
      type: "score" as const,
      score: scoreValue(label, id, answer.score, question.criteria.length),
      confidence: probability(label, answer.confidence, "confidence for " + id),
    };
    if (answer.probabilities === undefined) return base;
    return {
      ...base,
      probabilities: levelProbabilities(
        label,
        id,
        answer.probabilities,
        question.criteria.length,
      ),
    };
  }
  if (answer.type !== "box")
    fail(label + " did not return a box answer for " + id + ".");
  return parseBox(label, id, answer.box, answer.confidence);
}

function validateDecision(label: string, id: string, answer: Answer): Answer {
  if (answer.type === "choice") {
    const maximum = Math.max(...Object.values(answer.probabilities));
    if (maximum - answer.probabilities[answer.choice]! > EPSILON)
      fail(
        label +
          " returned a choice inconsistent with its probabilities for " +
          id +
          ".",
      );
  } else if (answer.type === "score" && answer.probabilities) {
    const entries = Object.entries(answer.probabilities);
    const expected = entries.reduce(
      (total, [level, probability]) => total + Number(level) * probability,
      0,
    );
    if (
      Math.abs(answer.score - expected) >
      DISTRIBUTION_TOLERANCE * Math.max(1, entries.length - 1)
    )
      fail(
        label +
          " returned a score inconsistent with its probabilities for " +
          id +
          ".",
      );
  }
  return answer;
}

function parseTypedAnswers(
  label: string,
  value: unknown,
  questions: Record<string, Question>,
): Record<string, Answer> {
  if (!isRecord(value)) fail(label + " returned an unexpected response.");
  // Question IDs may be "__proto__", so answers are collected without a prototype.
  const answers = Object.create(null) as Record<string, Answer>;
  for (const [id, question] of Object.entries(questions)) {
    if (!Object.hasOwn(value, id))
      fail(label + " did not return an answer for " + id + ".");
    answers[id] = validateDecision(
      label,
      id,
      parseTypedAnswer(label, id, question, value[id]),
    );
  }
  return answers;
}

/* OpenAI Decisions -------------------------------------------------------- */

function predicateInstructions(
  question: Extract<Question, { type: "bool" }>,
): string {
  const meanings: string[] = [];
  if (question.criteria?.true)
    meanings.push("True means: " + question.criteria.true);
  if (question.criteria?.false)
    meanings.push("False means: " + question.criteria.false);
  return meanings.length > 0
    ? question.instructions + "\n" + meanings.join("\n")
    : question.instructions;
}

function openAiQuestion(
  id: string,
  question: Question,
): Record<string, unknown> {
  if (question.type === "bool")
    return {
      type: "predicate",
      name: id,
      instructions: predicateInstructions(question),
    };
  if (question.type === "choice") {
    return {
      type: "choice",
      name: id,
      instructions: question.instructions,
      choices: Object.entries(question.criteria).map(
        ([value, description]) => ({ value, description }),
      ),
    };
  }
  if (question.type === "score") {
    return {
      type: "score",
      name: id,
      instructions: question.instructions,
      levels: question.criteria.map((label) => ({ label })),
    };
  }
  throw unsupportedBox();
}

function openAiInput(input: PreparedInput): unknown {
  const text =
    typeof input.state === "string" ? input.state : JSON.stringify(input.state);
  if (input.images.length === 0) return text;
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text },
        ...input.images.map((image) => ({
          type: "input_image",
          image_url: dataUrl(image),
        })),
      ],
    },
  ];
}

function openAiChoiceProbabilities(
  label: string,
  id: string,
  value: unknown,
  labels: string[],
): Record<string, number> {
  if (!Array.isArray(value))
    fail(label + " returned invalid probabilities for " + id + ".");
  const mapped = Object.create(null) as Record<string, unknown>;
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.value !== "string" ||
      !labels.includes(entry.value)
    ) {
      fail(
        label +
          " returned an unknown option in the probabilities for " +
          id +
          ".",
      );
    }
    if (Object.hasOwn(mapped, entry.value))
      fail(label + " returned duplicate probabilities for " + id + ".");
    mapped[entry.value] = entry.probability;
  }
  return labelProbabilities(label, id, mapped, labels);
}

function openAiLevelProbabilities(
  label: string,
  id: string,
  value: unknown,
  levels: number,
): Record<string, number> {
  if (!Array.isArray(value))
    fail(label + " returned invalid probabilities for " + id + ".");
  const mapped = Object.create(null) as Record<string, unknown>;
  for (const entry of value) {
    if (!isRecord(entry) || !Number.isInteger(entry.value))
      fail(
        label +
          " returned an unknown level in the probabilities for " +
          id +
          ".",
      );
    const index = entry.value as number;
    if (index < 0 || index >= levels || Object.hasOwn(mapped, String(index))) {
      fail(
        label +
          " returned an unknown level in the probabilities for " +
          id +
          ".",
      );
    }
    mapped[String(index)] = entry.probability;
  }
  return levelProbabilities(label, id, mapped, levels);
}

function parseOpenAiAnswer(
  label: string,
  id: string,
  question: Question,
  answer: unknown,
): Answer {
  if (!isRecord(answer))
    fail(label + " returned an invalid answer for " + id + ".");
  if (answer.type === "refusal") return { type: "refusal" };
  if (question.type === "bool") {
    if (answer.type !== "predicate")
      fail(label + " did not return a yes/no answer for " + id + ".");
    return {
      type: "bool",
      probability: probability(
        label,
        answer.probability,
        "probability for " + id,
      ),
    };
  }
  if (question.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string")
      fail(label + " did not return a choice answer for " + id + ".");
    if (!Object.hasOwn(question.criteria, answer.choice))
      fail(label + " returned an unknown choice for " + id + ".");
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: openAiChoiceProbabilities(
        label,
        id,
        answer.probabilities,
        Object.keys(question.criteria),
      ),
      confidence: probability(label, answer.confidence, "confidence for " + id),
    };
  }
  if (question.type === "score") {
    if (answer.type !== "score")
      fail(label + " did not return a score answer for " + id + ".");
    const base = {
      type: "score" as const,
      score: scoreValue(label, id, answer.score, question.criteria.length),
      confidence: probability(label, answer.confidence, "confidence for " + id),
    };
    if (answer.probabilities === undefined) return base;
    return {
      ...base,
      probabilities: openAiLevelProbabilities(
        label,
        id,
        answer.probabilities,
        question.criteria.length,
      ),
    };
  }
  throw unsupportedBox();
}

function parseOpenAiAnswers(
  label: string,
  value: unknown,
  questions: Record<string, Question>,
): Record<string, Answer> {
  if (!Array.isArray(value)) fail(label + " returned an unexpected response.");
  const byName = new Map<string, unknown>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string")
      fail(label + " returned an unexpected response.");
    if (byName.has(entry.name)) fail(label + " returned duplicate answers.");
    byName.set(entry.name, entry);
  }
  // Question IDs may be "__proto__", so answers are collected without a prototype.
  const answers = Object.create(null) as Record<string, Answer>;
  for (const [id, question] of Object.entries(questions)) {
    const answer = byName.get(id);
    if (answer === undefined)
      fail(label + " did not return an answer for " + id + ".");
    answers[id] = validateDecision(
      label,
      id,
      parseOpenAiAnswer(label, id, question, answer),
    );
  }
  return answers;
}

async function classifyOpenAi(
  route: ResolvedModel,
  input: PreparedInput,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  const questions = Object.entries(input.questions).map(([id, question]) =>
    openAiQuestion(id, question),
  );
  const { body, requestId } = await postJson(
    route,
    "decisions",
    {
      model: route.model,
      input: openAiInput(input),
      questions,
    },
    apiKey,
    signal,
  );
  if (!isRecord(body)) fail(OPENAI_LABEL + " returned an unexpected response.");
  return finish(
    route,
    parseOpenAiAnswers(OPENAI_LABEL, body.answers, input.questions),
    normalizedUsage(body.usage),
    requestId,
  );
}

/* Perplexity Decisions ---------------------------------------------------- */

function systemOneQuestions(
  questions: Record<string, Question>,
  allowBox: boolean,
): Record<string, unknown> {
  // Question IDs may be "__proto__", so the wire map is collected without a prototype.
  const result = Object.create(null) as Record<string, unknown>;
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "bool") {
      const wire: Record<string, unknown> = {
        type: "noul",
        instructions: question.instructions,
      };
      if (question.criteria !== undefined) wire.criteria = question.criteria;
      result[id] = wire;
    } else if (question.type === "choice") {
      result[id] = {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria,
      };
    } else if (question.type === "score") {
      result[id] = {
        type: "score",
        instructions: question.instructions,
        criteria: question.criteria,
      };
    } else if (allowBox) {
      result[id] = { type: "box", instructions: question.instructions };
    } else {
      throw unsupportedBox();
    }
  }
  return result;
}

function perplexityState(input: PreparedInput): unknown {
  // Perplexity interprets native image parts inside state. Caller JSON is text;
  // only locally validated images may become provider-native image parts.
  const text =
    typeof input.state === "string" ? input.state : JSON.stringify(input.state);
  if (input.images.length === 0) return text;
  return [
    text,
    ...input.images.map((image) => ({
      type: "image_url",
      image_url: { url: dataUrl(image) },
    })),
  ];
}

async function classifyPerplexity(
  route: ResolvedModel,
  input: PreparedInput,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  const state = perplexityState(input);
  const { body, requestId } = await postJson(
    route,
    "decisions",
    {
      model: route.model,
      state,
      questions: systemOneQuestions(input.questions, false),
    },
    apiKey,
    signal,
  );
  if (!isRecord(body))
    fail(PERPLEXITY_LABEL + " returned an unexpected response.");
  return finish(
    route,
    parseTypedAnswers(PERPLEXITY_LABEL, body.answers, input.questions),
    normalizedUsage(body.usage),
    requestId,
  );
}

/* Microsoft Foundry Decision-1 (text/JSON, API-key authentication) -------- */

async function classifyMicrosoft(
  route: ResolvedModel,
  input: PreparedInput,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  const label = "Microsoft Decision-1";
  const { body, requestId } = await postJson(
    route,
    "providers/microsoft/v1/systemone",
    {
      model: route.model, // Foundry deployment name, not necessarily the catalog model ID.
      state: input.state,
      questions: systemOneQuestions(input.questions, false),
    },
    apiKey,
    signal,
  );
  if (!isRecord(body) || !isRecord(body.answers))
    fail(label + " returned an unexpected response.");
  // Some System One endpoints omit confidence; derive it only from validated probabilities.
  const answers = Object.create(null) as Record<string, unknown>;
  for (const [id, question] of Object.entries(input.questions)) {
    const answer = Object.hasOwn(body.answers, id) ? body.answers[id] : undefined;
    if (
      isRecord(answer) &&
      answer.confidence === undefined &&
      answer.type !== "refusal"
    ) {
      if (question.type === "choice" && typeof answer.choice === "string") {
        const probabilities = labelProbabilities(
          label,
          id,
          answer.probabilities,
          Object.keys(question.criteria),
        );
        answers[id] = { ...answer, confidence: probabilities[answer.choice] };
      } else if (question.type === "score") {
        const probabilities = levelProbabilities(
          label,
          id,
          answer.probabilities,
          question.criteria.length,
        );
        answers[id] = {
          ...answer,
          confidence: Math.max(...Object.values(probabilities)),
        };
      } else answers[id] = answer;
    } else answers[id] = answer;
  }
  return finish(
    route,
    parseTypedAnswers(label, answers, input.questions),
    normalizedUsage(body.usage),
    requestId,
  );
}

/* TypeSafe System One (direct API and compatible gateways) --------------- */

function withImageRefs(state: PreparedInput["state"], refs: string[]): unknown {
  if (isRecord(state) && !Object.hasOwn(state, "images"))
    return { ...state, images: refs };
  return { state, images: refs };
}

async function classifySystemOne(
  route: ResolvedModel,
  input: PreparedInput,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  const assets = Object.create(null) as Record<string, unknown>;
  const refs: string[] = [];
  for (const image of input.images) {
    const ref = randomUUID();
    refs.push(ref);
    assets[ref] = {
      type: "image",
      format: image.mimeType === "image/png" ? "png" : "jpg",
      data_base64: image.data,
    };
  }
  const payload: Record<string, unknown> = {
    model: route.model,
    state: refs.length === 0 ? input.state : withImageRefs(input.state, refs),
    questions: systemOneQuestions(input.questions, true),
  };
  if (refs.length > 0) payload.assets = assets;
  const experimentalHeader =
    refs.length > 0 ||
    Object.values(input.questions).some((question) => question.type === "box");
  const extraHeaders = experimentalHeader
    ? { "TypeSafe-Danger-Zone-Images": "true" }
    : undefined;
  const { body, requestId } = await postJson(
    route,
    "systemone",
    payload,
    apiKey,
    signal,
    extraHeaders,
  );
  if (!isRecord(body))
    fail(TYPESAFE_LABEL + " returned an unexpected response.");
  return finish(
    route,
    parseTypedAnswers(TYPESAFE_LABEL, body.answers, input.questions),
    normalizedUsage(body.usage),
    requestId,
  );
}

/* Cloudflare Workers AI (Clef and third-party System One envelopes) ------- */

function clefBodyModel(model: string): string | undefined {
  return /^@cf\/cloudflare\/(clef(?:-flash)?)$/.exec(model)?.[1];
}

function unwrapCloudflare(
  label: string,
  body: unknown,
): Record<string, unknown> {
  if (!isRecord(body)) fail(label + " returned an unexpected response.");
  if (body.success === false)
    fail(
      label +
        " reported that the request failed. Check credentials, model, limits and provider availability.",
    );
  let candidate: Record<string, unknown> = body;
  if (body.result !== undefined) {
    if (!isRecord(body.result))
      fail(label + " returned an unexpected response.");
    candidate = body.result;
  }
  if (isRecord(candidate.answers)) return candidate;
  if (candidate.state !== undefined && candidate.state !== "Completed")
    fail(label + " did not complete the request.");
  if (isRecord(candidate.result) && isRecord(candidate.result.answers))
    return candidate.result;
  fail(label + " returned an unexpected response.");
}

async function classifyCloudflare(
  route: ResolvedModel,
  input: PreparedInput,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  const clefModel = clefBodyModel(route.model);
  let path: string;
  let payload: Record<string, unknown>;
  if (clefModel !== undefined) {
    payload = {
      model: clefModel,
      state: input.state,
      questions: systemOneQuestions(input.questions, false),
    };
    if (input.images.length > 0) {
      payload.images = input.images.map((image) => ({
        content_type: image.mimeType,
        base64: image.data,
      }));
    }
    path = "run/" + route.model;
  } else {
    if (input.images.length > 0)
      throw new ClassifierError(
        "capability",
        "The selected route does not support images for this model.",
      );
    payload = {
      model: route.model,
      input: {
        state: input.state,
        questions: systemOneQuestions(input.questions, false),
      },
    };
    path = "run";
  }
  const { body, requestId } = await postJson(
    route,
    path,
    payload,
    apiKey,
    signal,
  );
  const result = unwrapCloudflare(CLOUDFLARE_LABEL, body);
  const usage =
    normalizedUsage(result.usage) ??
    normalizedUsage(isRecord(body) ? body.usage : undefined);
  return finish(
    route,
    parseTypedAnswers(CLOUDFLARE_LABEL, result.answers, input.questions),
    usage,
    requestId,
  );
}
