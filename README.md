# pi-classifier

A Pi extension for typed, probabilistic decisions across Microsoft Decision-1, OpenAI Decisions, Perplexity Decisions, TypeSafe Jev, Cloudflare Clef/Clef Flash and SystemOne-compatible gateways.

One configured default, optional selective fallback, and explicit model comparisons. No automatic retries or permission auto-approval.

## Install

Requires Node.js 22.19+ and Pi 1.2+. Install the tagged release from GitHub:

```sh
pi install git:github.com/abhishek944/pi-classifier@v0.4.0
```

The Pi package entrypoint is TypeScript source, so Git installs do not depend on committed build artifacts or a TypeScript compiler. Runtime dependencies are installed by Pi. The compiled `dist` exports remain available for library consumers after a build.

### Local development

From this package:

```sh
npm install
npm run build
pi -e ./dist/extension.js
```

To install persistently after trying it:

```sh
pi install /absolute/path/to/pi-classifier
```

The package version and Git tag are `0.4.0` / `v0.4.0`. Installation is explicit. This release is prepared for GitHub; npm publication is a separate manual step.

## Configuration: same shape as pi-image-gen

Use the `pi-classifier` namespace in Pi settings. Like `pi-image-gen`, route selection uses `default: { provider, model }`, optional ordered `fallback` pairs, and explicit `compare` pairs. Legacy `defaultProvider` and `defaultModel` remain supported when `default` is absent; a present but malformed `default` fails closed. No settings are automatically migrated; credentials/endpoints are nested under `providers.<provider-id>`. Default selection happens after settings layers are merged: if a user/agent layer has a nested `default`, a project's legacy default keys do not override it. Use a nested `default` in the project too; mixed-format per-layer normalization is not implemented. The two extensions have independent settings and do not change one another.

```json
{
  "pi-classifier": {
    "default": { "provider": "openai-api", "model": "gpt-6-luna" },
    "fallback": [{ "provider": "typesafe-api", "model": "jev-latest" }],
    "compare": [
      { "provider": "openai-api", "model": "gpt-6-luna" },
      { "provider": "typesafe-api", "model": "jev-latest" }
    ],
    "requestTimeoutMs": 30000,
    "providers": {
      "openai": { "apiKey": "${OPENAI_API_KEY}" },
      "perplexity": { "apiKey": "${PERPLEXITY_API_KEY}" },
      "typesafe": { "apiKey": "${TYPESAFE_API_KEY}" },
      "cloudflare": {
        "apiKey": "${CLOUDFLARE_API_KEY}",
        "accountId": "${CLOUDFLARE_ACCOUNT_ID}"
      },
      "openrouter": { "apiKey": "${OPENROUTER_API_KEY}" }
    }
  }
}
```

Put environment references and secrets in global/agent settings, not project settings. Global/agent environment interpolation follows `@amaster.ai/pi-shared/settings`. Trusted project settings override the namespace's top-level keys, but are never environment-expanded. Nested `providers` maps follow the shared loader's shallow-merge behavior. Untrusted project settings are ignored. Malformed settings or a null namespace fail closed. Settings must be UTF-8 without a BOM; unlike Pi's main loader, the shared extension loader does not support BOM-prefixed files, so this package reports an explicit error rather than silently using another configuration. Configure endpoint overrides only for services you trust: the selected endpoint receives the API key and submitted state.

Do not add placeholder API-key fields for keys you want loaded from Pi's credential store. Omit those fields instead.

### API-key selection, independent of Codex login

Credential priority is:

1. Non-empty `providers.<id>.apiKey` (or the custom provider's `apiKey`).
2. Pi's stored `api_key` credential for the provider, using Pi's own credential-store path.
3. The provider's environment variable.

OAuth credentials are never used as API keys, never refreshed by this extension, and never changed. You can remain logged in to Codex for chat while using `openai-api` for classifier calls. If the stored `openai` slot contains OAuth rather than an API key, the extension skips it and uses your configured or environment API key.

Pi keeps one credential per provider ID, not both OAuth and an API key in the same slot. An OpenAI key stored under `openai` is distinct from Codex login under `openai-codex`.

Stored API-key values support literal strings and `$NAME`/`${NAME}` references, including provider-scoped stored environment values before process environment values. A missing reference leaves the stored key unresolved rather than sending a partial key. Shell-command credentials are intentionally not executed. Credentials and headers are never printed by status/list. This stored-key support is an addition in the classifier package: the current image-gen API route reads configuration/environment keys, while its subscription route resolves Pi's OAuth login.

### Providers and models

| Route            | Provider settings key | Models                                                             | Environment key      |
| ---------------- | --------------------- | ------------------------------------------------------------------ | -------------------- |
| `microsoft-api` | `microsoft` | `Microsoft-Decision-1` (select your actual deployment name) | `AZURE_API_KEY` |
| `openai-api`     | `openai`              | `gpt-6-luna`                                                       | `OPENAI_API_KEY`     |
| `perplexity-api` | `perplexity`          | `pplx-decider-v1.2`, `pplx-decider-flash-v1.2`, latest aliases, legacy v1/v1.1 IDs                     | `PERPLEXITY_API_KEY` |
| `typesafe-api`   | `typesafe`            | `jev-latest`, `jev-1.13.0`, `jev-preview`, `jev-1.14.0`            | `TYPESAFE_API_KEY`   |
| `cloudflare-api` | `cloudflare`          | `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, `typesafe/jev` | `CLOUDFLARE_API_KEY` |
| `openrouter-api` | `openrouter`          | `typesafe/jev-1.13`, `~typesafe/jev-latest`                        | `OPENROUTER_API_KEY` |

Cloudflare also needs `providers.cloudflare.accountId`, the stored `cloudflare-workers-ai` API-key credential's `env.CLOUDFLARE_ACCOUNT_ID`, or `CLOUDFLARE_ACCOUNT_ID`, in that order. Its stored API token lives under `cloudflare-workers-ai`, not `cloudflare`.

A provider's `baseUrl` replaces the API root (before `decisions`, `systemone`, Microsoft's `providers/microsoft/v1/systemone`, or Cloudflare's run path). Authentication/transport headers cannot be overridden. Custom headers are supported. HTTPS is required except for loopback HTTP.

New text model IDs on built-in routes can be selected without a package release. They must actually implement that route's API; a normal chat model is not a decision model. New image capabilities require a known model or explicit custom model declaration.

## Use

```text
/classifier list
/classifier status
/classifier use cloudflare-api @cf/cloudflare/clef-flash
/classifier reload
```

`use` writes only the nested `default` into trusted project `.pi/settings.json`, removing local legacy default keys and preserving unrelated settings, `fallback`, and `compare`. The project must be trusted. All calls load current settings, so `reload` validates and displays the current route rather than maintaining a separate configuration cache. To change global defaults, edit the global `pi-classifier` settings.

The model calls:

```js
classify({
  state: { ticket: "Checkout fails for every customer." },
  questions: {
    urgent: { type: "bool", instructions: "Is this urgent?" },
    team: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Charges and refunds",
        engineering: "Errors and outages",
      },
    },
    severity: {
      type: "score",
      instructions: "How severe is the customer impact?",
      criteria: ["Minor", "Major", "Critical"],
    },
  },
});
```

The tool takes no provider/model parameter. Its structured result identifies the configured route and model, typed answers, reported token usage, estimated USD cost (or an explicit unavailable reason) and an available request ID. `bool.probability` is the probability of true; `choice` includes a probability per label and confidence; `score` is a probability-weighted level index (starting at zero), not necessarily an integer. Refusals are explicit typed answers. Token counts are reported when available. Each successful result includes `cost`; classifier spending is not added to Pi's session billing totals. See [Per-call costs](#per-call-costs).

Provider results are checked for probability ranges/distribution sums and decision consistency (selected choices must be most likely; supplied score distributions must match the expected score within rounding tolerance). Low confidence is a valid answer, not an error. Calibrate thresholds on your own data; scores from different providers are not interchangeable.

## Classification trees: `classify_tree`

Use `classify_tree` to follow a **nested classification tree**, rather than supply every leaf as one flat choice list. The extension orchestrates ordinary model decisions; this is not a native provider tree API. Existing `classify` and `classify_compare` behavior is unchanged.

A classification tree is an object with `roots`. Each node has an `id`, optional `description`, and optional `children`:

```json
{
  "roots": [
    {
      "id": "a",
      "description": "Describe the domain covered by category a and its descendants.",
      "children": [
        { "id": "b", "children": [{ "id": "c" }] },
        { "id": "c", "children": [{ "id": "d" }] }
      ]
    },
    { "id": "c" },
    { "id": "d", "children": [{ "id": "e" }] }
  ]
}
```

IDs must be non-empty, at most 128 characters, and unique **among siblings**. Root `c` and `a > c` are different nodes. Descriptions are at most 4096 characters; use meaningful descriptions to explain which parent branch to choose. Missing or empty `children` means leaf. Only `roots`, `id`, `description` and `children` are supported; internal-node stopping flags, path-list imports and graph references are not implemented.

Supply the same shape inline or by local file:

```js
classify_tree({
  state: "The content to classify",
  tree: "./classification-tree.json",
  instructions: "Choose the most appropriate category for this content."
});

classify_tree({
  state: { ticket: "Refund requested for a duplicate payment." },
  tree: {
    roots: [
      { id: "billing", description: "Charges, invoices and refunds" },
      { id: "technical", description: "Errors, outages and integration problems" }
    ]
  }
});
```

`instructions` is optional and at most 8192 characters. Text/JSON `state` and optional `images` use the existing classifier input rules, including named images referenced in state. Tree definitions and tree instructions remain text-only. No provider/model override is accepted. The library exports `classifyTree(params, { settings, cwd, signal? })` and the `ClassificationTree`, `ClassificationTreeNode`, `ClassifyTreeParams`, `TreeStep` and `ClassifierTreeResult` types.

### Traversal and results

The example first chooses among `a`, `c` and `d`. After choosing `a`, it chooses between `b` and `c`. If it chooses `b`, its sole child `c` is automatic. Relevant result fields are:

```json
{
  "status": "complete",
  "levels": { "Level1": "a", "Level2": "b", "Level3": "c" },
  "steps": [
    { "level": 1, "id": "a", "source": "model", "confidence": 0.9, "probabilityScope": "siblings" },
    { "level": 2, "id": "b", "source": "model", "confidence": 0.8, "probabilityScope": "siblings" },
    { "level": 3, "id": "c", "source": "automatic" }
  ],
  "providerCalls": 2
}
```

The confidence values above are illustrative. Full results also identify the configured/selected provider and model and include estimated `cost` plus reported `usage` when complete. Model confidence describes its sibling decision (or one batch), **not the whole path**. No artificial confidence is assigned to automatic steps.

- A sole sibling is followed automatically, including a sole root. This is structural inference, not model confirmation. It intentionally bypasses a possible NONE rejection of that sole option even when NONE is enabled.
- An entirely forced chain makes **zero provider calls**, needs no API key, and returns genuine zero token usage and estimated zero cost. It still requires a valid configured route. `complete` means a leaf was reached, not that the model verified the input fits that chain.
- NONE, strict ties and refusals stop the traversal with `status: "no_match"`, `"ambiguous"` or `"refusal"`. `levels` and `steps` retain only the selected prefix; no deeper category is fabricated. Exact top ties stop even when NONE is disabled.
- The selected parent path and current sibling descriptions inform each question. Unselected descendant branches are not uploaded wholesale, so parent descriptions must explain their coverage. Selection is greedy and cannot recover a wrong parent; no global best-path or calibrated path-probability claim is made.
- Configured NONE/batching behavior applies at each branching node. A wide level can consume multiple provider requests; `providerCalls`, usage and cost account for inner batches and all completed model decisions. Missing usage or unavailable prices do not become complete-looking numeric subtotals.
- The first actual decision may use configured selective fallback. After a successful decision the actual provider/model is pinned for the rest of that traversal; later failures do not replay completed levels on another route. Failures/cancellation may still have billed completed work. Images use the ordinary classifier validation and upload behavior on each branching call.

### Local-file and size limits

Classification trees must fit **2 MiB and 32 levels**; the full node structure is validated before any model call. Local files must be valid UTF-8 JSON regular files inside the session cwd with no symlink path components or URLs. Descriptor-based containment checks reuse the existing local-image boundary and support macOS/Linux; inline classification tree works on other platforms. Files are read once per `classify_tree` invocation; no persistent classification tree registry or cache is introduced.

Original classifier state/image/request protections remain. Each constructed branch question must fit the existing input limits, including its selected-path context. Tree results are bounded to 40 KiB. User-owned live verification should compare inline and file inputs, zero-call chains, deeper NONE/tie outcomes, wide sibling batching, and provider billing totals.

## Per-call costs

Every successful `classify` result and each successful `classify_compare` entry includes one of:

```json
{
  "cost": {
    "status": "estimated",
    "currency": "USD",
    "input": 0.000042,
    "output": 0,
    "total": 0.000042,
    "source": "builtin",
    "rates": { "inputPerMillion": 0.042, "outputPerMillion": 0 }
  }
}
```

This example uses 1,000 Jev input tokens. Amounts are not rounded to cents; doing so would hide most classifier charges. `source` is `builtin` for the bundled standard public rates or `configured` for explicit rates. `rates` contains the effective USD-per-million rates used. Multi-call choice processing sums all completed calls and uses `source: "aggregated"` without a single misleading rates table; `providerCalls` reports the number of completed provider requests. Usage is omitted if any completed call lacks usage, and aggregate cost is unavailable if any call lacks an estimate. These are estimates, not provider invoices: taxes, credits, free allowances, account discounts and unreported billable activity are not included. There is no network pricing lookup.

| Official route/model | Input USD / 1M tokens | Output USD / 1M tokens |
| --- | ---: | ---: |
| OpenAI Decisions `gpt-6-luna` | 0.10 | 0 |
| TypeSafe `jev-1.13.0`, `jev-1.14.0`, `jev-latest`, `jev-preview` | 0.042 | 0 |
| Perplexity `pplx-decider-v1.2`, `pplx-decider-latest`, `pplx-decider-v1.1-27b`, `pplx-decider-v1-27b` | 0.02 | 0 |
| Perplexity `pplx-decider-flash-v1.2`, `pplx-decider-flash-latest` | 0.01 | 0 |
| Cloudflare `@cf/cloudflare/clef` | 0.24 | 0 |
| Cloudflare `@cf/cloudflare/clef-flash` | 0.038 | 0 |
| Cloudflare `typesafe/jev` | 0.042 | 0 |

Sources: [OpenAI Decisions pricing](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability), [OpenAI rates](https://developers.openai.com/api/docs/pricing), [TypeSafe models](https://docs.typesafe.ai/models), [Perplexity Decisions](https://docs.perplexity.ai/docs/decisions/quickstart#pricing), [Clef](https://developers.cloudflare.com/workers-ai/models/clef/), [Clef Flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/), [Cloudflare Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/). Aliases can move and public prices can change; explicit overrides take precedence. Perplexity's [model names](https://docs.perplexity.ai/docs/decisions/quickstart#model-names) documentation maps the older v1/v1.1 IDs in the discovery catalog to v1.2 and bills them at its rate. New text model IDs may already be selected through settings, but this cost feature does not change image capability declarations.

When reported, cache reads and writes are exposed as `usage.cachedInputTokens` and `usage.cacheWriteTokens`. They are **included** in input tokens, not additional tokens. Input cost is `(ordinary input × input rate + cache reads × cached-input rate + cache writes × cache-write rate) / 1,000,000`; output cost uses its separate rate. OpenAI's bundled cached-input rate is $0.01/M and default 30-minute write rate is $0.125/M, with all input rates doubled above 272,000 input tokens. Cloudflare Jev's bundled cached-input rate is zero. Unexpected 12-hour writes are unavailable rather than priced as 30-minute writes.

If pricing or usable token counts are missing, `cost` is `{ "status": "unavailable", "currency": "USD", "reason": "unknown_pricing" }` (or `missing_usage`, `invalid_usage`, `missing_cache_pricing`, `calculation_overflow`). No numeric amounts are returned in that case. Zero means a calculated zero, never an unknown charge. Failed or cancelled calls may still be billable but do not have reliable cost results; a fallback success reports only the successful request, not a total for prior attempts. Comparison callers must not treat a sum of available estimates as complete if any entries failed or have unavailable costs.

### Explicit deployment, gateway and custom pricing

Set `providers.<id>.pricing` to a map keyed by the **selected model ID** (Azure deployment name for Microsoft). Rates are non-negative finite USD per million tokens; input and output rates are required. Cache rates are optional, but reported cache activity needs the matching rate. Configured rates replace, rather than merge with, bundled rates. Custom providers accept the same `pricing` map.

```json
{
  "pi-classifier": {
    "providers": {
      "microsoft": {
        "pricing": {
          "my-decision-deployment": {
            "inputPerMillion": 0.1,
            "outputPerMillion": 0
          }
        }
      }
    }
  }
}
```

The numbers above are illustrative, **not a claim about Azure pricing**. Use your deployment's actual rates. Optional keys are `cachedInputPerMillion` and `cacheWritePerMillion`. Overrides specify effective rates; no automatic long-context multiplier is applied to them. Microsoft deployments, OpenRouter, unverified model IDs and custom or regional endpoints require verified explicit rates. Built-in prices apply only to exact known models on their official endpoint; a compatible gateway does not inherit the upstream provider's price. Misconfigured selected rates fail before a request; missing rates do not prevent classification.

## Choice limits by provider

The artificial **64-choice cap has been removed** from both runtime validation and the tool schema. Known official model routes use their documented 255-option wire maximum. Unknown model/endpoint limits are left to the provider unless you configure `providers.<id>.maxChoices` (also available on custom providers). The package still accepts **1–32 questions per call**. The 128-character limit applies to an option's name, not to the option count.

| Provider/model | Documented upstream choice options per question | Evidence/qualification |
| --- | --- | --- |
| TypeSafe Jev | Up to 255 | [Choice docs](https://docs.typesafe.ai/primitives/choice); current Jev service documentation |
| OpenAI Decisions `gpt-6-luna` | 2–255 | [API reference](https://developers.openai.com/api/reference/resources/decisions/methods/create), confirmed from official indexed search results; direct reference fetch returned 404 during this investigation |
| Perplexity `pplx-decider-v1.2`, Flash v1.2 and documented aliases (including catalog v1/v1.1 IDs) | 1–255 | [Request limits](https://docs.perplexity.ai/docs/decisions/quickstart#request-limits) and [model names](https://docs.perplexity.ai/docs/decisions/quickstart#model-names) |
| Cloudflare Clef | 2–255 | [Official input schema](https://developers.cloudflare.com/workers-ai/models/clef/schema-input.json) |
| Cloudflare Clef Flash | 2–255 | [Official input schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json) |
| Cloudflare-hosted Jev | Not independently verified | Do not assume direct-TypeSafe limits apply to every gateway |
| Microsoft Decision-1 | Not specified in the fetched guide | [Foundry guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision) |
| OpenRouter-hosted Jev / custom routes | Endpoint-dependent; not verified | Requires the selected gateway/model's contract |

A documented upstream maximum is not a live deployment guarantee. Limits are matched to known model IDs on official endpoints; other deployments and gateways must not silently inherit an upstream model's limit. A configured `maxChoices` must be a safe integer of at least 2 and must reflect that endpoint's actual capability.

### Optional NONE and sequential choice batching

Both settings default to `false`:

```json
{
  "pi-classifier": {
    "none_of_above_choice": true,
    "remove_choice_limits": true
  }
}
```

`remove_choice_limits: true` **requires** `none_of_above_choice: true`. Both `classify` and `classify_compare` reject an invalid pair before any provider request, with:

```text
remove_choice_limits requires none_of_above_choice: true. No classifier request was sent.
```

With only `none_of_above_choice` enabled, the extension adds a collision-safe internal NONE option to every choice question. That option consumes one slot: a 255-option provider can accept 254 real choices plus NONE in a single request. If the list exceeds that capacity while `remove_choice_limits` is false, the call fails locally with instructions to enable both flags or reduce the list.

With both flags enabled, the extension walks the choices in their JavaScript/JSON object enumeration order, sending at most `maxChoices - 1` real choices plus NONE per batch. On a 255-option model this is **254 + 1**. A question advances only if NONE's probability is **strictly greater than every real option's probability**, not merely because the provider picked NONE and not necessarily greater than 50%. A unique real winner ends that question. An exact tie for top probability returns `{ "type": "ambiguous" }`. If all batches reject, the answer is `{ "type": "no_match" }`. Typed refusals stop that question without advancing.

Batching is **sequential first-match selection**, not a global best-choice guarantee. An early acceptable result can hide a better later option, and NONE itself can be unreliable. Returned choice probabilities cover only the winning batch's real options, with `probabilityScope: "batch"` and a separate `noneOfAboveProbability`; those real probabilities plus NONE sum to approximately one. Unseen options are not assigned fabricated zeros. The internal NONE label is never returned as the selected real choice. Ordinary calls without these flags retain their previous answer shapes.

Multiple choice questions progress independently in shared rounds; settled questions and bool/score/box questions are not resent. Images are prepared once per selected route and included in the required requests. Each request may be billed. Usage and estimated cost cover all completed calls in a successful result, with `providerCalls` for transparency. A multi-call result omits a single `requestId` because no one ID represents every request. If a later request fails after partial completion, the operation may have incurred charges; HTTP 401/404/429 after completed batches does not replay the operation on a fallback route.

For an endpoint without a known limit, automatic batching fails before any request until you set its verified `providers.<id>.maxChoices` or `customProviders.<id>.maxChoices`. This setting does not remove context-window, input-byte, image, output-size, timeout or cancellation protections. The 2 MiB original text/questions limit and 40 KiB returned-result limit remain in place. No automatic tree construction, retrieval, hidden model switching or cross-batch probability normalization is performed.

## Microsoft Decision-1 on Foundry

Deploy `Microsoft-Decision-1` in Microsoft Foundry, then configure the **resource endpoint**, API key, and actual **deployment name**:

```json
{
  "pi-classifier": {
    "default": { "provider": "microsoft-api", "model": "my-decision-deployment" },
    "providers": {
      "microsoft": {
        "baseUrl": "https://YOUR-RESOURCE.services.ai.azure.com",
        "apiKey": "${AZURE_API_KEY}"
      }
    }
  }
}
```

The extension appends `/providers/microsoft/v1/systemone` and uses the `api-key` header, not bearer API-key authentication. The catalog name is only a discovery entry: `model` must match your deployment, which may have another name. Microsoft currently supports text/JSON bool (wire type `noul`), choice, and score; images and box are rejected locally. Entra token authentication is not implemented. The selected deployment is reported in results even if Foundry returns a different underlying model name. If Microsoft omits confidence, choice confidence is derived from the selected probability and score confidence from the largest level probability. The official guide does not include a complete response JSON example; verify actual bool/choice/score responses on your deployment before relying on this integration.

## Fallback and explicit comparison

`classify` uses the default first. It tries configured `fallback` entries in order **only** after a missing API key or an explicit HTTP **401, 404, or 429**. Each resolved endpoint/model is selected at most once in the fallback chain; explicitly configured choice batching can make multiple requests on that selected route. When fallback is exercised, `attemptedRoutes` identifies the routes considered, including missing-key failures.

No automatic fallback occurs after 403/policy refusal, 400/422, 5xx, timeout, network failure, cancellation, malformed answers, input/capability/configuration errors, low confidence, or typed refusals. Each candidate validates the original input against its own capabilities; incompatible images or box questions stop the chain, never silently drop input. Every attempted request has its own timeout. Crossing billing providers and sharing state with them happens only through explicitly configured route pairs. Omit `fallback` or use `[]` to disable it.

Use **`classify_compare`** only when you explicitly want a model comparison. It accepts the same `{ state, questions, images? }` as `classify`, runs exactly the entries in `compare` sequentially, and never substitutes the default, uses fallback, or changes settings. Every entry is a separate potentially billable classification; configured choice batching can make multiple provider requests for that entry. Responses contain labeled `results` with status, duration in milliseconds, typed answers/token usage and estimated cost (or an unavailable reason) on success, or safe errors. A failed entry does not discard successes. Duplicate endpoint/model entries report an error without another call. Cancellation retains completed results, records an in-flight cancellation when present, sets `cancelled`, and prevents later requests. Scores from different models are not assumed to be calibrated equally.

You can also run `/classifier compare <JSON params>`, for example:

```text
/classifier compare {"state":"Checkout is down.","questions":{"urgent":{"type":"bool","instructions":"Is this urgent?"}}}
```

The library exports `compareClassifiers(params, { settings, cwd, signal? })`. Neither tool accepts provider/model overrides. A missing or empty `compare` list is a configuration error and makes no calls. Comparison output can be larger than a single result; use the tool rather than the command for full structured results (command messages are truncated to 16,000 characters).

### Images and experimental Jev box answers

Pass `images: ["photo.png"]`. Images are attached in order alongside state. OpenAI, Perplexity and Clef/Clef Flash support images. Cloudflare-hosted Jev and the built-in OpenRouter route are text-only in this package.

Local image inputs are non-animated PNG/JPEG/WebP regular files inside the session cwd, with no symlink components or inline base64. Safe descriptor-based loading supports macOS (requires the OS `/usr/sbin/lsof`) and Linux (`/proc`). Images are fully decoded locally before upload. Limits: five images on OpenAI/Jev, eight on Perplexity; 5 MiB each, 10 MiB total and 16 megapixels each. Clef has stricter limits: four images, 4 MiB each and 8 MiB total. Perplexity allows at most eight image occurrences in shared state, including repeated references, and requires at most 2048 tiles of 32×32 pixels per image. Images are not silently resized. Text/JSON plus questions remain limited to 2 MiB and 32 questions.

Named hosted URLs on OpenAI do not require local file loading and work on other platforms. They are passed directly to the selected OpenAI-compatible endpoint, never downloaded by this package. The provider must be able to access them and enforces remote image format/size limits; local byte/pixel validation cannot inspect them. URLs must use HTTP(S), with no credentials or fragment. Do not send sensitive URLs unless you intend to share them with that endpoint.

TypeSafe Jev images are experimental and require opt-in. Use PNG/JPEG. Each side must be **280–1568 pixels**, with total area 78,400–2,458,624 pixels; resize or pad beforehand. These limits also apply to custom SystemOne image routes using Jev's assets protocol:

```json
{
  "pi-classifier": {
    "defaultProvider": "typesafe-api",
    "defaultModel": "jev-preview",
    "providers": {
      "typesafe": {
        "experimentalImages": true,
        "experimentalBox": true
      }
    }
  }
}
```

With an image, a question such as `{ "type": "box", "instructions": "Find the mug in the first image." }` returns normalized `top`, `bottom`, `left`, `right` edges and confidence. Box needs Jev 1.14 (`jev-preview` or `jev-1.14.0`) and both opt-ins. It is not production-grade localization. A box does not mean the object exists: pair it with a bool existence question when necessary.

### Named images and composable image content

Existing `images: ["photo.png"]` still attaches every image to shared state in order. Alternatively, use named descriptors:

```json
{
  "state": { "scene": { "$image": "scene" } },
  "images": [
    { "id": "scene", "path": "scene.png" },
    { "id": "target", "path": "reference.jpg" }
  ],
  "questions": {
    "present": {
      "type": "bool",
      "instructions": ["Does the scene contain the object shown here? ", { "$image": "target" }]
    }
  }
}
```

Image IDs must be unique, 1–64 letters/digits/underscores/hyphens. Each named image must be referenced, and every reference must resolve. The exact object `{"$image":"id"}` is reserved for image references, not ordinary JSON data. Named images are not also attached automatically. Ordinary provider-looking JSON, such as an `image_url` key, remains text/data and cannot inject native image parts.

`instructions` and criterion descriptions accept either the existing text string or an ordered array of strings and image references. Jev preserves these as structured arrays with asset references. Other supported adapters concatenate adjacent text parts; include spaces/newlines where needed. For Jev, criterion descriptions can include visual examples:

```json
{
  "type": "choice",
  "instructions": "Which reference most resembles the scene?",
  "criteria": {
    "good": ["Correct assembly: ", { "$image": "good_example" }],
    "bad": ["Incorrect assembly: ", { "$image": "bad_example" }]
  }
}
```

Declare these images in the surrounding request's `images` list. The same content form works for each score level and bool true/false descriptions on Jev.

| Placement | Jev assets protocol | OpenAI Decisions | Perplexity Decisions | Clef / Flash |
| --- | --- | --- | --- | --- |
| Legacy shared local paths | Yes, opt-in | Yes | Yes | Yes |
| Named references in shared state | Yes, opt-in | Yes | Yes | No |
| Images in question instructions | Yes, opt-in | Yes | No | No |
| Images in criteria | Yes, opt-in | No | No | No |
| Named hosted URL descriptors | No | Yes | No | No |

For OpenAI, replace a named local descriptor with `{"id":"target","url":"https://example.com/reference.jpg"}` and reference it in state or instructions. Nested JSON state is represented as text fragments interleaved with the referenced images; it is not an upstream JSON object containing embedded native parts. Unsupported placements fail locally before a request, including on fallback and comparison routes. No image is silently dropped or moved.

Jev uploads each used named image once per provider call. Choice batching sends only assets referenced by that batch, so images used only by settled questions or later criteria are not sent unnecessarily. Reusing an image reference still counts each occurrence against Jev's expanded request limits; the server may reject a request after re-encoding/expansion. No automatic image splitting, resizing or multipart upload is performed.

### Local bounding-box visualization and cropping

Use **`classifier_box_image`** with a local image and a returned normalized box:

```json
{
  "image": "scene.png",
  "box": { "top": 0.25, "bottom": 0.82, "left": 0.44, "right": 0.84 },
  "mode": "overlay"
}
```

The default `overlay` mode draws the box. Set `mode: "crop"` to extract its region. This tool is local-only: no classifier request, provider charge, URL download or file write. It returns an inline PNG plus dimensions and the pixel-space box. Local input limits are 5 MiB and 16 megapixels; the PNG output is limited to 10 MiB. Coordinates refer to stored image dimensions, without automatic EXIF rotation. Verify you are using the same image that the provider evaluated.

The library exports `renderClassifierBox(params, { cwd, signal? })`, which returns PNG base64 data, MIME type, dimensions, pixel box and mode. Saving the result is the caller's responsibility. A box is not proof that an object exists; check existence separately.

Video descriptions in Cloudflare's model pages do not establish a hosted video API contract. Video, segmentation masks, multi-object box lists, image generation/editing and gateway image parity are not implemented.

## Custom providers

Like image-gen, `customProviders` adds a named endpoint and explicit model list. Supported protocols are `openai-decisions`, `perplexity-decisions`, `system-one`, `cloudflare-system-one`, and `microsoft-system-one` (Foundry resource root and API-key authentication). A custom URL cannot make an arbitrary API compatible. Custom IDs must not shadow built-in provider/route IDs.

```json
{
  "pi-classifier": {
    "defaultProvider": "local-decisions",
    "defaultModel": "my-decision-model",
    "customProviders": {
      "local-decisions": {
        "api": "system-one",
        "baseUrl": "http://127.0.0.1:8133/v1",
        "apiKey": "${LOCAL_DECISIONS_KEY}",
        "models": [{ "id": "my-decision-model", "input": ["text"] }]
      }
    }
  }
}
```

Custom endpoints use their route ID as the Pi stored-credential provider ID. They have no implicit environment variable; use an explicit key reference. SystemOne image endpoints must implement Jev's assets protocol, declare image input and opt into `experimentalImages`. Box additionally requires `box: true` on the model and `experimentalBox: true` on the provider.

## Goal-running computer use (OpenAI Decisions)

The optional `classifier_computer_use` tool runs a bounded Cua Driver loop inside Pi, selecting only supervisor-permitted controls and returning explicit handoff/continuation when help is needed. It has a separate opt-in OpenAI route, preserves the normal classifier default, accepts transient Driver screenshots without disk files, and verifies completion through fresh Driver predicates. See [COMPUTER_USE.md](COMPUTER_USE.md) for setup, real input/output examples, safety limits, supervisor resumption and verification.

## Development and live verification

```sh
npm run typecheck
npm run build
npm pack --dry-run
```

No provider calls are made by these commands. Live tests belong to the user:

1. Keep Codex logged in and configure an OpenAI API key. Select `openai-api/gpt-6-luna`, classify one bool, and verify chat login did not change.
2. Select each provider and ask bool/choice/score questions; check probabilities, selected model and usage.
3. Try a small PNG on OpenAI, Perplexity and Clef. Enable Jev images explicitly before trying its preview; verify box coordinates separately.
4. Cancel an in-flight call and check a deliberately invalid model/key. Errors must be safe; only missing keys and HTTP 401/404/429 may select an explicitly configured fallback. Timeout/network/403/5xx/malformed results must not trigger another route.
5. Use `/classifier use` in a trusted project and confirm unrelated settings and both route lists remain intact. Check legacy-only defaults as well as nested defaults.
6. Configure your Foundry endpoint and deployment name, select `microsoft-api`, and verify bool/choice/score responses and token usage. Verify an image is rejected locally.
7. Configure two `compare` pairs and explicitly invoke `classify_compare`; confirm labeled successes/errors, duration, unchanged defaults, and that cancellation prevents subsequent calls. Each valid entry may be billed.
8. In your own controlled deployment, verify missing keys and HTTP 401/404/429 allow only configured fallbacks; duplicate routes are never called twice. Verify low confidence and refusals return normally without switching models.
9. On Jev, enable the image/box flags and try the named scene/reference example above. Compare visual choice/score criteria, then a box plus a separate existence question. Verify repeated references and choice batching do not leave unreferenced assets. Try a 279-pixel side and confirm local rejection.
10. On OpenAI, try one shared named local image plus a question-specific local image, then replace the latter with a public HTTPS descriptor. Confirm references stay in their intended placements. On Perplexity, try named state references and eight small images; instruction/criterion images should fail locally.
11. Invoke `classifier_box_image` with the exact local scene and a returned box in both overlay and crop modes. Confirm pixel bounds and orientation visually, no files are written, invalid/reversed edges are rejected, and cancellation interrupts processing. Check EXIF-oriented photos carefully: no automatic rotation is applied.

Provider schemas and previews can change; no live entitlement or model-accuracy claim is made by a local build.

Sources: [Microsoft Decision-1](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision), [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), [Perplexity Decisions](https://docs.perplexity.ai/docs/decisions/quickstart), [TypeSafe images](https://docs.typesafe.ai/images), [TypeSafe box](https://docs.typesafe.ai/primitives/box), [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/).
