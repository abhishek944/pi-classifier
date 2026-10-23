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
  | { type: "refusal" };

export interface ClassifyParams {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, Question>;
  /** Regular PNG/JPEG/WebP files inside cwd; attached in this order. */
  images?: string[];
}

export interface ModelDefinition {
  id: string;
  name?: string;
  input?: ("text" | "image")[];
  box?: boolean;
}

export interface ProviderSettings {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  accountId?: string;
  experimentalImages?: boolean;
  experimentalBox?: boolean;
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
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
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
