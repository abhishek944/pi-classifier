import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type {
  Extension,
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { classify, compareClassifiers } from "./classify.js";
import { classifyTree } from "./tree.js";
import { renderClassifierBox } from "./box.js";
import {
  CLASSIFIER_BOX_TOOL,
  CLASSIFIER_BOX_TOOL_DESCRIPTION,
  CLASSIFY_COMPARE_TOOL,
  CLASSIFY_COMPARE_TOOL_DESCRIPTION,
  CLASSIFY_TOOL,
  CLASSIFY_TOOL_DESCRIPTION,
  CLASSIFY_TREE_TOOL,
  CLASSIFY_TREE_TOOL_DESCRIPTION,
  boxParameters,
  classifyParameters,
  classifyTreeParameters,
} from "./tool-contracts.js";
import { userError, type ClassifierSettings } from "./types.js";

/**
 * Settings-only native Durable classifier extension.
 *
 * The factory accepts ordinary serializable settings at initialization and uses the
 * existing Node provider and file handling internally (the same operations as the
 * desktop entry). There are no admission, quota, authorization, credential-store, or
 * host callbacks: the model only supplies classification arguments, never a provider,
 * endpoint, credential, or local path outside the working directory.
 *
 * Provider credentials must be explicit: `providers.<id>.apiKey` (and
 * `providers.cloudflare.accountId` for Cloudflare) or the provider environment
 * variable. The native path never reads Pi settings files or Pi's stored API-key
 * credentials; it fails closed with the existing actionable error when no explicit
 * credential resolves.
 *
 * Per-call files (tree JSON, local images) resolve under `options.cwd`, the Durable
 * environment cwd, the conversation agent `cwd`, or the process cwd (in that order).
 * Cancellation follows the invocation `context.abortSignal`.
 *
 * `classifier_computer_use` is intentionally not registered here. It needs to invoke
 * the Cua Driver MCP tools between classifier decisions, and Durable 1.1.0 exposes no
 * generic tool-invocation API (a tool task requires an existing assistant entry and
 * call id), so the loop cannot run natively. No placeholder tool is shipped; use the
 * desktop extension for computer use.
 */

export type DurableClassifierOptions = {
  /** Preferred working directory; falls back to the Durable environment cwd, the conversation agent cwd, then the process cwd. */
  cwd?: string;
};

/** Settings are plain data: clone once, then deep-freeze so calls cannot observe later mutation. */
function freezeSettings(settings: ClassifierSettings): ClassifierSettings {
  const copy = structuredClone(settings);
  const freeze = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const child of Object.values(node)) freeze(child);
    Object.freeze(node);
  };
  freeze(copy);
  return copy;
}

async function resolveCwd(
  api: ToolExecutionApi,
  context: Context,
  configured?: string,
): Promise<string> {
  if (configured?.trim()) return configured;
  const envCwd = api.env?.cwd;
  if (typeof envCwd === "string" && envCwd.trim()) return envCwd;
  try {
    const agent = await api.agent(context);
    if (agent.cwd?.trim()) return agent.cwd;
  } catch {
    // Agent metadata is observational; fall through to the process cwd.
  }
  return process.cwd();
}

function toJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Native classifier tools through the existing operations with explicit credentials only. */
export function createClassifierExtension(
  settings: ClassifierSettings,
  options: DurableClassifierOptions = {},
): Extension {
  const frozenSettings = freezeSettings(settings);
  const { cwd: configuredCwd } = options;

  const classifyTool = defineTool({
    name: CLASSIFY_TOOL,
    description: CLASSIFY_TOOL_DESCRIPTION,
    parameters: classifyParameters,
    replay: "unsafe",
    executionMode: "parallel",
    async execute(args, api, context) {
      const cwd = await resolveCwd(api, context, configuredCwd);
      try {
        const result = await classify(args, {
          settings: frozenSettings,
          cwd,
          credentialSource: "explicit",
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: toJson(result),
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: "classify failed: " + userError(error) },
          ],
        };
      }
    },
  });

  const compareTool = defineTool({
    name: CLASSIFY_COMPARE_TOOL,
    description: CLASSIFY_COMPARE_TOOL_DESCRIPTION,
    parameters: classifyParameters,
    replay: "unsafe",
    executionMode: "parallel",
    async execute(args, api, context) {
      const cwd = await resolveCwd(api, context, configuredCwd);
      try {
        const result = await compareClassifiers(args, {
          settings: frozenSettings,
          cwd,
          credentialSource: "explicit",
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: toJson(result),
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "classify_compare failed: " + userError(error),
            },
          ],
        };
      }
    },
  });

  const treeTool = defineTool({
    name: CLASSIFY_TREE_TOOL,
    description: CLASSIFY_TREE_TOOL_DESCRIPTION,
    parameters: classifyTreeParameters,
    replay: "unsafe",
    executionMode: "parallel",
    async execute(args, api, context) {
      const cwd = await resolveCwd(api, context, configuredCwd);
      try {
        const result = await classifyTree(args, {
          settings: frozenSettings,
          cwd,
          credentialSource: "explicit",
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: toJson(result),
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: "classify_tree failed: " + userError(error) },
          ],
        };
      }
    },
  });

  const boxTool = defineTool({
    name: CLASSIFIER_BOX_TOOL,
    description: CLASSIFIER_BOX_TOOL_DESCRIPTION,
    parameters: boxParameters,
    // Pure local render: no provider request, upload, or disk write, so recovery may rerun it.
    replay: "safe",
    executionMode: "parallel",
    async execute(args, api, context) {
      const cwd = await resolveCwd(api, context, configuredCwd);
      try {
        const result = await renderClassifierBox(args, {
          cwd,
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        });
        const byteLength = Buffer.from(result.data, "base64").byteLength;
        const details = {
          mode: result.mode,
          mimeType: result.mimeType,
          width: result.width,
          height: result.height,
          pixelBox: { ...result.pixelBox },
          byteLength,
        };
        const box = result.pixelBox;
        return {
          content: [
            {
              type: "text",
              text:
                "Rendered " +
                result.mode +
                " box as a " +
                result.width +
                "×" +
                result.height +
                " PNG (" +
                byteLength +
                " bytes). Source pixel box: left=" +
                box.left +
                ", top=" +
                box.top +
                ", width=" +
                box.width +
                ", height=" +
                box.height +
                ". A box is a localization hint, not proof that the object exists.",
            },
            {
              type: "image",
              data: result.data,
              mimeType: result.mimeType,
            },
          ],
          details: toJson(details),
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "classifier_box_image failed: " + userError(error),
            },
          ],
        };
      }
    },
  });

  return defineExtension({
    name: "classifier",
    tools: [classifyTool, compareTool, treeTool, boxTool],
  });
}

export type { ToolExecutionResult } from "@earendil-works/pi-durable";
