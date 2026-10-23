import { classify, type ClassifyOptions } from "./classify.js";
import { choicePolicy } from "./choices.js";
import { resolveModel } from "./config.js";
import { sumCost, sumUsage } from "./cost.js";
import { loadTreeInput } from "./classification-tree.js";
import {
  ClassifierError,
  userError,
  type ClassifierResult,
  type ClassifierRoute,
  type ClassifierTreeResult,
  type ClassificationTreeNode,
  type TreeStep,
} from "./types.js";

/** Greedy sibling decisions over an already validated classification tree; forced edges make no model call. */
export async function classifyTree(
  params: unknown,
  options: ClassifyOptions,
): Promise<ClassifierTreeResult> {
  choicePolicy(options.settings);
  const input = await loadTreeInput(params, options.cwd, options.signal);
  const initial = resolveModel(options.settings);
  const result: ClassifierTreeResult = {
    provider: initial.route,
    model: initial.model,
    status: "complete",
    levels: Object.create(null) as Record<string, string>,
    steps: [],
    providerCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    cost: {
      status: "estimated",
      currency: "USD",
      source: "aggregated",
      input: 0,
      output: 0,
      total: 0,
    },
  };
  const path: string[] = [];
  let siblings = input.tree.roots;
  let pinned: ClassifierRoute | undefined;
  while (siblings.length > 0) {
    if (options.signal?.aborted)
      throw new ClassifierError("aborted", "Classification was cancelled.");
    let selected: ClassificationTreeNode;
    let step: TreeStep;
    const level = path.length + 1;
    if (siblings.length === 1) {
      selected = siblings[0]!;
      step = { level, id: selected.id, source: "automatic" };
    } else {
      // Non-numeric wire keys preserve array order through JS object enumeration and batching.
      const candidates = new Map(
        siblings.map((node, index) => ["category_" + index, node]),
      );
      const instructions =
        (input.instructions ?? "Choose the most appropriate category for the supplied state.") +
        "\nChoose one child of this selected parent path (JSON IDs): " + JSON.stringify(path) +
        ". Use the option descriptions to decide which branch contains the best category. Do not choose a descendant directly.";
      let branch: ClassifierResult;
      try {
        branch = await classify(
          {
            state: input.state,
            questions: {
              tree: {
                type: "choice",
                instructions,
                criteria: Object.fromEntries(
                  [...candidates].map(([key, node]) => [
                    key, node.description?.trim() ? node.description : node.id,
                  ]),
                ),
              },
            },
            ...(input.images !== undefined ? { images: input.images } : {}),
          },
          {
            ...options,
            // Only the first actual decision can select an explicitly configured fallback route.
            settings: pinned
              ? { ...options.settings, default: pinned, fallback: [] }
              : options.settings,
          },
        );
      } catch (error) {
        if (
          options.signal?.aborted ||
          (error instanceof ClassifierError && error.code === "aborted")
        )
          throw new ClassifierError("aborted", "Classification was cancelled.");
        if (result.providerCalls > 0)
          throw new ClassifierError(
            "partial_classification",
            "Tree traversal stopped at Level" + level + " after " + result.providerCalls +
              " completed provider request(s), which may be billed. No completed levels were replayed. " + userError(error),
          );
        throw error;
      }
      const usage = result.providerCalls === 0
        ? branch.usage
        : sumUsage(result.usage, branch.usage);
      if (usage === undefined) delete result.usage;
      else result.usage = usage;
      result.cost = result.providerCalls === 0
        ? branch.cost
        : sumCost(result.cost, branch.cost);
      result.providerCalls += branch.providerCalls ?? 1;
      result.provider = branch.provider;
      result.model = branch.model;
      pinned = { provider: branch.provider, model: branch.model };
      if (branch.attemptedRoutes !== undefined)
        result.attemptedRoutes = branch.attemptedRoutes;
      const answer = branch.answers.tree;
      if (!answer) throw new ClassifierError("response", "Tree branch returned no answer.");
      if (
        answer.type === "no_match" || answer.type === "ambiguous" ||
        answer.type === "refusal"
      ) {
        result.status = answer.type;
        break;
      }
      if (answer.type !== "choice")
        throw new ClassifierError("response", "Tree branch did not return a choice answer.");
      const probabilities = Object.entries(answer.probabilities);
      const maximum = Math.max(...probabilities.map(([, probability]) => probability));
      const winners = probabilities.filter(([, probability]) => probability === maximum);
      if (winners.length !== 1) {
        result.status = "ambiguous";
        break;
      }
      const node = candidates.get(winners[0]![0]);
      if (!node) throw new ClassifierError("response", "Tree branch selected an unknown category.");
      selected = node;
      step = {
        level,
        id: selected.id,
        source: "model",
        confidence: answer.confidence,
        probabilityScope: answer.probabilityScope ?? "siblings",
      };
      if (answer.noneOfAboveProbability !== undefined)
        step.noneOfAboveProbability = answer.noneOfAboveProbability;
    }
    path.push(selected.id);
    result.levels["Level" + level] = selected.id;
    result.steps.push(step);
    siblings = selected.children ?? [];
  }
  if (options.signal?.aborted)
    throw new ClassifierError("aborted", "Classification was cancelled.");
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > 40 * 1024)
    throw new ClassifierError("response", "Tree result exceeds the 40 KiB tool output limit.");
  return result;
}
