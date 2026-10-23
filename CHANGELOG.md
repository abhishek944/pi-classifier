# Changelog

## Unreleased

- Added named local images and explicit `{$image:id}` references in shared state, Jev/OpenAI question instructions and Jev criteria, while retaining legacy shared image paths.
- Added OpenAI hosted HTTP(S) image descriptors without local downloads. Unsupported image placements fail before provider requests; Jev batching includes only assets used by the current batch.
- Added the local-only `classifier_box_image` tool and `renderClassifierBox` export for inline PNG box overlays or crops, without provider calls or automatic file writes.
- Added current Perplexity v1.2/Flash/latest model catalog entries and support for up to eight Perplexity images. Corrected Jev's minimum side length to 280 pixels.
- Documented capability differences, image-reference semantics, remote-image limits, experimental box caveats and user-owned verification steps. Video and unverified gateway image support remain excluded.

## 0.3.0

- Added `classify_tree` and `classifyTree` for nested `roots`/`id`/`description`/`children` classification trees supplied inline or as bounded local UTF-8 JSON files. Results contain selected Level1/Level2/etc, model-versus-automatic steps, partial statuses and accumulated token/cost/provider-call totals.
- Tree traversal skips sole-child model calls, reuses configured sibling choice batching, and pins the successful route across later levels. Zero-call chains return genuine zero usage/cost; greedy and structural-inference limits are explicit.
- Successful classification and comparison results now include estimated USD input/output/total cost with effective token rates, or an explicit unavailable reason instead of an assumed zero.
- Bundled standard rates for known official OpenAI Decisions, TypeSafe Jev, current Perplexity v1.2 and Cloudflare routes; model/deployment-keyed pricing overrides for custom endpoints, unverified prices and account-specific rates.
- Cache-aware cost calculation, optional reported cache usage, and documented provider choice limits. Costs are estimates, not invoices or Pi session billing totals.
- Removed the artificial 64-choice cap; known routes enforce their documented provider maximum. Optional `none_of_above_choice` and `remove_choice_limits` settings add NONE and sequential first-match batching. Enabling batching without NONE fails before provider requests.
- Explicit no-match/ambiguous outcomes, batch-local probability metadata, aggregate multi-call usage/cost and provider call counts. Unknown batching limits require verified provider `maxChoices`; later failures do not replay completed batches through fallback. The 32-question and byte/image/result protections remain.

Verification: typecheck, build, package dry run, whitespace checks, recursive tool-schema validation, and independent source reviews passed. No unit tests or live provider calls were run for this release. Classification-tree traversal is greedy; automatic sole-child steps are structural inference, not model confirmation. Bundled prices are estimates, not invoices, and unknown gateway/model limits require verified configuration for batching.

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
