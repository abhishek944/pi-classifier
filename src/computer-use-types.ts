import type { ClassifierResult, ClassifierRoute } from "./types.js";

export interface ComputerUseSettings {
  enabled: boolean;
  route?: ClassifierRoute;
  screenshots?: boolean;
  minConfidence?: number;
}

export interface ComputerTarget {
  pid: number;
  window_id: number;
}

/** Exact semantic names are re-resolved on every observation, never cached tokens. */
export interface ControlSelector {
  role: string;
  label: string;
}

export type ComputerControl = {
  id: string;
  selector: ControlSelector;
} & (
  | { operation: "click" }
  | { operation: "fill"; valueKey: string }
  | { operation: "key"; key: string }
);

export interface ComputerExpectation {
  element: {
    selector: { role: string; label_contains: string };
    exists?: true;
    value_equals?: string;
    selected?: boolean;
    enabled?: boolean;
  };
}

export interface ComputerUseParams {
  goal: string;
  target: ComputerTarget;
  controls: ComputerControl[];
  values?: Record<string, string>;
  expect?: ComputerExpectation[];
  /** Supervisor notes and prior actions are context, not success or authorization evidence. */
  context?: string;
  previousActions?: string[];
  maxActions?: number;
  timeoutMs?: number;
  deliveryMode?: "background" | "foreground";
}

export interface DriverElement {
  role: string;
  label: string;
  value?: string;
  enabled?: boolean;
  selected?: boolean;
  actions: string[];
  token?: string;
  index: number;
}

export interface DriverObservation {
  elements: DriverElement[];
  truncated: boolean;
  degraded: boolean;
  title: string;
  /** Bounded window-only passive text, because indexed elements omit static labels. */
  text: string;
}

export interface ComputerCandidate {
  id: string;
  description: string;
  control: ComputerControl;
  element: DriverElement;
  missingValue: boolean;
}

export interface ComputerUseMetrics {
  elapsedMs: number;
  observationMs: number;
  decisionMs: number;
  actionMs: number;
  verificationMs: number;
  decisions: number;
  attemptedActions: number;
  providerCalls: number;
  usage?: ClassifierResult["usage"];
  cost?: ClassifierResult["cost"];
  /** A failed/cancelled request may have been billed without usable accounting. */
  accountingIncomplete: boolean;
}

export interface ComputerUseResult {
  status: "completed" | "handoff" | "stopped";
  reason: string;
  message: string;
  provider: string;
  model: string;
  target: ComputerTarget;
  actions: { control: string; operation: string; effect: string }[];
  metrics: ComputerUseMetrics;
  decision?: { choice: string; confidence: number; probability: number };
  evidence?: { status: string; predicates: unknown[] };
  handoff?: {
    next: string;
    controls: { id: string; available: boolean; missingValue: boolean }[];
    /** Plain task context. Re-call after supervisor work; the next run always observes anew. */
    continuation: ComputerUseParams;
  };
}

/** A raw MCP CallToolResult, already routed through the host's tool/approval pipeline. */
export interface DriverReply {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type DriverCall = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<DriverReply>;
