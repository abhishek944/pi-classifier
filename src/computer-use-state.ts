import { ClassifierError, isRecord } from "./types.js";
import type {
  ComputerCandidate, ComputerControl, ComputerUseParams, DriverElement,
  DriverObservation, DriverReply,
} from "./computer-use-types.js";
import type { MemoryImage } from "./inputs.js";

export const KEY_NAMES = ["return", "tab", "escape", "up", "down", "left", "right", "space", "home", "end", "pageup", "pagedown"];
const SECRET = /secure|password|passcode|one.time|\botp\b|secret|security.code|api.key|access.token|auth.token|recovery.code|credit.card|card.number|\bcvv\b/i;
const EDITABLE = /^(AXTextField|AXTextArea|AXComboBox|textbox|combobox|text field|text area)$/i;
const CLICKABLE = /^(AXButton|AXCheckBox|AXRadioButton|AXMenuItem|AXLink|AXPopUpButton|AXTab|AXDisclosureTriangle|AXRow|button|checkbox|radio|menuitem|link|tab|switch)$/i;

export function validateComputerParams(params: ComputerUseParams): void {
  const invalid = () => { throw new ClassifierError("input", "Invalid computer-use goal, exact target, controls, values, expectations or limits."); };
  if (!isRecord(params) || typeof params.goal !== "string" || !params.goal.trim() || params.goal.length > 4096 ||
      !isRecord(params.target) || !Number.isSafeInteger(params.target.pid) || params.target.pid < 1 ||
      !Number.isSafeInteger(params.target.window_id) || params.target.window_id < 0 ||
      !Array.isArray(params.controls) || params.controls.length < 1 || params.controls.length > 120) invalid();
  const ids = new Set<string>();
  for (const c of params.controls) {
    if (!isRecord(c) || typeof c.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id) ||
        !isRecord(c.selector) || typeof c.selector.role !== "string" || !c.selector.role || c.selector.role.length > 128 ||
        typeof c.selector.label !== "string" || !c.selector.label.trim() || c.selector.label.length > 512 ||
        !["click", "fill", "key"].includes(c.operation)) invalid();
    ids.add(c.id);
    if (c.operation === "fill" && (typeof c.valueKey !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(c.valueKey))) invalid();
    if (c.operation === "key" && !KEY_NAMES.includes(c.key)) invalid();
    if (SECRET.test(c.selector.role + " " + c.selector.label))
      throw new ClassifierError("input", "Credential and secure controls must remain with the user, outside the classifier loop.");
  }
  if (params.values !== undefined && (!isRecord(params.values) || Object.keys(params.values).length > 64 ||
      Object.entries(params.values).some(([k, v]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(k) || typeof v !== "string" || v.length > 4096 || /[\r\n\t\x00-\x1f]/.test(v)))) invalid();
  if (params.expect !== undefined && (!Array.isArray(params.expect) || params.expect.length < 1 || params.expect.length > 8)) invalid();
  for (const p of params.expect ?? []) {
    const e = p?.element;
    if (!isRecord(e) || !isRecord(e.selector) || typeof e.selector.role !== "string" || !e.selector.role ||
        typeof e.selector.label_contains !== "string" || !e.selector.label_contains ||
        e.selector.role.length > 128 || e.selector.label_contains.length > 512 ||
        (e.exists !== undefined && e.exists !== true) ||
        (e.value_equals !== undefined && (typeof e.value_equals !== "string" || e.value_equals.length > 4096)) ||
        (e.enabled !== undefined && typeof e.enabled !== "boolean") ||
        (e.selected !== undefined && typeof e.selected !== "boolean") ||
        [e.exists, e.value_equals, e.enabled, e.selected].every((v) => v === undefined)) invalid();
  }
  if ((params.context !== undefined && (typeof params.context !== "string" || params.context.length > 4096)) ||
      (params.previousActions !== undefined && (!Array.isArray(params.previousActions) || params.previousActions.length > 20 || params.previousActions.some((v) => typeof v !== "string" || v.length > 256))) ||
      (params.maxActions !== undefined && (!Number.isSafeInteger(params.maxActions) || params.maxActions < 1 || params.maxActions > 100)) ||
      (params.timeoutMs !== undefined && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1000 || params.timeoutMs > 300000)) ||
      (params.deliveryMode !== undefined && !["background", "foreground"].includes(params.deliveryMode))) invalid();
}

export function driverState(reply: DriverReply): Record<string, unknown> {
  if (reply.isError) throw new ClassifierError("driver", "Driver call failed or was blocked. Inspect the target and permissions before resuming.");
  if (!isRecord(reply.structuredContent)) throw new ClassifierError("driver", "Driver returned no structured state; no input was attempted from that response.");
  return reply.structuredContent;
}

export function observation(reply: DriverReply, target: ComputerUseParams["target"]): DriverObservation {
  const state = driverState(reply);
  if (state.pid !== target.pid || state.window_id !== target.window_id || !Array.isArray(state.elements))
    throw new ClassifierError("driver", "Driver observation did not establish the exact requested window and element list.");
  const elements: DriverElement[] = [];
  const menuIndices = new Set<number>();
  for (const raw of state.elements) {
    if (!isRecord(raw)) continue;
    if (raw.role === "AXMenuBar" || (typeof raw.parent_index === "number" && menuIndices.has(raw.parent_index))) {
      if (typeof raw.element_index === "number") menuIndices.add(raw.element_index);
    }
  }
  for (const raw of state.elements.slice(0, 200)) {
    if (isRecord(raw) && typeof raw.element_index === "number" && menuIndices.has(raw.element_index)) continue;
    if (!isRecord(raw) || typeof raw.role !== "string" || SECRET.test(raw.role + " " + String(raw.label ?? ""))) continue;
    const e: DriverElement = {
      role: raw.role.slice(0, 128), label: typeof raw.label === "string" ? raw.label.slice(0, 1024) : "",
      actions: Array.isArray(raw.actions) ? raw.actions.filter((v): v is string => typeof v === "string").slice(0, 20) : [],
      index: typeof raw.element_index === "number" ? raw.element_index : -1,
    };
    if (typeof raw.value === "string") e.value = raw.value.slice(0, 4096);
    if (typeof raw.enabled === "boolean") e.enabled = raw.enabled;
    if (typeof raw.selected === "boolean") e.selected = raw.selected;
    if (typeof raw.element_token === "string" && /^s[0-9a-f]{8}:[0-9]+$/.test(raw.element_token)) e.token = raw.element_token;
    elements.push(e);
  }
  return {
    elements, truncated: state.truncated === true || state.elements.length > 200,
    degraded: state.degraded === true || Boolean(state.degraded_reason),
    title: typeof state.window_title === "string" ? state.window_title.slice(0, 512) : "",
    // Driver indexes actionable rows only; retain passive state without the global menu subtree.
    text: windowText(state.tree_markdown),
  };
}

/** Root order changes when an app backgrounds; select the window branch, not a prefix. */
function windowText(markdown: unknown): string {
  if (typeof markdown !== "string") return "";
  let inWindow = false;
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^- /.test(line)) inWindow = /^- (?:\[\d+\] )?AXWindow\b/.test(line);
    if (inWindow && !SECRET.test(line)) lines.push(line);
  }
  return lines.join("\n").slice(0, 16000);
}

export function candidates(params: ComputerUseParams, state: DriverObservation): ComputerCandidate[] {
  // Truncated trees cannot establish selector uniqueness; hand back instead of guessing.
  if (state.truncated || state.degraded) return [];
  const result: ComputerCandidate[] = [];
  for (const control of params.controls) {
    const matches = state.elements.filter((e) => e.role === control.selector.role && e.label === control.selector.label);
    if (matches.length !== 1) continue;
    const element = matches[0]!;
    if (!element.token || element.enabled === false || !compatible(control, element)) continue;
    const missingValue = control.operation === "fill" && !Object.hasOwn(params.values ?? {}, control.valueKey);
    if (control.operation === "fill" && !missingValue && element.value === params.values![control.valueKey]) continue;
    result.push({
      id: control.id, control, element, missingValue,
      description: `${control.operation} ${element.role} ${JSON.stringify(element.label)}` +
        (control.operation === "fill" ? ` using supplied value ${control.valueKey}${missingValue ? " (MISSING: hand back for text)" : ""}` : control.operation === "key" ? ` ${control.key}` : ""),
    });
  }
  return result;
}

function compatible(control: ComputerControl, element: DriverElement): boolean {
  if (control.operation === "fill") return EDITABLE.test(element.role);
  if (control.operation === "key") return EDITABLE.test(element.role) || CLICKABLE.test(element.role);
  return CLICKABLE.test(element.role) || element.actions.some((a) => /^(AXPress|press|invoke)$/i.test(a));
}

export function modelElements(state: DriverObservation): unknown[] {
  return state.elements.map(({ token: _token, actions: _actions, index: _index, ...e }) => e);
}

export function captureImage(reply: DriverReply): MemoryImage[] {
  const blocks = (reply.content ?? []).filter((b) => isRecord(b) && b.type === "image");
  if (blocks.length !== 1) throw new ClassifierError("driver", "Expected one window screenshot. No image was silently omitted.");
  const block = blocks[0];
  if (!isRecord(block) || !["image/png", "image/jpeg", "image/webp"].includes(String(block.mimeType)) ||
      typeof block.data !== "string" || block.data.length > 6990508 || (block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)))
    throw new ClassifierError("input", "Driver screenshot exceeds image limits or is not canonical base64.");
  const bytes = Buffer.from(block.data, "base64");
  if (bytes.toString("base64") !== block.data) throw new ClassifierError("input", "Driver image encoding was not canonical base64.");
  return [{ bytes, mimeType: block.mimeType as MemoryImage["mimeType"] }];
}
