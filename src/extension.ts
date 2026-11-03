import { isProjectTrusted } from "@amaster.ai/pi-shared/settings";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { classify, compareClassifiers } from "./classify.js";
import {
  CLASSIFY_COMPARE_TOOL,
  CLASSIFY_COMPARE_TOOL_DESCRIPTION,
  CLASSIFY_TOOL,
  CLASSIFY_TOOL_DESCRIPTION,
  CLASSIFY_TREE_TOOL,
  CLASSIFY_TREE_TOOL_DESCRIPTION,
  classifyCompareOutput,
  classifyOutput,
  classifyParameters,
  classifyTreeOutput,
  classifyTreeParameters,
} from "./tool-contracts.js";
import { classifyTree } from "./tree.js";
import { registerBoxTool } from "./box-tool.js";
import { registerComputerUseTool } from "./computer-use-tool.js";
import {
  configuredRoutes,
  listModels,
  loadClassifierSettings,
  resolveModel,
} from "./config.js";
import { updateProjectClassifierSettings } from "./settings-write.js";
import { ClassifierError, userError } from "./types.js";

// Re-exported so existing deep imports from "./extension.js" keep working.
export {
  classifyCompareOutput,
  classifyOutput,
  classifyParameters,
  classifyTreeOutput,
  classifyTreeParameters,
};

// Tool names, descriptions, parameters and result schemas are shared with the
// native Durable factory through ./tool-contracts.js so the two surfaces cannot drift.
// Pi-only registration fields (label, prompt guidance, annotations, outputSchema)
// stay with these desktop registrations.

export default function piClassifier(pi: ExtensionAPI): void {
  registerBoxTool(pi);
  registerComputerUseTool(pi);
  pi.registerTool(
    defineTool({
      name: CLASSIFY_TOOL,
      label: "Classify",
      description: CLASSIFY_TOOL_DESCRIPTION,
      promptSnippet:
        "Classify text, JSON or supported images into typed probabilistic decisions.",
      promptGuidelines: [
        "Use for bounded judgments, classification and rubric scoring, not open-ended prose.",
        "Treat low confidence as uncertainty, not permission to switch models or retry. Only configured remove_choice_limits with none_of_above_choice permits internal sequential choice batches; this is first-match selection, not a global ranking.",
        "Handle no_match and ambiguous answers explicitly. probabilityScope=batch and noneOfAboveProbability describe only the winning batch; they are not a full-list probability distribution.",
        "Send only data the user intends to share with the configured provider.",
        "Ask /classifier status for the active model. Do not change provider settings without user direction.",
      ],
      parameters: classifyParameters,
      outputSchema: classifyOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const result = await classify(params, {
            settings: loadClassifierSettings(ctx.cwd, isProjectTrusted(ctx)),
            cwd: ctx.cwd,
            ...(signal ? { signal } : {}),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
            structuredContent: { ...result },
          };
        } catch (error) {
          console.error(
            "[pi-classifier] classify failed: " +
              (error instanceof ClassifierError ? error.code : "unexpected"),
          );
          throw new Error(userError(error));
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: CLASSIFY_COMPARE_TOOL,
      label: "Compare classifiers",
      description: CLASSIFY_COMPARE_TOOL_DESCRIPTION,
      promptSnippet:
        "Compare configured decision models only when the user explicitly requests a model comparison.",
      promptGuidelines: [
        "Use only when the user explicitly asks to compare classifier models; never use automatically for low confidence or refusals.",
        "Each configured comparison route receives the submitted data and may incur a charge.",
      ],
      parameters: classifyParameters,
      outputSchema: classifyCompareOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const result = await compareClassifiers(params, {
            settings: loadClassifierSettings(ctx.cwd, isProjectTrusted(ctx)),
            cwd: ctx.cwd,
            ...(signal ? { signal } : {}),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
            structuredContent: { ...result },
          };
        } catch (error) {
          throw new Error(userError(error));
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: CLASSIFY_TREE_TOOL,
      label: "Classify tree",
      description: CLASSIFY_TREE_TOOL_DESCRIPTION,
      promptSnippet: "Classify through a supplied classification tree and return the selected levels.",
      promptGuidelines: [
        "Use classify_tree only when the user supplies or requests a classification tree; do not invent category branches.",
        "Use meaningful node descriptions. Only the current siblings and selected parent path are submitted per decision, not every descendant.",
        "Inspect status and steps: automatic steps have no model confidence, and partial paths are not complete classifications.",
        "Configured choice batching may cause multiple billable requests per level. No fallback may replay completed model decisions.",
      ],
      parameters: classifyTreeParameters,
      outputSchema: classifyTreeOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      async execute(_id, params, signal, _onUpdate, ctx) {
        try {
          const result = await classifyTree(params, {
            settings: loadClassifierSettings(ctx.cwd, isProjectTrusted(ctx)),
            cwd: ctx.cwd,
            ...(signal ? { signal } : {}),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: result,
            structuredContent: { ...result },
          };
        } catch (error) {
          throw new Error(userError(error));
        }
      },
    }),
  );

  pi.registerCommand("classifier", {
    description:
      "Classifier: status, list, reload, use <route> <model>, compare <JSON params>. Use writes trusted project defaults; compare makes potentially billable calls.",
    handler: async (args, ctx) => {
      try {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const command = parts[0] ?? "status";
        const settings = loadClassifierSettings(ctx.cwd, isProjectTrusted(ctx));
        if (command === "compare") {
          let params: unknown;
          try {
            params = JSON.parse(args.trim().slice("compare".length).trim());
          } catch {
            throw new ClassifierError(
              "input",
              "Usage: /classifier compare <JSON with state, questions and optional images>.",
            );
          }
          const result = await compareClassifiers(params, {
            settings,
            cwd: ctx.cwd,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          });
          reply(pi, ctx, JSON.stringify(result, null, 2));
        } else if (command === "list" && parts.length === 1) {
          reply(
            pi,
            ctx,
            listModels(settings) +
              "\n\nFallback: " +
              JSON.stringify(configuredRoutes(settings, "fallback")) +
              "\nCompare: " +
              JSON.stringify(configuredRoutes(settings, "compare")),
          );
        } else if (
          (command === "status" || command === "reload") &&
          parts.length <= 1
        ) {
          const route = resolveModel(settings);
          reply(
            pi,
            ctx,
            JSON.stringify(
              {
                provider: route.route,
                model: route.model,
                images: route.images,
                box: route.box,
                requestTimeoutMs: route.requestTimeoutMs,
                none_of_above_choice: settings.none_of_above_choice ?? false,
                remove_choice_limits: settings.remove_choice_limits ?? false,
                maxChoicesPerRequest: route.maxChoices ?? "provider-defined",
                authentication: "API key only; independent of chat login",
                fallback: configuredRoutes(settings, "fallback"),
                compare: configuredRoutes(settings, "compare"),
              },
              null,
              2,
            ),
          );
        } else if (command === "use" && parts.length === 3) {
          const selected = {
            ...settings,
            default: { provider: parts[1]!, model: parts[2]! },
          };
          const route = resolveModel(selected);
          await updateProjectClassifierSettings(
            ctx.cwd,
            isProjectTrusted(ctx),
            { default: { provider: route.route, model: route.model } },
          );
          reply(
            pi,
            ctx,
            "Selected " +
              route.route +
              " / " +
              route.model +
              " in project settings. Chat login is unchanged.",
          );
        } else {
          reply(
            pi,
            ctx,
            "Usage: /classifier status | list | reload | use <route> <model> | compare <JSON params>",
          );
        }
      } catch (error) {
        console.error(
          "[pi-classifier] command failed: " +
            (error instanceof ClassifierError ? error.code : "configuration"),
        );
        reply(
          pi,
          ctx,
          error instanceof ClassifierError
            ? error.message
            : "Could not update classifier settings. Check project trust and settings JSON.",
        );
      }
    },
  });
}

function reply(pi: ExtensionAPI, ctx: ExtensionContext, text: string): void {
  const bounded =
    text.length > 16000 ? text.slice(0, 16000) + "\n[truncated]" : text;
  if (ctx.hasUI) ctx.ui.notify(bounded, "info");
  else
    pi.sendMessage(
      { customType: "pi-classifier", content: bounded, display: true },
      { triggerTurn: false },
    );
}
