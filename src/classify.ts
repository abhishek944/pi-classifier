import { performance } from "node:perf_hooks";
import { resolveApiKey } from "./auth.js";
import { configuredDefault, configuredRoutes, resolveModel } from "./config.js";
import { prepareInput, type MemoryImage } from "./inputs.js";
import { choicePolicy, executeChoices } from "./choices.js";
import { classifyWithProvider } from "./providers.js";
import {
  ClassifierError,
  userError,
  type ClassifierComparisonResult,
  type ClassifierResult,
  type ClassifierRoute,
  type ClassifierSettings,
  type ClassifyParams,
  type ResolvedModel,
} from "./types.js";
import { validateParams } from "./validation.js";

export type ClassifyOptions = {
  settings: ClassifierSettings;
  cwd: string;
  signal?: AbortSignal;
  /** Trusted programmatic ingress; all bytes still pass normal image validation. */
  memoryImages?: readonly MemoryImage[];
};

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ClassifierError("aborted", "Classification was cancelled.");
}

function routeKey(route: ResolvedModel): string {
  return JSON.stringify([route.api, route.baseUrl, route.model]);
}

function routePair(route: ResolvedModel): ClassifierRoute {
  return { provider: route.route, model: route.model };
}

async function classifyOnce(
  input: ClassifyParams,
  route: ResolvedModel,
  options: ClassifyOptions,
): Promise<ClassifierResult> {
  checkCancelled(options.signal);
  const prepared = await prepareInput(input, route, options.cwd, options.signal, options.memoryImages);
  checkCancelled(options.signal);
  const key = resolveApiKey(route);
  const result = await executeChoices(
    prepared,
    route,
    choicePolicy(options.settings),
    (questions) =>
      classifyWithProvider(route, { ...prepared, questions }, key, options.signal),
    options.signal,
  );
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > 40 * 1024)
    throw new ClassifierError(
      "response",
      "Classifier result exceeds the 40 KiB tool output limit. Ask fewer questions.",
    );
  return result;
}

function permitsFallback(error: unknown): boolean {
  return (
    error instanceof ClassifierError &&
    (error.code === "missing_credentials" ||
      (error.code === "http" && [401, 404, 429].includes(error.httpStatus ?? 0)))
  );
}

/** Default plus explicitly configured, selective fallback. Never retries a route. */
export async function classify(
  params: unknown,
  options: ClassifyOptions,
): Promise<ClassifierResult> {
  choicePolicy(options.settings);
  const input = validateParams(params);
  const candidates = [
    configuredDefault(options.settings),
    ...configuredRoutes(options.settings, "fallback"),
  ];
  const seen = new Set<string>();
  const attemptedRoutes: ClassifierRoute[] = [];
  let lastError: unknown;
  for (const candidate of candidates) {
    checkCancelled(options.signal);
    const route = resolveModel(options.settings, candidate);
    const key = routeKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    attemptedRoutes.push(routePair(route));
    try {
      const result = await classifyOnce(input, route, options);
      if (attemptedRoutes.length > 1) result.attemptedRoutes = attemptedRoutes;
      return result;
    } catch (error) {
      checkCancelled(options.signal);
      if (!permitsFallback(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Explicit comparisons only: configured entries, no default substitution or fallback. */
export async function compareClassifiers(
  params: unknown,
  options: ClassifyOptions,
): Promise<ClassifierComparisonResult> {
  choicePolicy(options.settings);
  const input = validateParams(params);
  const candidates = configuredRoutes(options.settings, "compare");
  if (candidates.length === 0)
    throw new ClassifierError(
      "configuration",
      "Set pi-classifier.compare to the provider/model pairs you explicitly want to compare. Each entry may incur a charge.",
    );
  const comparison: ClassifierComparisonResult = {
    results: [],
    cancelled: false,
  };
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (options.signal?.aborted) {
      comparison.cancelled = true;
      break;
    }
    const start = performance.now();
    let selected = candidate;
    try {
      const route = resolveModel(options.settings, candidate);
      selected = routePair(route);
      const key = routeKey(route);
      if (seen.has(key))
        throw new ClassifierError(
          "configuration",
          "Duplicate comparison endpoint/model was not called again.",
        );
      seen.add(key);
      const result = await classifyOnce(input, route, options);
      comparison.results.push({
        ...selected,
        status: "success",
        result,
        durationMs: performance.now() - start,
      });
    } catch (error) {
      comparison.results.push({
        ...selected,
        status: "error",
        error: {
          code: error instanceof ClassifierError ? error.code : "unexpected",
          message: userError(error),
        },
        durationMs: performance.now() - start,
      });
      if (
        options.signal?.aborted ||
        (error instanceof ClassifierError && error.code === "aborted")
      ) {
        comparison.cancelled = true;
        break;
      }
    }
  }
  return comparison;
}
