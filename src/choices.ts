import { sumCost, sumUsage } from "./cost.js";
import {
  ClassifierError,
  type Answer,
  type ClassifierCost,
  type ClassifierResult,
  type ClassifierSettings,
  type PreparedInput,
  type Question,
  type ResolvedModel,
} from "./types.js";

export type ChoicePolicy = { none: boolean; batch: boolean };

export function choicePolicy(settings: ClassifierSettings): ChoicePolicy {
  for (const key of ["none_of_above_choice", "remove_choice_limits"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean")
      throw new ClassifierError("configuration", key + " must be a boolean.");
  }
  const none = settings.none_of_above_choice === true;
  const batch = settings.remove_choice_limits === true;
  if (batch && !none)
    throw new ClassifierError(
      "configuration",
      "remove_choice_limits requires none_of_above_choice: true. No classifier request was sent.",
    );
  return { none, batch };
}

type ChoicePlan = {
  question: Extract<Question, { type: "choice" }>;
  entries: [string, string][];
  offset: number;
  sentinel: string;
};

const NONE_DESCRIPTION =
  "None of the other options in this question applies to the supplied state. Select this only when every listed real option is unsuitable.";

/** Only this operation owns batching. Transport, images, credentials and routes stay with the caller. */
export async function executeChoices(
  input: PreparedInput,
  route: ResolvedModel,
  policy: ChoicePolicy,
  call: (questions: Record<string, Question>) => Promise<ClassifierResult>,
  signal?: AbortSignal,
): Promise<ClassifierResult> {
  const plans = new Map<string, ChoicePlan>();
  for (const [id, question] of Object.entries(input.questions)) {
    if (question.type !== "choice") continue;
    const entries = Object.entries(question.criteria);
    if (policy.batch && route.maxChoices === undefined)
      throw new ClassifierError(
        "configuration",
        "Automatic choice batching needs a verified provider limit. Set providers.<id>.maxChoices (or customProviders.<id>.maxChoices) for this endpoint. No classifier request was sent.",
      );
    const size = entries.length + (policy.none ? 1 : 0);
    if (
      !policy.batch &&
      route.maxChoices !== undefined &&
      size > route.maxChoices
    )
      throw new ClassifierError(
        "input",
        "Choice question " + id + " exceeds the selected provider's " +
          route.maxChoices + " options per request" +
          (policy.none ? " (including NONE OF THE ABOVE)" : "") +
          ". Enable both none_of_above_choice and remove_choice_limits to batch choices, or reduce the list. No classifier request was sent.",
      );
    let sentinel = "__pi_none_of_above";
    let suffix = 0;
    while (Object.hasOwn(question.criteria, sentinel))
      sentinel = "__pi_none_of_above_" + ++suffix;
    plans.set(id, { question, entries, offset: 0, sentinel });
  }
  if (!policy.none || plans.size === 0) return call(input.questions);

  const answers = Object.create(null) as Record<string, Answer>;
  let calls = 0;
  let last: ClassifierResult | undefined;
  let usage: ClassifierResult["usage"];
  let cost: ClassifierCost | undefined;
  while (plans.size > 0) {
    if (signal?.aborted)
      throw new ClassifierError("aborted", "Classification was cancelled.");
    const questions = Object.create(null) as Record<string, Question>;
    // A bool/score/box is evaluated once, not charged again for later choice batches.
    if (calls === 0) {
      for (const [id, question] of Object.entries(input.questions))
        if (question.type !== "choice") questions[id] = question;
    }
    for (const [id, plan] of plans) {
      const capacity =
        route.maxChoices === undefined
          ? plan.entries.length
          : route.maxChoices - 1;
      const batch = plan.entries.slice(plan.offset, plan.offset + capacity);
      plan.offset += batch.length;
      questions[id] = {
        ...plan.question,
        criteria: Object.fromEntries([...batch, [plan.sentinel, NONE_DESCRIPTION]]),
      };
    }
    let result: ClassifierResult;
    try {
      result = await call(questions);
    } catch (error) {
      // Never replay completed batches on another billing route after a later throttling/auth error.
      if (
        calls > 0 &&
        error instanceof ClassifierError &&
        error.code === "http" &&
        [401, 404, 429].includes(error.httpStatus ?? 0)
      )
        throw new ClassifierError(
          "partial_classification",
          "Choice batching stopped after " + calls +
            " completed provider request(s). No fallback was attempted after partial completion; completed requests may be billed.",
        );
      throw error;
    }
    usage = calls === 0 ? result.usage : sumUsage(usage, result.usage);
    cost = cost === undefined ? result.cost : sumCost(cost, result.cost);
    calls++;
    last = result;
    for (const [id, answer] of Object.entries(result.answers)) {
      const plan = plans.get(id);
      if (!plan) {
        answers[id] = answer;
        continue;
      }
      if (answer.type !== "choice") {
        answers[id] = answer;
        plans.delete(id);
        continue;
      }
      const none = answer.probabilities[plan.sentinel]!;
      const real = Object.entries(answer.probabilities).filter(
        ([label]) => label !== plan.sentinel,
      );
      const maximum = Math.max(...real.map(([, probability]) => probability));
      if (none > maximum) {
        if (plan.offset < plan.entries.length) continue;
        answers[id] = { type: "no_match" };
      } else if (
        none === maximum || real.filter(([, p]) => p === maximum).length !== 1
      ) {
        answers[id] = { type: "ambiguous" };
      } else {
        answers[id] = {
          ...answer,
          choice: real.find(([, p]) => p === maximum)![0],
          probabilities: Object.fromEntries(real),
          probabilityScope: "batch",
          noneOfAboveProbability: none,
        };
      }
      plans.delete(id);
    }
  }
  // Validated inputs always contain questions; this loop executes at least once.
  const combined: ClassifierResult = {
    provider: last!.provider,
    model: last!.model,
    answers,
    providerCalls: calls,
    cost: cost!,
  };
  if (usage !== undefined) combined.usage = usage;
  if (calls === 1 && last!.requestId !== undefined)
    combined.requestId = last!.requestId;
  return combined;
}
