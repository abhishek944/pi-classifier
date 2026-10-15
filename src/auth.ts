import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { ClassifierError, type ResolvedModel } from "./types.js";

/** Read the API-key entry only. Never resolve OAuth or mutate Pi's login state. */
export function storedApiCredential(provider: string) {
  try {
    const value = readStoredCredential(provider);
    return value?.type === "api_key" ? value : undefined;
  } catch {
    throw new ClassifierError(
      "credentials",
      "Could not read Pi API-key credentials.",
    );
  }
}

function storedValue(
  value: string | undefined,
  env: Record<string, string> = {},
): string | undefined {
  if (!value?.trim()) return undefined;
  value = value.trim();
  if (value.startsWith("!")) {
    throw new ClassifierError(
      "credentials",
      "Stored API-key shell commands are not supported. Use a literal key or an environment reference.",
    );
  }
  let missing = false;
  const resolved = value.replace(
    /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced: string | undefined, bare: string | undefined) => {
      if (match === "$$") return "$";
      if (match === "$!") return "!";
      const name = braced ?? bare ?? "";
      const replacement = env[name] ?? process.env[name];
      if (!replacement) missing = true;
      return replacement ?? "";
    },
  );
  return missing ? undefined : resolved.trim() || undefined;
}

export function resolveApiKey(route: ResolvedModel): string {
  if (route.configuredApiKey) return route.configuredApiKey;
  const credential = storedApiCredential(route.credentialProvider);
  const key =
    storedValue(credential?.key, credential?.env) ??
    (route.envVar ? process.env[route.envVar]?.trim() : undefined);
  if (!key) {
    throw new ClassifierError(
      "credentials",
      "No API key is configured for the selected classifier. Set providers.<id>.apiKey, save an API-key credential in Pi, or set the provider environment variable. Codex/OAuth tokens are not used.",
    );
  }
  return key;
}

export function cloudflareAccountId(configured: string | undefined): string {
  const stored = configured
    ? undefined
    : storedApiCredential("cloudflare-workers-ai");
  const id =
    configured?.trim() ??
    storedValue(stored?.env?.CLOUDFLARE_ACCOUNT_ID, stored?.env) ??
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new ClassifierError(
      "configuration",
      "Cloudflare requires a valid accountId or CLOUDFLARE_ACCOUNT_ID.",
    );
  }
  return id;
}
