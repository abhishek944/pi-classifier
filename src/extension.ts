import { isProjectTrusted } from "@amaster.ai/pi-shared/settings";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classify, compareClassifiers } from "./classify.js";
import { classifyTree } from "./tree.js";
import {
  configuredRoutes,
  listModels,
  loadClassifierSettings,
  resolveModel,
} from "./config.js";
import { updateProjectClassifierSettings } from "./settings-write.js";
import { ClassifierError, userError } from "./types.js";

const shortText = Type.String({ maxLength: 4096 });
const question = Type.Union([
  Type.Object(
    {
      type: Type.Literal("bool"),
      instructions: Type.String({ minLength: 1, maxLength: 16384 }),
      criteria: Type.Optional(
        Type.Object(
          { true: Type.Optional(shortText), false: Type.Optional(shortText) },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("choice"),
      instructions: Type.String({ minLength: 1, maxLength: 16384 }),
      criteria: Type.Record(
        Type.String({ minLength: 1, maxLength: 128 }),
        shortText,
        { minProperties: 1 },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("score"),
      instructions: Type.String({ minLength: 1, maxLength: 16384 }),
      criteria: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 2,
        maxItems: 10,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("box"),
      instructions: Type.String({ minLength: 1, maxLength: 16384 }),
    },
    { additionalProperties: false },
  ),
]);

export const classifyParameters = Type.Object(
  {
    state: Type.Union(
      [
        Type.String(),
        Type.Record(Type.String(), Type.Unknown()),
        Type.Array(Type.Unknown()),
      ],
      {
        description:
          "Text or JSON data to classify. All questions refer to this same state.",
      },
    ),
    questions: Type.Record(
      Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
      question,
      { minProperties: 1, maxProperties: 32 },
    ),
    images: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        maxItems: 5,
        description:
          "Local PNG/JPEG/WebP files inside cwd, in order. No URLs, symlinks or inline base64. Requires an image-capable model.",
      }),
    ),
  },
  { additionalProperties: false },
);

const tokenPricing = Type.Object({
  inputPerMillion: Type.Number({ minimum: 0 }),
  outputPerMillion: Type.Number({ minimum: 0 }),
  cachedInputPerMillion: Type.Optional(Type.Number({ minimum: 0 })),
  cacheWritePerMillion: Type.Optional(Type.Number({ minimum: 0 })),
});

export const classifyOutput = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  answers: Type.Record(
    Type.String(),
    Type.Union([
      Type.Object({
        type: Type.Literal("bool"),
        probability: Type.Number({ minimum: 0, maximum: 1 }),
      }),
      Type.Object({
        type: Type.Literal("choice"),
        choice: Type.String(),
        probabilities: Type.Record(
          Type.String(),
          Type.Number({ minimum: 0, maximum: 1 }),
        ),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        probabilityScope: Type.Optional(Type.Literal("batch")),
        noneOfAboveProbability: Type.Optional(
          Type.Number({ minimum: 0, maximum: 1 }),
        ),
      }),
      Type.Object({
        type: Type.Literal("score"),
        score: Type.Number(),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
        probabilities: Type.Optional(
          Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 })),
        ),
      }),
      Type.Object({
        type: Type.Literal("box"),
        box: Type.Object({
          top: Type.Number(),
          bottom: Type.Number(),
          left: Type.Number(),
          right: Type.Number(),
        }),
        confidence: Type.Number({ minimum: 0, maximum: 1 }),
      }),
      Type.Object({ type: Type.Literal("refusal") }),
      Type.Object({ type: Type.Literal("no_match") }),
      Type.Object({ type: Type.Literal("ambiguous") }),
    ]),
  ),
  providerCalls: Type.Optional(Type.Integer({ minimum: 1 })),
  usage: Type.Optional(
    Type.Object({
      inputTokens: Type.Number(),
      outputTokens: Type.Number(),
      totalTokens: Type.Number(),
      cachedInputTokens: Type.Optional(Type.Number()),
      cacheWriteTokens: Type.Optional(Type.Number()),
    }),
  ),
  cost: Type.Union([
    Type.Object({
      status: Type.Literal("estimated"),
      currency: Type.Literal("USD"),
      input: Type.Number({ minimum: 0 }),
      output: Type.Number({ minimum: 0 }),
      total: Type.Number({ minimum: 0 }),
      source: Type.Union([Type.Literal("builtin"), Type.Literal("configured")]),
      rates: tokenPricing,
    }),
    Type.Object({
      status: Type.Literal("estimated"),
      currency: Type.Literal("USD"),
      input: Type.Number({ minimum: 0 }),
      output: Type.Number({ minimum: 0 }),
      total: Type.Number({ minimum: 0 }),
      source: Type.Literal("aggregated"),
    }),
    Type.Object({
      status: Type.Literal("unavailable"),
      currency: Type.Literal("USD"),
      reason: Type.Union([
        Type.Literal("unknown_pricing"),
        Type.Literal("missing_usage"),
        Type.Literal("invalid_usage"),
        Type.Literal("missing_cache_pricing"),
        Type.Literal("calculation_overflow"),
      ]),
    }),
  ]),
  requestId: Type.Optional(Type.String()),
  attemptedRoutes: Type.Optional(
    Type.Array(Type.Object({ provider: Type.String(), model: Type.String() })),
  ),
});

export const classifyCompareOutput = Type.Object({
  cancelled: Type.Boolean(),
  results: Type.Array(
    Type.Union([
      Type.Object({
        provider: Type.String(),
        model: Type.String(),
        durationMs: Type.Number(),
        status: Type.Literal("success"),
        result: classifyOutput,
      }),
      Type.Object({
        provider: Type.String(),
        model: Type.String(),
        durationMs: Type.Number(),
        status: Type.Literal("error"),
        error: Type.Object({ code: Type.String(), message: Type.String() }),
      }),
    ]),
  ),
});

const classificationTreeNode = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.Optional(Type.String({ maxLength: 4096 })),
    children: Type.Optional(Type.Array(Type.Ref("#/$defs/ClassificationTreeNode"))),
  },
  { additionalProperties: false },
);

export const classifyTreeParameters = Type.Object(
  {
    state: classifyParameters.properties.state,
    tree: Type.Union([
      Type.String({
        minLength: 1,
        maxLength: 4096,
        description: "Local UTF-8 JSON file inside cwd; no URLs or symlinks.",
      }),
      Type.Object(
        { roots: Type.Array(Type.Ref("#/$defs/ClassificationTreeNode"), { minItems: 1 }) },
        { additionalProperties: false },
      ),
    ]),
    instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
    images: classifyParameters.properties.images,
  },
  { additionalProperties: false, $defs: { ClassificationTreeNode: classificationTreeNode } },
);

export const classifyTreeOutput = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  status: Type.Union([
    Type.Literal("complete"),
    Type.Literal("no_match"),
    Type.Literal("ambiguous"),
    Type.Literal("refusal"),
  ]),
  levels: Type.Record(Type.String({ pattern: "^Level[1-9][0-9]*$" }), Type.String()),
  steps: Type.Array(
    Type.Object({
      level: Type.Integer({ minimum: 1 }),
      id: Type.String(),
      source: Type.Union([Type.Literal("automatic"), Type.Literal("model")]),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      probabilityScope: Type.Optional(
        Type.Union([Type.Literal("siblings"), Type.Literal("batch")]),
      ),
      noneOfAboveProbability: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1 }),
      ),
    }),
  ),
  providerCalls: Type.Integer({ minimum: 0 }),
  cost: classifyOutput.properties.cost,
  usage: classifyOutput.properties.usage,
  attemptedRoutes: classifyOutput.properties.attemptedRoutes,
});

export default function piClassifier(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "classify",
      label: "Classify",
      description:
        "Ask a decision model typed questions about text, JSON and supported local images. Returns bool probabilities, choices with probabilities, or scores, plus reported token usage and estimated USD cost (or an explicit unavailable reason). Experimental box answers require explicit Jev configuration. Provider/model are fixed by pi-classifier.default (or legacy defaultProvider/defaultModel); this tool cannot override them. API-key authentication is independent of Codex chat login. Only explicitly configured fallback routes may be used after a missing key or HTTP 401/404/429 before any batch has completed; never after uncertainty, refusals, timeouts or network failures. Use /classifier list or status to inspect configuration.",
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
      name: "classify_compare",
      label: "Compare classifiers",
      description:
        "Explicitly compare the same typed questions and state using exactly pi-classifier.compare provider/model pairs. Each entry makes potentially billable requests, including multiple requests when choice batching is configured. No fallback, default substitution, provider/model overrides, or default changes. Returns labeled results, duration, usage, estimated USD costs (or unavailable reasons) and safe per-entry failures; cancellation retains completed results and prevents later requests.",
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
      name: "classify_tree",
      label: "Classify tree",
      description:
        "Classify text, JSON or supported images through a nested classification tree. tree is an inline roots/id/description/children object or a local JSON file inside cwd. Choose among siblings, automatically follow sole children without model calls, and return Level1/Level2/etc under levels with per-step provenance, total providerCalls, reported usage and estimated USD cost. NONE, batching and initial fallback follow configured settings; after a successful decision the route is pinned. no_match, ambiguous and refusal retain only the selected prefix. Automatic steps are structural, not model confirmation; greedy traversal is not a global best-path guarantee. No provider/model override or comparison.",
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
