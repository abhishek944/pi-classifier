# Changelog

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
