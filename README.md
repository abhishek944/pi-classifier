# pi-classifier

A Pi extension for typed, probabilistic decisions across OpenAI Decisions, Perplexity Decisions, TypeSafe Jev, Cloudflare Clef/Clef Flash and SystemOne-compatible gateways.

One configured model, one provider request. No fallback routes, automatic retries, model switching or permission auto-approval.

## Install

Requires Node.js 22.19+ and Pi 1.2+. Install the public baseline from GitHub:

```sh
pi install git:github.com/abhishek944/pi-classifier@v0.1.0
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

The baseline package version and Git tag are `0.1.0` / `v0.1.0`. Installation is explicit; this release is available from GitHub, not published to npm.

## Configuration: same shape as pi-image-gen

Use the `pi-classifier` namespace in Pi settings. Like `pi-image-gen`, route selection uses `defaultProvider` and `defaultModel`; credentials/endpoints are nested under `providers.<provider-id>`. The two extensions have independent settings and do not change one another.

```json
{
  "pi-classifier": {
    "defaultProvider": "openai-api",
    "defaultModel": "gpt-6-luna",
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
| `openai-api`     | `openai`              | `gpt-6-luna`                                                       | `OPENAI_API_KEY`     |
| `perplexity-api` | `perplexity`          | `pplx-decider-v1.1-27b`, `pplx-decider-v1-27b`                     | `PERPLEXITY_API_KEY` |
| `typesafe-api`   | `typesafe`            | `jev-latest`, `jev-1.13.0`, `jev-preview`, `jev-1.14.0`            | `TYPESAFE_API_KEY`   |
| `cloudflare-api` | `cloudflare`          | `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, `typesafe/jev` | `CLOUDFLARE_API_KEY` |
| `openrouter-api` | `openrouter`          | `typesafe/jev-1.13`, `~typesafe/jev-latest`                        | `OPENROUTER_API_KEY` |

Cloudflare also needs `providers.cloudflare.accountId`, the stored `cloudflare-workers-ai` API-key credential's `env.CLOUDFLARE_ACCOUNT_ID`, or `CLOUDFLARE_ACCOUNT_ID`, in that order. Its stored API token lives under `cloudflare-workers-ai`, not `cloudflare`.

A provider's `baseUrl` replaces the API root (before `decisions`, `systemone`, or Cloudflare's run path). Authentication/transport headers cannot be overridden. Custom headers are supported. HTTPS is required except for loopback HTTP.

New text model IDs on built-in routes can be selected without a package release. They must actually implement that route's API; a normal chat model is not a decision model. New image capabilities require a known model or explicit custom model declaration.

## Use

```text
/classifier list
/classifier status
/classifier use cloudflare-api @cf/cloudflare/clef-flash
/classifier reload
```

`use` writes only `defaultProvider`/`defaultModel` into trusted project `.pi/settings.json`, preserving unrelated settings. The project must be trusted. All calls load current settings, so `reload` validates and displays the current route rather than maintaining a separate configuration cache. To change global defaults, edit the global `pi-classifier` settings.

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

The tool takes no provider/model parameter. Its structured result identifies the configured route and model, typed answers, reported token usage and an available request ID. `bool.probability` is the probability of true; `choice` includes a probability per label and confidence; `score` is a probability-weighted level index (starting at zero), not necessarily an integer. Refusals are explicit typed answers. Token counts are reported, but this initial version does not estimate monetary cost or add it to Pi's session billing totals.

Provider results are checked for probability ranges/distribution sums and decision consistency (selected choices must be most likely; supplied score distributions must match the expected score within rounding tolerance). Low confidence is a valid answer, not an error. Calibrate thresholds on your own data; scores from different providers are not interchangeable.

### Images and experimental Jev box answers

Pass `images: ["photo.png"]`. Images are attached in order alongside state. OpenAI, Perplexity and Clef/Clef Flash support images. Cloudflare-hosted Jev and the built-in OpenRouter route are text-only in this package.

Image inputs are local non-animated PNG/JPEG/WebP regular files inside the session cwd, with no symlink components, URLs or inline base64. Safe descriptor-based loading currently supports macOS (requires the OS `/usr/sbin/lsof`) and Linux (`/proc`); other platforms support text classification only. Images are fully decoded locally before upload. Limits: five images; 5 MiB each, 10 MiB total and 16 megapixels each. Clef has stricter limits: four images, 4 MiB each and 8 MiB total. Perplexity requires at most 2048 tiles of 32×32 pixels per image; resize before sending. Images are not silently resized. Text/JSON plus questions are limited to 2 MiB, with at most 32 questions per call.

TypeSafe Jev images are experimental and require opt-in. Use PNG/JPEG. Each side must be 256–1568 pixels, with total area 78,400–2,458,624 pixels; resize or pad beforehand. These limits also apply to custom SystemOne image routes using Jev's assets protocol:

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

## Custom providers

Like image-gen, `customProviders` adds a named endpoint and explicit model list. Supported protocols are `openai-decisions`, `perplexity-decisions`, `system-one`, and `cloudflare-system-one`. A custom URL cannot make an arbitrary API compatible. Custom IDs must not shadow built-in provider/route IDs.

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
4. Cancel an in-flight call and check a deliberately invalid model/key. Errors must be safe and must not trigger another route.
5. Use `/classifier use` in a trusted project and confirm unrelated settings remain intact.

Provider schemas and previews can change; no live entitlement or model-accuracy claim is made by a local build.

Sources: [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), [Perplexity Decisions](https://docs.perplexity.ai/docs/decisions/quickstart), [TypeSafe images](https://docs.typesafe.ai/images), [TypeSafe box](https://docs.typesafe.ai/primitives/box), [Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/).
