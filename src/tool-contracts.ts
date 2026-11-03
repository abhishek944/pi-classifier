import { Type } from "typebox";

/**
 * Tool names, descriptions and argument/result schemas shared by the Pi desktop extension and the
 * native Durable factory. Both surfaces must accept and report exactly the same contract, so these
 * live here rather than in either adapter. Pi-only registration fields (label, prompt guidance,
 * annotations, outputSchema) stay with the desktop registrations.
 */

export const CLASSIFY_TOOL = "classify";
export const CLASSIFY_COMPARE_TOOL = "classify_compare";
export const CLASSIFY_TREE_TOOL = "classify_tree";
export const CLASSIFIER_BOX_TOOL = "classifier_box_image";

export const CLASSIFY_TOOL_DESCRIPTION =
  "Ask a decision model typed questions about text, JSON and supported images. Legacy image paths are shared; named path/url descriptors require explicit {$image:id} references. Jev supports images in instructions/criteria; OpenAI supports instruction images and hosted URLs. Unsupported placements fail locally. Returns bool probabilities, choices with probabilities, or scores, plus reported token usage and estimated USD cost (or an explicit unavailable reason). Experimental box answers require explicit Jev configuration. Provider/model are fixed by pi-classifier.default (or legacy defaultProvider/defaultModel); this tool cannot override them. API-key authentication is independent of Codex chat login. Only explicitly configured fallback routes may be used after a missing key or HTTP 401/404/429 before any batch has completed; never after uncertainty, refusals, timeouts or network failures. Use /classifier list or status to inspect configuration.";

export const CLASSIFY_COMPARE_TOOL_DESCRIPTION =
  "Explicitly compare the same typed questions and state using exactly pi-classifier.compare provider/model pairs. Each entry makes potentially billable requests, including multiple requests when choice batching is configured. No fallback, default substitution, provider/model overrides, or default changes. Returns labeled results, duration, usage, estimated USD costs (or unavailable reasons) and safe per-entry failures; cancellation retains completed results and prevents later requests.";

export const CLASSIFY_TREE_TOOL_DESCRIPTION =
  "Classify text, JSON or supported images through a nested classification tree. tree is an inline roots/id/description/children object or a local JSON file inside cwd. Choose among siblings, automatically follow sole children without model calls, and return Level1/Level2/etc under levels with per-step provenance, total providerCalls, reported usage and estimated USD cost. NONE, batching and initial fallback follow configured settings; after a successful decision the route is pinned. no_match, ambiguous and refusal retain only the selected prefix. Automatic steps are structural, not model confirmation; greedy traversal is not a global best-path guarantee. No provider/model override or comparison.";

export const CLASSIFIER_BOX_TOOL_DESCRIPTION =
  "Render a normalized bounding box on a local image, or crop to it, entirely locally. Use to inspect a box answer from classify. overlay keeps the image and draws a rectangle; crop returns only the clamped region. Returns a PNG plus exact source-pixel box metadata. No provider request, upload, resizing or disk write. A box is a localization hint, not proof that the object exists.";

const imageReference = Type.Object(
  { $image: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }) },
  { additionalProperties: false },
);

function imageContent(maxLength: number, nonempty = false) {
  return Type.Union([
    Type.String({ maxLength, ...(nonempty ? { minLength: 1 } : {}) }),
    Type.Array(Type.Union([Type.String({ maxLength }), imageReference]), {
      minItems: 1,
      maxItems: 128,
      description:
        "Ordered text and explicit {$image:id} references. References require named images; supported placements depend on the route.",
    }),
  ]);
}

const shortText = imageContent(4096);
const instructionContent = imageContent(16384, true);

const question = Type.Union([
  Type.Object(
    {
      type: Type.Literal("bool"),
      instructions: instructionContent,
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
      instructions: instructionContent,
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
      instructions: instructionContent,
      criteria: Type.Array(imageContent(4096, true), {
        minItems: 2,
        maxItems: 10,
      }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("box"),
      instructions: instructionContent,
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
          "Text or JSON data to classify. Use explicit {$image:id} objects to place named images in state on Jev, OpenAI or Perplexity. Other JSON remains data. All questions refer to this same state.",
      },
    ),
    questions: Type.Record(
      Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
      question,
      { minProperties: 1, maxProperties: 32 },
    ),
    images: Type.Optional(
      Type.Array(
        Type.Union([
          Type.String({ minLength: 1, maxLength: 4096 }),
          Type.Object(
            {
              id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
              path: Type.String({ minLength: 1, maxLength: 4096 }),
            },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
              url: Type.String({ minLength: 1, maxLength: 4096 }),
            },
            { additionalProperties: false },
          ),
        ]),
        {
          maxItems: 8,
          description:
            "Legacy local paths are shared in order. Named {id,path} or {id,url} images must be referenced using {$image:id} in state or supported question content. URLs are OpenAI-only and sent to the provider, never fetched locally. No inline base64 or symlinks. Limits: Perplexity 8 images, Clef 4, others 5.",
        },
      ),
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
    children: Type.Optional(
      Type.Array(Type.Ref("#/$defs/ClassificationTreeNode")),
    ),
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
        {
          roots: Type.Array(Type.Ref("#/$defs/ClassificationTreeNode"), {
            minItems: 1,
          }),
        },
        { additionalProperties: false },
      ),
    ]),
    instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
    images: classifyParameters.properties.images,
  },
  {
    additionalProperties: false,
    $defs: { ClassificationTreeNode: classificationTreeNode },
  },
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

export const boxParameters = Type.Object(
  {
    image: Type.String({
      minLength: 1,
      maxLength: 4096,
      description:
        "Local PNG, JPEG or WebP file inside cwd. No URLs, symlinks or inline base64.",
    }),
    box: Type.Object(
      {
        top: Type.Number({ minimum: 0, maximum: 1 }),
        bottom: Type.Number({ minimum: 0, maximum: 1 }),
        left: Type.Number({ minimum: 0, maximum: 1 }),
        right: Type.Number({ minimum: 0, maximum: 1 }),
      },
      {
        additionalProperties: false,
        description:
          "Normalized edges between 0 and 1, with top < bottom and left < right.",
      },
    ),
    mode: Type.Optional(
      Type.Union([Type.Literal("overlay"), Type.Literal("crop")], {
        description:
          "overlay draws the box on the image (default); crop returns only the boxed region.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const boxOutput = Type.Object({
  mode: Type.Union([Type.Literal("overlay"), Type.Literal("crop")]),
  mimeType: Type.Literal("image/png"),
  width: Type.Integer({ minimum: 1 }),
  height: Type.Integer({ minimum: 1 }),
  pixelBox: Type.Object({
    left: Type.Integer({ minimum: 0 }),
    top: Type.Integer({ minimum: 0 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
  }),
  byteLength: Type.Integer({ minimum: 1 }),
});
