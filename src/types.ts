export type ApiStyle =
  | "openai-decisions"
  | "perplexity-decisions"
  | "system-one"
  | "cloudflare-system-one"
  | "microsoft-system-one";

export type Question =
  | {
      type: "bool";
      instructions: string;
      criteria?: { true?: string; false?: string };
    }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "box"; instructions: string };

export type Answer =
  | { type: "bool"; probability: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
      /** Present when probabilities cover one internally processed batch, not the full list. */
      probabilityScope?: "batch";
      noneOfAboveProbability?: number;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      probabilities?: Record<string, number>;
    }
  | {
      type: "box";
      box: { top: number; bottom: number; left: number; right: number };
      confidence: number;
    }
  | { type: "refusal" }
  | { type: "no_match" }
  | { type: "ambiguous" };

export interface ClassifyParams {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, Question>;
  /** Regular PNG/JPEG/WebP files inside cwd; attached in this order. */
  images?: string[];
}

export type ClassificationTreeNode = {
  id: string;
  description?: string;
  children?: ClassificationTreeNode[];
};

export type ClassificationTree = { roots: ClassificationTreeNode[] };

export type ClassifyTreeParams = {
  state: ClassifyParams["state"];
  tree: string | ClassificationTree;
  instructions?: string;
  images?: string[];
};

export type TreeStep = {
  level: number;
  id: string;
  source: "automatic" | "model";
  confidence?: number;
  probabilityScope?: "siblings" | "batch";
  noneOfAboveProbability?: number;
};

export type ClassifierTreeResult = {
  provider: string;
  model: string;
  status: "complete" | "no_match" | "ambiguous" | "refusal";
  levels: Record<string, string>;
  steps: TreeStep[];
  providerCalls: number;
  cost: ClassifierCost;
  usage?: NonNullable<ClassifierResult["usage"]>;
  attemptedRoutes?: ClassifierRoute[];
};

export interface ModelDefinition {
  id: string;
  name?: string;
  input?: ("text" | "image")[];
  box?: boolean;
}

/** USD per million tokens. Cache counts, when reported, are part of input tokens. */
export type TokenPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
};

export type ClassifierCost =
  | {
      status: "estimated";
      currency: "USD";
      input: number;
      output: number;
      total: number;
      source: "builtin" | "configured";
      rates: TokenPricing;
    }
  | {
      status: "estimated";
      currency: "USD";
      input: number;
      output: number;
      total: number;
      source: "aggregated";
    }
  | {
      status: "unavailable";
      currency: "USD";
      reason:
        | "unknown_pricing"
        | "missing_usage"
        | "invalid_usage"
        | "missing_cache_pricing"
        | "calculation_overflow";
    };

export interface ProviderSettings {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  accountId?: string;
  experimentalImages?: boolean;
  experimentalBox?: boolean;
  /** Model ID (or Azure deployment name) to explicit token rates. */
  pricing?: Record<string, TokenPricing>;
  /** Verified wire choice limit; needed for batching on endpoints without a known limit. */
  maxChoices?: number;
}

export interface CustomProviderSettings extends ProviderSettings {
  api: ApiStyle;
  models: ModelDefinition[];
}

export type ClassifierRoute = {
  provider: string;
  model: string;
};

export interface ClassifierSettings {
  none_of_above_choice?: boolean;
  remove_choice_limits?: boolean;
  default?: ClassifierRoute;
  fallback?: ClassifierRoute[];
  compare?: ClassifierRoute[];
  defaultProvider?: string;
  defaultModel?: string;
  requestTimeoutMs?: number;
  providers?: Record<string, ProviderSettings>;
  customProviders?: Record<string, CustomProviderSettings>;
}

export interface ResolvedModel {
  route: string;
  provider: string;
  model: string;
  api: ApiStyle;
  baseUrl: string;
  headers: Record<string, string>;
  configuredApiKey?: string;
  credentialProvider: string;
  envVar?: string;
  images: boolean;
  box: boolean;
  experimentalImages: boolean;
  requestTimeoutMs: number;
  pricing?: { rates: TokenPricing; source: "builtin" | "configured" };
  maxChoices?: number;
}

export interface PreparedImage {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
}

export interface PreparedInput {
  state: ClassifyParams["state"];
  questions: Record<string, Question>;
  images: PreparedImage[];
}

export type ClassifierResult = {
  provider: string;
  model: string;
  answers: Record<string, Answer>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  };
  /** Successful provider requests made by automatic choice processing. */
  providerCalls?: number;
  /** Estimate for completed requests in this result, not an invoice or total of failed attempts. */
  cost: ClassifierCost;
  requestId?: string;
  attemptedRoutes?: ClassifierRoute[];
};

export type ClassifierComparisonEntry = ClassifierRoute & {
  durationMs: number;
} & (
  | { status: "success"; result: ClassifierResult }
  | { status: "error"; error: { code: string; message: string } }
);

export type ClassifierComparisonResult = {
  results: ClassifierComparisonEntry[];
  cancelled: boolean;
};

export class ClassifierError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function userError(error: unknown): string {
  return error instanceof ClassifierError
    ? error.message
    : "Classification failed unexpectedly. Check the selected provider configuration.";
}
