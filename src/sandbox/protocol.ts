/**
 * Wire protocol between the host page and the opaque-origin sandbox iframe.
 *
 * The sandbox runs untrusted user code, so it gets `sandbox="allow-scripts"`
 * WITHOUT `allow-same-origin`. That buys real isolation but costs us direct DOM
 * access: the host cannot read `iframe.contentDocument`, and the sandbox's
 * origin serialises as the string "null". Every probe therefore executes inside
 * the sandbox and reports back through these messages.
 *
 * Because the origin is opaque we cannot pin `postMessage` to a real origin.
 * The host must instead verify `event.source === iframe.contentWindow` on every
 * inbound message. See `sandbox-host.ts`.
 */

export const PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Interaction driving                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A single step the agent can take to move the component into a new state.
 *
 * Deliberately a closed vocabulary rather than arbitrary scripting: the agent
 * composes these, it does not author code that runs in the sandbox. Keeps the
 * blast radius small and keeps runs from hanging on a `while (true)`.
 */
export type DriveAction =
  | { kind: "click"; selector: string }
  | { kind: "dblclick"; selector: string }
  | { kind: "hover"; selector: string }
  | { kind: "focus"; selector: string }
  | { kind: "blur"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "key"; key: string; selector?: string }
  | { kind: "tab"; times?: number }
  | { kind: "submit"; selector: string }
  | { kind: "wait"; ms: number };

/* -------------------------------------------------------------------------- */
/* Commands: host -> sandbox                                                  */
/* -------------------------------------------------------------------------- */

export type SandboxCommand =
  /** Compile and mount a component. Replaces whatever was mounted before. */
  | { type: "mount"; source: string; props?: Record<string, unknown> }
  /** Drive the mounted component into a new interaction state. */
  | { type: "drive"; actions: DriveAction[] }
  /** Unmount and clear recorded state without tearing down the iframe. */
  | { type: "reset" }
  /** Run axe-core against the mounted subtree. */
  | { type: "run_axe"; scope?: string }
  /** Structured accessibility tree of the mounted subtree. */
  | { type: "snapshot_a11y_tree" }
  /** Linearised "what a screen reader announces" transcript. */
  | { type: "transcribe_screen_reader" }
  /** Walk tab order; report traps and keyboard-unreachable controls. */
  | { type: "trace_focus_order"; maxTabs?: number }
  /** Liveness check. Used by the watchdog. */
  | { type: "ping" };

export type CommandType = SandboxCommand["type"];

/** An envelope pairs a command with the id used to match its response. */
export interface CommandEnvelope {
  channel: "curb";
  version: number;
  id: string;
  command: SandboxCommand;
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export interface CompileDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

export interface MountResult {
  /** Name of the component that was actually rendered. */
  componentName: string;
  /** True when we had to infer the export because none was declared. */
  exportInferred: boolean;
  /** React dev-mode warnings captured during render. Useful probe signal. */
  reactWarnings: string[];
  /** Milliseconds spent in the initial render commit. */
  renderMs: number;
  /** Count of elements in the mounted subtree. */
  nodeCount: number;
}

export interface DriveResult {
  /** Actions that executed successfully, in order. */
  completed: number;
  /** Element that holds focus after the actions, as a stable selector. */
  activeElement: string | null;
  /** True when focus ended up on document.body — usually a lost-focus defect. */
  focusLostToBody: boolean;
  /** Mutations observed on aria-live regions while driving. */
  liveRegionAnnouncements: string[];
  reactWarnings: string[];
}

export interface AxeViolationNode {
  target: string[];
  html: string;
  failureSummary: string;
}

export interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeViolationNode[];
}

export interface AxeResult {
  violations: AxeViolation[];
  passCount: number;
  incompleteCount: number;
}

export interface PingResult {
  version: number;
  mounted: boolean;
}

/* -------------------------------------------------------------------------- */
/* Responses: sandbox -> host                                                 */
/* -------------------------------------------------------------------------- */

export interface SandboxError {
  message: string;
  stack?: string;
  /** Set when the failure was a compile error rather than a runtime one. */
  diagnostics?: CompileDiagnostic[];
}

export type ResponseEnvelope =
  | { channel: "curb"; version: number; id: string; ok: true; result: unknown }
  | { channel: "curb"; version: number; id: string; ok: false; error: SandboxError };

/** Unsolicited messages the sandbox pushes without a matching command. */
export type SandboxEvent =
  /** Bootstrap is alive and waiting to be handed the runtime source. */
  | { channel: "curb"; version: number; type: "boot-ready" }
  /** Runtime has been evaluated and is accepting commands. */
  | { channel: "curb"; version: number; type: "ready" }
  /** An error escaping the component after mount (event handler, effect, ...). */
  | { channel: "curb"; version: number; type: "runtime-error"; error: SandboxError };

/** Host -> sandbox bootstrap message carrying the runtime source. */
export interface InstallRuntimeMessage {
  channel: "curb";
  version: number;
  type: "install-runtime";
  code: string;
}

export type InboundMessage = ResponseEnvelope | SandboxEvent;

/* -------------------------------------------------------------------------- */
/* Result type mapping                                                        */
/* -------------------------------------------------------------------------- */

// Type-only imports, erased at compile time — the host bundle never pulls in
// axe-core just by importing this protocol.
import type { A11yTreeResult, TranscriptResult } from "./runtime/probes/a11y-tree";
import type { FocusOrderResult } from "./runtime/probes/focus-order";

export type {
  A11yNode,
  A11yTreeResult,
  NameQuality,
  TranscriptLine,
  TranscriptResult,
} from "./runtime/probes/a11y-tree";
export type {
  FocusOrderResult,
  FocusStop,
  UnreachableControl,
} from "./runtime/probes/focus-order";

export interface ResultMap {
  mount: MountResult;
  drive: DriveResult;
  reset: { ok: true };
  run_axe: AxeResult;
  snapshot_a11y_tree: A11yTreeResult;
  transcribe_screen_reader: TranscriptResult;
  trace_focus_order: FocusOrderResult;
  ping: PingResult;
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                     */
/* -------------------------------------------------------------------------- */

export function isInboundMessage(data: unknown): data is InboundMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { channel?: unknown }).channel === "curb"
  );
}

export function isResponse(msg: InboundMessage): msg is ResponseEnvelope {
  return "id" in msg;
}
