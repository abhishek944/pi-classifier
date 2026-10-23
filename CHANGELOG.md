# Changelog

## 0.2.0

- Microsoft Decision-1 via Foundry resource endpoints and deployment names, API-key authentication, and text/JSON bool/choice/score questions.
- Nested `default` provider/model pairs with legacy default-key compatibility, ordered selective `fallback`, and explicit `compare` routes.
- `classify_compare`, `/classifier compare <JSON params>`, and the `compareClassifiers` library export, with labeled successes/errors, per-entry duration, and cancellation preserving completed results.
- Automatic alternatives only for missing API keys or HTTP 401/404/429; no route retries, fallback after uncertain outcomes, or automatic model comparisons.
- `/classifier use` writes the nested default while preserving fallback/comparison lists and unrelated settings.

Verification: typecheck, build, package dry run, whitespace checks, and independent source review passed. No unit tests or live provider calls were run for this release. Microsoft response shapes remain unverified against a live Foundry deployment. Nested defaults take precedence over legacy keys in merged classifier settings; mixed-format global/project overrides are not yet normalized per layer like image-gen.

## 0.1.0

Initial public baseline.

- Config-driven `classify` tool with typed bool, choice and score answers; experimental Jev bounding boxes.
- OpenAI Decisions, Perplexity Decisions, TypeSafe Jev, Cloudflare Clef/Clef Flash, OpenRouter and supported custom protocols.
- Configuration shape aligned with pi-image-gen: defaultProvider, defaultModel, providers and customProviders.
- API-key calls independent of Codex chat login, using configured key, stored Pi API-key credential or environment key.
- Local image validation, bounded requests/results, cancellation, safe errors and explicit experimental capabilities.
- `/classifier` configuration commands and a TypeScript source entrypoint for Git-based installation.
- No automatic fallback, retry, model switching or permission automation.

Verification: typecheck/build/format/package/schema checks passed. Live OpenAI text/JSON and synthetic image acceptance checks passed; the first text call required one manual repeat after an HTTP error. Other providers, interactive commands and live cancellation remain unverified. See README for platform, image, BOM and experimental-feature limitations.
