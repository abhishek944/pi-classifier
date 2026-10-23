import {
  ClassifierError,
  isRecord,
  type ClassifierCost,
  type ClassifierResult,
  type ResolvedModel,
  type TokenPricing,
} from "./types.js";

// Standard public USD rates, not account-specific billing. Sources and caveats are in README.
// Keep exact model matches: newer IDs and other hosts must not inherit guessed prices.
const PRICES: Record<string, Record<string, TokenPricing>> = {
  openai: {
    "gpt-6-luna": {
      inputPerMillion: 0.1,
      outputPerMillion: 0,
      cachedInputPerMillion: 0.01,
      cacheWritePerMillion: 0.125,
    },
  },
  typesafe: Object.fromEntries(
    ["jev-latest", "jev-preview", "jev-1.13.0", "jev-1.14.0"].map((id) => [
      id,
      { inputPerMillion: 0.042, outputPerMillion: 0 },
    ]),
  ),
  perplexity: {
    "pplx-decider-v1.1-27b": { inputPerMillion: 0.02, outputPerMillion: 0 },
    "pplx-decider-v1-27b": { inputPerMillion: 0.02, outputPerMillion: 0 },
    "pplx-decider-v1.2": { inputPerMillion: 0.02, outputPerMillion: 0 },
    "pplx-decider-latest": { inputPerMillion: 0.02, outputPerMillion: 0 },
    "pplx-decider-flash-v1.2": { inputPerMillion: 0.01, outputPerMillion: 0 },
    "pplx-decider-flash-latest": { inputPerMillion: 0.01, outputPerMillion: 0 },
  },
  cloudflare: {
    "@cf/cloudflare/clef": { inputPerMillion: 0.24, outputPerMillion: 0 },
    "@cf/cloudflare/clef-flash": { inputPerMillion: 0.038, outputPerMillion: 0 },
    "typesafe/jev": {
      inputPerMillion: 0.042,
      outputPerMillion: 0,
      cachedInputPerMillion: 0,
    },
  },
};

/** Validate overrides before a request; use public prices only for known official endpoints. */
export function resolvePricing(
  provider: string,
  model: string,
  baseUrl: string,
  overrides: unknown,
): ResolvedModel["pricing"] {
  if (overrides !== undefined) {
    if (!isRecord(overrides))
      throw new ClassifierError(
        "configuration",
        "Provider pricing must be a model-keyed object.",
      );
    if (Object.hasOwn(overrides, model)) {
      const value = overrides[model];
      const keys = [
        "inputPerMillion",
        "outputPerMillion",
        "cachedInputPerMillion",
        "cacheWritePerMillion",
      ];
      if (
        !isRecord(value) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        !validRate(value.inputPerMillion) ||
        !validRate(value.outputPerMillion) ||
        keys.slice(2).some(
          (key) => value[key] !== undefined && !validRate(value[key]),
        )
      )
        throw new ClassifierError(
          "configuration",
          "Model pricing requires finite, non-negative inputPerMillion and outputPerMillion USD rates, with optional cachedInputPerMillion and cacheWritePerMillion.",
        );
      const rates: TokenPricing = {
        inputPerMillion: value.inputPerMillion,
        outputPerMillion: value.outputPerMillion,
      };
      if (validRate(value.cachedInputPerMillion))
        rates.cachedInputPerMillion = value.cachedInputPerMillion;
      if (validRate(value.cacheWritePerMillion))
        rates.cacheWritePerMillion = value.cacheWritePerMillion;
      return { rates, source: "configured" };
    }
  }
  const official =
    (provider === "openai" && baseUrl === "https://api.openai.com/v1") ||
    (provider === "typesafe" && baseUrl === "https://api.typesafe.ai/v1") ||
    (provider === "perplexity" && baseUrl === "https://api.perplexity.ai/v1") ||
    (provider === "cloudflare" &&
      /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/ai$/.test(baseUrl));
  const catalog = Object.hasOwn(PRICES, provider) ? PRICES[provider] : undefined;
  const rates =
    official && catalog && Object.hasOwn(catalog, model)
      ? catalog[model]
      : undefined;
  return rates ? { rates: { ...rates }, source: "builtin" } : undefined;
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function unavailable(
  reason: Extract<ClassifierCost, { status: "unavailable" }>["reason"],
): ClassifierCost {
  return { status: "unavailable", currency: "USD", reason };
}

/** Raw usage is intentional: legacy normalized usage fills missing counters with zero. */
export function estimateCost(
  route: ResolvedModel,
  usage: unknown,
): ClassifierCost {
  if (!route.pricing) return unavailable("unknown_pricing");
  if (!isRecord(usage) || usage.input_tokens === undefined)
    return unavailable("missing_usage");
  const inputTokens = tokenCount(usage.input_tokens);
  if (
    usage.output_tokens === undefined &&
    route.pricing.rates.outputPerMillion !== 0
  )
    return unavailable("missing_usage");
  // Missing output usage is harmless only when the output rate is zero.
  const outputTokens =
    usage.output_tokens === undefined ? 0 : tokenCount(usage.output_tokens);
  if (inputTokens === undefined || outputTokens === undefined)
    return unavailable("invalid_usage");
  const details = usage.input_tokens_details;
  if (details !== undefined && !isRecord(details))
    return unavailable("invalid_usage");
  const cached =
    isRecord(details) && details.cached_tokens !== undefined
      ? tokenCount(details.cached_tokens)
      : 0;
  const writes =
    isRecord(details) && details.cache_write_tokens !== undefined
      ? tokenCount(details.cache_write_tokens)
      : 0;
  if (
    cached === undefined ||
    writes === undefined ||
    cached > inputTokens ||
    writes > inputTokens - cached
  )
    return unavailable("invalid_usage");
  const rates = { ...route.pricing.rates };
  // The extension uses default 30m cache writes. Do not misprice an unexpected 12h write.
  if (isRecord(details) && details.cache_write_tokens_details !== undefined) {
    const writeDetails = details.cache_write_tokens_details;
    if (!isRecord(writeDetails)) return unavailable("invalid_usage");
    const shortWrites = tokenCount(writeDetails.ttl_30m_tokens);
    const longWrites = tokenCount(writeDetails.ttl_12h_tokens);
    if (
      shortWrites === undefined ||
      longWrites === undefined ||
      shortWrites > writes ||
      longWrites !== writes - shortWrites
    )
      return unavailable("invalid_usage");
    if (longWrites > 0) return unavailable("missing_cache_pricing");
  }
  if (
    (cached > 0 && rates.cachedInputPerMillion === undefined) ||
    (writes > 0 && rates.cacheWritePerMillion === undefined)
  )
    return unavailable("missing_cache_pricing");
  // OpenAI doubles input rates for >272K context. Overrides already define effective rates.
  if (
    route.provider === "openai" &&
    route.pricing.source === "builtin" &&
    inputTokens > 272_000
  ) {
    rates.inputPerMillion *= 2;
    if (rates.cachedInputPerMillion !== undefined)
      rates.cachedInputPerMillion *= 2;
    if (rates.cacheWritePerMillion !== undefined)
      rates.cacheWritePerMillion *= 2;
  }
  const input =
    ((inputTokens - cached - writes) / 1_000_000) * rates.inputPerMillion +
    (cached / 1_000_000) * (rates.cachedInputPerMillion ?? 0) +
    (writes / 1_000_000) * (rates.cacheWritePerMillion ?? 0);
  const output = (outputTokens / 1_000_000) * rates.outputPerMillion;
  const total = input + output;
  if (![input, output, total].every(Number.isFinite))
    return unavailable("calculation_overflow");
  return {
    status: "estimated",
    currency: "USD",
    input,
    output,
    total,
    rates,
    source: route.pricing.source,
  };
}

export function sumUsage(
  left: ClassifierResult["usage"],
  right: ClassifierResult["usage"],
): ClassifierResult["usage"] {
  if (!left || !right) return undefined;
  const result: NonNullable<ClassifierResult["usage"]> = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
  if (!Object.values(result).every(Number.isSafeInteger)) return undefined;
  for (const field of ["cachedInputTokens", "cacheWriteTokens"] as const) {
    if (left[field] !== undefined && right[field] !== undefined) {
      const total = left[field] + right[field];
      if (Number.isSafeInteger(total)) result[field] = total;
    }
  }
  return result;
}

export function sumCost(left: ClassifierCost, right: ClassifierCost): ClassifierCost {
  if (left.status === "unavailable") return left;
  if (right.status === "unavailable") return right;
  const input = left.input + right.input;
  const output = left.output + right.output;
  const total = input + output;
  if (![input, output, total].every(Number.isFinite))
    return {
      status: "unavailable",
      currency: "USD",
      reason: "calculation_overflow",
    };
  return {
    status: "estimated",
    currency: "USD",
    source: "aggregated",
    input,
    output,
    total,
  };
}
