import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadPiSettings,
  resolveConfigDir,
} from "@amaster.ai/pi-shared/settings";
import { cloudflareAccountId } from "./auth.js";
import {
  ClassifierError,
  isRecord,
  type ApiStyle,
  type ClassifierSettings,
  type ModelDefinition,
  type ProviderSettings,
  type ResolvedModel,
} from "./types.js";

export const SETTINGS_KEY = "pi-classifier";
export const BUILT_INS = [
  {
    id: "openai",
    route: "openai-api",
    api: "openai-decisions",
    baseUrl: "https://api.openai.com/v1",
    credentialProvider: "openai",
    envVar: "OPENAI_API_KEY",
    models: [{ id: "gpt-6-luna", input: ["text", "image"] }],
  },
  {
    id: "perplexity",
    route: "perplexity-api",
    api: "perplexity-decisions",
    baseUrl: "https://api.perplexity.ai/v1",
    credentialProvider: "perplexity",
    envVar: "PERPLEXITY_API_KEY",
    models: [
      { id: "pplx-decider-v1.1-27b", input: ["text", "image"] },
      { id: "pplx-decider-v1-27b", input: ["text", "image"] },
    ],
  },
  {
    id: "typesafe",
    route: "typesafe-api",
    api: "system-one",
    baseUrl: "https://api.typesafe.ai/v1",
    credentialProvider: "typesafe",
    envVar: "TYPESAFE_API_KEY",
    models: [
      { id: "jev-latest", input: ["text", "image"] },
      { id: "jev-1.13.0", input: ["text", "image"] },
      { id: "jev-preview", input: ["text", "image"], box: true },
      { id: "jev-1.14.0", input: ["text", "image"], box: true },
    ],
  },
  {
    id: "cloudflare",
    route: "cloudflare-api",
    api: "cloudflare-system-one",
    baseUrl: "",
    credentialProvider: "cloudflare-workers-ai",
    envVar: "CLOUDFLARE_API_KEY",
    models: [
      { id: "@cf/cloudflare/clef", input: ["text", "image"] },
      { id: "@cf/cloudflare/clef-flash", input: ["text", "image"] },
      { id: "typesafe/jev" },
    ],
  },
  {
    id: "openrouter",
    route: "openrouter-api",
    api: "system-one",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialProvider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    models: [{ id: "typesafe/jev-1.13" }, { id: "~typesafe/jev-latest" }],
  },
] satisfies Array<{
  id: string;
  route: string;
  api: ApiStyle;
  baseUrl: string;
  credentialProvider: string;
  envVar: string;
  models: ModelDefinition[];
}>;

export function loadClassifierSettings(
  cwd: string,
  projectTrusted = false,
): ClassifierSettings {
  try {
    // The shared loader is forgiving; malformed layers must not silently select a different route.
    const paths = new Set([
      join(resolveConfigDir(join(homedir(), ".pi", "agent")), "settings.json"),
      join(resolveConfigDir(), "settings.json"),
      ...(projectTrusted ? [join(cwd, ".pi", "settings.json")] : []),
    ]);
    for (const path of paths) validateSettingsLayer(path);
    const settings = loadPiSettings<ClassifierSettings>(SETTINGS_KEY, {
      cwd,
      projectTrusted,
      strictProjectSettings: true,
    });
    if (!isRecord(settings)) throw new Error();
    return settings;
  } catch (error) {
    if (error instanceof ClassifierError) throw error;
    throw new ClassifierError(
      "configuration",
      "Could not load pi-classifier settings. Check that the namespace contains a valid JSON object.",
    );
  }
}

function validateSettingsLayer(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (text.charCodeAt(0) === 0xfeff)
    configuration(
      "pi-classifier settings require UTF-8 without a BOM. Remove the BOM from settings.json; no alternate configuration was used.",
    );
  const root: unknown = JSON.parse(text);
  if (
    !isRecord(root) ||
    (Object.hasOwn(root, SETTINGS_KEY) && !isRecord(root[SETTINGS_KEY]))
  )
    configuration(
      "Settings and the pi-classifier namespace must be JSON objects, not null or arrays.",
    );
}

function configuration(message: string): never {
  throw new ClassifierError("configuration", message);
}

export function validateBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch {
    return configuration(
      "Provider baseUrl must be HTTPS (or loopback HTTP), without credentials, query or fragment.",
    );
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    return configuration(field + " must be a non-empty string.");
  return value.trim();
}

function headers(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (
    !isRecord(value) ||
    Object.entries(value).some(
      ([key, entry]) =>
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
        typeof entry !== "string" ||
        /[\r\n]/.test(entry),
    )
  ) {
    return configuration(
      "Provider headers must be a string map with valid HTTP header names and values.",
    );
  }
  const protectedNames = [
    "authorization",
    "content-type",
    "content-length",
    "host",
    "cookie",
    "proxy-authorization",
    "transfer-encoding",
    "connection",
  ];
  if (
    Object.values(value).some(
      (entry) => typeof entry === "string" && /\$\{?[A-Z_]/.test(entry),
    )
  )
    return configuration(
      "Resolve header environment references in global settings, not project settings.",
    );
  if (
    Object.keys(value).some((key) => protectedNames.includes(key.toLowerCase()))
  )
    return configuration(
      "Authentication and transport headers cannot be overridden.",
    );
  return value as Record<string, string>;
}

export function resolveModel(settings: ClassifierSettings): ResolvedModel {
  const routeId = optionalString(settings.defaultProvider, "defaultProvider");
  const modelId = optionalString(settings.defaultModel, "defaultModel");
  if (!routeId || !modelId)
    return configuration(
      "Set pi-classifier.defaultProvider and defaultModel, or run /classifier use <route> <model>.",
    );
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(routeId) ||
    modelId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(modelId)
  )
    return configuration(
      "Provider routes must be short identifiers and model IDs must be at most 256 characters without control characters.",
    );
  const builtIn = BUILT_INS.find(
    (entry) => entry.route === routeId || entry.id === routeId,
  );
  if (settings.providers !== undefined && !isRecord(settings.providers))
    return configuration("providers must be an object.");
  if (
    settings.customProviders !== undefined &&
    !isRecord(settings.customProviders)
  )
    return configuration("customProviders must be an object.");
  for (const name of Object.keys(settings.customProviders ?? {})) {
    if (BUILT_INS.some((entry) => entry.route === name || entry.id === name))
      return configuration("Custom providers cannot shadow built-in routes.");
  }
  const custom = builtIn ? undefined : settings.customProviders?.[routeId];
  if (!builtIn && !custom)
    return configuration("Unknown classifier provider route.");
  const raw: ProviderSettings = builtIn
    ? (settings.providers?.[builtIn.id] ?? {})
    : custom!;
  if (!isRecord(raw))
    return configuration("Provider settings must be an object.");
  const api = builtIn?.api ?? custom!.api;
  if (
    ![
      "openai-decisions",
      "perplexity-decisions",
      "system-one",
      "cloudflare-system-one",
    ].includes(api)
  )
    return configuration("Unsupported classifier API protocol.");
  const models: ModelDefinition[] = builtIn?.models ?? custom!.models;
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.some(
      (m) =>
        !isRecord(m) ||
        typeof m.id !== "string" ||
        !m.id.trim() ||
        (m.input !== undefined &&
          (!Array.isArray(m.input) ||
            m.input.some((x) => x !== "text" && x !== "image"))) ||
        (m.box !== undefined && typeof m.box !== "boolean"),
    )
  ) {
    return configuration(
      "Provider models must declare an id and optional text/image input capabilities.",
    );
  }
  const definition = models.find((entry) => entry.id === modelId);
  // Built-in API routes allow new text model IDs without a package release. Images require known capabilities.
  if (!definition && !builtIn)
    return configuration(
      "The selected model is not declared in customProviders.<id>.models.",
    );
  for (const flag of ["experimentalImages", "experimentalBox"] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean")
      return configuration(flag + " must be a boolean.");
  }
  let baseUrl = optionalString(raw.baseUrl, "baseUrl") ?? builtIn?.baseUrl;
  if (api === "cloudflare-system-one" && !baseUrl)
    baseUrl =
      "https://api.cloudflare.com/client/v4/accounts/" +
      cloudflareAccountId(optionalString(raw.accountId, "accountId")) +
      "/ai";
  if (!baseUrl) return configuration("Custom providers require a baseUrl.");
  const timeout = settings.requestTimeoutMs ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 300_000)
    return configuration("requestTimeoutMs must be between 100 and 300000.");
  if (raw.apiKey !== undefined && typeof raw.apiKey !== "string")
    return configuration("apiKey must be a string.");
  const configuredApiKey =
    typeof raw.apiKey === "string" ? raw.apiKey.trim() || undefined : undefined;
  if (configuredApiKey && /\$\{?|^!/.test(configuredApiKey))
    return configuration(
      "API-key references must be resolved in global settings; project settings cannot expand environment variables or execute commands.",
    );
  const isJevDirect = builtIn?.id === "typesafe";
  const result: ResolvedModel = {
    route: builtIn?.route ?? routeId,
    provider: builtIn?.id ?? routeId,
    model: modelId,
    api,
    baseUrl: validateBaseUrl(baseUrl),
    headers: headers(raw.headers),
    credentialProvider: builtIn?.credentialProvider ?? routeId,
    images:
      api === "system-one"
        ? Boolean(
            raw.experimentalImages && definition?.input?.includes("image"),
          )
        : Boolean(definition?.input?.includes("image")),
    box: Boolean(
      (isJevDirect || custom?.api === "system-one") &&
        definition?.box &&
        definition?.input?.includes("image") &&
        raw.experimentalBox &&
        raw.experimentalImages,
    ),
    experimentalImages: raw.experimentalImages === true,
    requestTimeoutMs: timeout,
  };
  if (configuredApiKey) result.configuredApiKey = configuredApiKey;
  if (builtIn?.envVar) result.envVar = builtIn.envVar;
  return result;
}

export function listModels(settings: ClassifierSettings): string {
  const lines = BUILT_INS.flatMap((provider) =>
    provider.models.map((model) => provider.route + "  " + model.id),
  );
  for (const [id, provider] of Object.entries(settings.customProviders ?? {})) {
    if (Array.isArray(provider?.models))
      for (const model of provider.models)
        if (typeof model?.id === "string")
          lines.push(JSON.stringify(id) + "  " + JSON.stringify(model.id));
  }
  return lines.join("\n");
}
