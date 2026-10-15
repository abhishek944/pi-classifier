import { resolveApiKey } from "./auth.js";
import { resolveModel } from "./config.js";
import { prepareInput } from "./inputs.js";
import { classifyWithProvider } from "./providers.js";
import {
  ClassifierError,
  type ClassifierResult,
  type ClassifierSettings,
} from "./types.js";
import { validateParams } from "./validation.js";

/** Exactly one configured provider call. Does not inspect or change the chat model/login. */
export async function classify(
  params: unknown,
  options: {
    settings: ClassifierSettings;
    cwd: string;
    signal?: AbortSignal;
  },
): Promise<ClassifierResult> {
  const input = validateParams(params);
  const route = resolveModel(options.settings);
  if (options.signal?.aborted)
    throw new ClassifierError("aborted", "Classification was cancelled.");
  const prepared = await prepareInput(
    input,
    route,
    options.cwd,
    options.signal,
  );
  const key = resolveApiKey(route);
  const result = await classifyWithProvider(
    route,
    prepared,
    key,
    options.signal,
  );
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > 40 * 1024)
    throw new ClassifierError(
      "response",
      "Classifier result exceeds the 40 KiB tool output limit. Ask fewer questions.",
    );
  return result;
}
