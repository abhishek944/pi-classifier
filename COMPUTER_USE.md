# Computer use with OpenAI Decisions

`classifier_computer_use` runs repeated observations, decisions, and Cua Driver actions inside one Pi tool invocation. Pi's main agent remains the supervisor: it owns planning, authorization, content generation, unsupported controls, and final task-level review. The classifier chooses only among supplied, currently grounded controls.

This first release supports **one exact accessibility-backed native window per chunk**. Screenshots can supplement semantic state; they do not enable arbitrary pixel targeting. OpenAI Decisions does not generate text, coordinates, scripts, or bounding boxes.

## Enable explicitly

Add this to trusted Pi settings, preserving your existing classifier configuration:

```json
{
  "pi-classifier": {
    "computerUse": {
      "enabled": true,
      "route": { "provider": "openai-api", "model": "gpt-6-luna" },
      "screenshots": true,
      "minConfidence": 0.75
    }
  }
}
```

Only `openai-api` is supported for computer use initially. Its normal configured endpoint and independent API-key resolution are reused. Missing credentials fail before a window observation. No provider fallback, automatic retry, comparison, sequential choice batching, or global default changes occur. Ordinary `classify` can continue using Jev.

The Cua Driver MCP server must already be configured and accessible as `mcp__cua_driver__*`. This extension does not install, launch, or reconfigure the daemon or request OS permissions. After installing/loading the updated extension, use `/reload` to expose the new tool.

**Privacy:** the selected endpoint receives the supplied goal, nonsecret values, bounded window labels/values, recent action summaries, and optional window screenshot. Use only the intended authorized window. Structured secure/password controls are excluded, but screenshots are not automatically redacted. Set `screenshots: false` for tree-only use. No screenshots or trajectory files are written by this feature. Do not pass passwords, tokens, payment information, or other secrets.

## Supervisor workflow

1. Resolve the intended app/account/window through Driver. Inspect its semantic controls. Prefer an existing app API or typed browser route when that is the reliable boundary.
2. Define one bounded goal and permitted controls. Exact role and label are re-resolved on every observation. Controls can span later screens; their order is not a script. Duplicate matches are never selected arbitrarily.
3. Supply reusable nonsecret values. Fill uses Driver `set_value`, which replaces native field values. It is not a reliable general browser/Electron typing implementation; use the supervisor's supported browser/input route for those widgets.
4. Supply Driver completion predicates covering the entire requested result when possible. Every predicate requires an actual condition such as value, selection, enabled state, or existence.
5. Call the tool and handle its result. Do not observe or mutate the same window in parallel; newer observations invalidate element tokens.

Example (replace PID, window ID, and semantic names with your actual observation):

```js
classifier_computer_use({
  goal: "Set City to Lisbon, apply it, and leave the resulting city visible.",
  target: { pid: 1234, window_id: 5678 },
  controls: [
    { id: "city", operation: "fill", selector: { role: "AXTextField", label: "City" }, valueKey: "city" },
    { id: "apply", operation: "click", selector: { role: "AXButton", label: "Apply" } }
  ],
  values: { city: "Lisbon" },
  expect: [{ element: { selector: { role: "AXTextField", label_contains: "Result" }, value_equals: "Lisbon" } }],
  maxActions: 10,
  timeoutMs: 60000
});
```

Actions supported:

- `click`: exact observed invokable/native control.
- `fill`: exact editable native field and supplied `valueKey`. Already matching values are not offered again. Values are single-line strings; control characters are rejected to avoid implicit submission/focus changes.
- `key`: one explicit permitted key addressed to an exact observed field/control. No global hotkeys or arbitrary modifiers.

The tool defaults to background delivery for clicks/keys. `deliveryMode: "foreground"` is an explicit supervisor choice after an observed background-delivery failure within the same authorized target. Announce the brief focus change and preserve user scope. Do not use it to bypass a refusal. Native `fill` uses Driver's semantic value route regardless of delivery mode; unsupported typing needs a handoff.

An allowlist scopes actions; **it does not grant consent**. The main agent must stop before unapproved purchases, sends, publishing, deleting valuable data, account/security changes, credentials, CAPTCHA, or OS consent. Existing Pi nested tool hooks and Driver authorization remain active. A model safety judgment is only additional evidence, not the permission boundary.

## Explicit handoff and resumption

The result contains:

- `status`: `completed`, `handoff`, or `stopped`.
- `reason` and `message`: verified completion, missing value, supervisor help, low confidence, no progress, incomplete observation, loading timeout, action limit, cancellation/deadline, Driver failure, or failed verification.
- `actions`: every attempted action, including an interrupted action with `effect: "unknown"`.
- `metrics`: completed provider calls, token/cost estimates when available, stage durations, and `accountingIncomplete` when an interrupted/failed provider request might have been billed.
- `decision`: the last selected candidate, confidence, and selected probability, when available. These explain a handback without exposing raw model payloads.
- `handoff.continuation`: plain task arguments and bounded previous action summaries, **not** an executable capability, saved snapshot, queued action, or authorization token.

On missing text or unsupported work:

```js
const next = result.handoff.continuation;
// The supervisor obtains/writes the nonsecret text or handles the unsupported step.
classifier_computer_use({
  ...next,
  values: { ...next.values, city: "Lisbon" },
  context: "The requested city value is now supplied. Continue the original goal."
});
```

Every chunk takes a fresh observation and asks for a new decision. No snapshot, pixel capture, or element token survives a handoff. The supervisor may adjust controls to match a later screen only when the original task authorizes those effects. If the application switched to a different native window, resolve it explicitly before updating the target.

**Unknown action outcome:** inspect application state before resuming. A timeout or tool error does not mean input was not applied. The extension records the attempt and never automatically retries it. No-progress after unverified input returns control rather than replaying a possible submission. Do not lower confidence simply to force progress; the threshold is an uncalibrated handback heuristic.

## Completion and stopping

A Decisions `DONE` choice is only a claim. It may request read-only verification even below the mutation confidence threshold; it never dispatches uncertain input. With `expect`, the tool requests fresh `verify_state` evidence with two stable satisfied samples. Only all satisfied predicates yield `completed`. Unknown, ambiguous, or unsatisfied results hand back. The supervisor must still check that the predicates cover the **whole** goal and use application-owned state/reopen checks for saves when appropriate.

Without `expect`, `DONE` returns `handoff / needs_verification`. This supports visual or semantic goals that Driver predicates cannot independently express without making a false success claim.

The observation is bounded to 180 elements, depth 14, and a 1.5-second AX budget. Explicitly truncated/degraded trees hand back. Driver's indexed list omits passive text, so `elements_complete: false` alone is not treated as a truncated walk or evidence of absence. Bounded window-only passive text supplements indexed controls; global menu-bar branches are excluded, independently of their ordering. Missing or duplicate eligible control matches are never guessed. The default chunk is 20 actions and 60 seconds, with bounded waits and model decisions. Caller cancellation/deadline propagates to nested tools and HTTP, but cannot undo an OS event already dispatched. No blind batches or automatic rollback are attempted.

## Programmatic use

The package exports `runComputerUse(params, { settings, cwd, callTool, signal?, onProgress? })`. `callTool` must dispatch through the host's real approval/tool pipeline and return the raw MCP `CallToolResult`. The Pi tool does this through `ctx.executeTool()`, unwrapping Pi's MCP result envelope. Do not substitute another SDK connection to evade approvals.

`classify(params, options)` additionally supports `options.memoryImages`, an array of `{bytes: Uint8Array, mimeType}`. These transient images pass the same byte/pixel/full-decode and route checks as files. They supplement shared input; named references still refer only to normal named descriptors. Model-facing `classify` parameters remain path/descriptor-based. New image ingress does not weaken local-path validation.

## Design references

This is original implementation, not vendored code. Useful patterns were curated from:

- [Browser Use Jev Ultrafast](https://github.com/browser-use/jev-ultrafast): indexed grounded actions, code-owned loop, single decision round trip.
- [Ying-Kai-Liao/jev-browser](https://github.com/Ying-Kai-Liao/jev-browser): caller values and explicit handback statuses.
- [Decision Luna Browser Lab](https://github.com/humanity-forever/decision-luna-browse-control): independent completion and waiting evidence.
- [CUA-JEV](https://github.com/ZJU-REAL/CUA-JEV): legal candidate/executor boundary.
- [Jev Browser Use](https://github.com/wy-coliney/jev-browser-use): supervisor allowlists and resumption inside an existing connection.
- [0x7067/jev-browse](https://github.com/0x7067/jev-browse): explicit action phases and bounded progress history.

Their speed/reliability results are not performance claims for this extension. Driver pacing is unchanged; stage metrics should identify whether model inference, observation, or Driver waits dominate the actual workload.
