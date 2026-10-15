import { isProjectTrusted } from "@amaster.ai/pi-shared/settings";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classify } from "./classify.js";
import { listModels, loadClassifierSettings, resolveModel } from "./config.js";
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
        { minProperties: 1, maxProperties: 64 },
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
    ]),
  ),
  usage: Type.Optional(
    Type.Object({
      inputTokens: Type.Number(),
      outputTokens: Type.Number(),
      totalTokens: Type.Number(),
    }),
  ),
  requestId: Type.Optional(Type.String()),
});

export default function piClassifier(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: "classify",
      label: "Classify",
      description:
        "Ask a decision model typed questions about text, JSON and supported local images. Returns bool probabilities, choices with probabilities, or scores. Experimental box answers require explicit Jev configuration. Provider/model are fixed by pi-classifier.defaultProvider/defaultModel; this tool cannot override them. API-key authentication is independent of Codex chat login. Exactly one provider request: no retries or fallbacks. Use /classifier list or status to inspect configuration.",
      promptSnippet:
        "Classify text, JSON or supported images into typed probabilistic decisions.",
      promptGuidelines: [
        "Use for bounded judgments, classification and rubric scoring, not open-ended prose.",
        "Treat low confidence as uncertainty, not permission to switch models or retry.",
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

  pi.registerCommand("classifier", {
    description:
      "Classifier configuration: status, list, reload, use <route> <model> (writes trusted project settings).",
    handler: async (args, ctx) => {
      try {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const command = parts[0] ?? "status";
        const settings = loadClassifierSettings(ctx.cwd, isProjectTrusted(ctx));
        if (command === "list" && parts.length === 1) {
          reply(pi, ctx, listModels(settings));
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
                authentication: "API key only; independent of chat login",
                fallback: false,
              },
              null,
              2,
            ),
          );
        } else if (command === "use" && parts.length === 3) {
          const selected = {
            ...settings,
            defaultProvider: parts[1]!,
            defaultModel: parts[2]!,
          };
          const route = resolveModel(selected);
          await updateProjectClassifierSettings(
            ctx.cwd,
            isProjectTrusted(ctx),
            { defaultProvider: route.route, defaultModel: route.model },
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
            "Usage: /classifier status | list | reload | use <route> <model>",
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
