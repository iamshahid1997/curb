/**
 * Sandbox runtime — runs inside the opaque-origin iframe.
 *
 * Everything here executes alongside untrusted user code, so it holds no
 * secrets and reaches nothing outside the frame. Its only channel is
 * postMessage back to the host. The CSP in the host-generated document blocks
 * `connect-src` entirely, so even a malicious paste cannot exfiltrate.
 */

import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import axe from "axe-core";

import {
  PROTOCOL_VERSION,
  type AxeResult,
  type AxeViolation,
  type CommandEnvelope,
  type DriveAction,
  type DriveResult,
  type MountResult,
  type PingResult,
  type ResponseEnvelope,
  type SandboxError,
} from "../protocol";
import { CompileError, compile } from "./compile";
import { accessibleName, countNodes, resolve, selectorFor } from "./dom";

/* -------------------------------------------------------------------------- */
/* Mount state                                                                */
/* -------------------------------------------------------------------------- */

let root: Root | null = null;
let container: HTMLElement | null = null;
let mounted = false;

/** React dev-mode warnings are genuine probe signal, so we capture them. */
let warnings: string[] = [];

function installConsoleCapture(): void {
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    warnings.push(
      args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .join(" ")
        .slice(0, 500),
    );
    original(...args);
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function drainWarnings(): string[] {
  const drained = Array.from(new Set(warnings));
  warnings = [];
  return drained;
}

function getContainer(): HTMLElement {
  if (!container) {
    container = document.getElementById("curb-root") as HTMLElement | null;
    if (!container) {
      container = document.createElement("div");
      container.id = "curb-root";
      document.body.appendChild(container);
    }
  }
  return container;
}

/* -------------------------------------------------------------------------- */
/* Error boundary                                                             */
/* -------------------------------------------------------------------------- */

interface BoundaryProps {
  children?: React.ReactNode;
  onError: (err: Error) => void;
}
interface BoundaryState {
  failed: boolean;
}

class ErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    if (this.state.failed) {
      return React.createElement(
        "div",
        { role: "alert", "data-curb-render-error": "true" },
        "Component threw during render.",
      );
    }
    return this.props.children;
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

async function handleMount(
  source: string,
  props: Record<string, unknown> | undefined,
): Promise<MountResult> {
  handleReset();

  const { Component, componentName, exportInferred } = compile(source);

  const host = getContainer();
  root = createRoot(host);

  let renderError: Error | null = null;
  const started = performance.now();

  root.render(
    React.createElement(
      ErrorBoundary,
      {
        onError: (err: Error) => {
          renderError = err;
        },
      },
      React.createElement(Component, props ?? {}),
    ),
  );

  // Let React commit and effects flush before we measure or probe.
  await nextFrame();
  await nextFrame();

  const renderMs = performance.now() - started;

  if (renderError) {
    throw new CompileError(
      `Component threw during render: ${(renderError as Error).message}`,
    );
  }

  mounted = true;

  return {
    componentName,
    exportInferred,
    reactWarnings: drainWarnings(),
    renderMs: Math.round(renderMs * 100) / 100,
    nodeCount: countNodes(host),
  };
}

function handleReset(): { ok: true } {
  if (root) {
    try {
      root.unmount();
    } catch {
      /* unmounting a broken tree can throw; nothing useful to do */
    }
    root = null;
  }
  if (container) container.innerHTML = "";
  mounted = false;
  warnings = [];
  return { ok: true };
}

async function handleDrive(actions: DriveAction[]): Promise<DriveResult> {
  requireMounted();

  const announcements: string[] = [];
  const observer = watchLiveRegions(announcements);

  let completed = 0;
  try {
    for (const action of actions) {
      await runAction(action);
      await nextFrame();
      completed += 1;
    }
  } finally {
    observer.disconnect();
  }

  const active = document.activeElement as HTMLElement | null;
  const focusLostToBody = !active || active === document.body;

  return {
    completed,
    activeElement: focusLostToBody ? null : selectorFor(active),
    focusLostToBody,
    liveRegionAnnouncements: announcements,
    reactWarnings: drainWarnings(),
  };
}

async function runAction(action: DriveAction): Promise<void> {
  switch (action.kind) {
    case "wait":
      await sleep(Math.min(action.ms, 2000));
      return;

    case "tab": {
      const times = Math.min(action.times ?? 1, 50);
      for (let i = 0; i < times; i += 1) advanceFocus();
      return;
    }

    case "key": {
      const target = action.selector
        ? (resolve(action.selector) as HTMLElement)
        : ((document.activeElement as HTMLElement | null) ?? document.body);
      dispatchKey(target, action.key);
      return;
    }

    case "type": {
      const el = resolve(action.selector) as HTMLInputElement;
      el.focus();
      setNativeValue(el, action.text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    case "click":
    case "dblclick": {
      const el = resolve(action.selector) as HTMLElement;
      el.dispatchEvent(
        new MouseEvent(action.kind === "click" ? "click" : "dblclick", {
          bubbles: true,
          cancelable: true,
        }),
      );
      return;
    }

    case "hover": {
      const el = resolve(action.selector) as HTMLElement;
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseenter"));
      return;
    }

    case "focus": {
      (resolve(action.selector) as HTMLElement).focus();
      return;
    }

    case "blur": {
      (resolve(action.selector) as HTMLElement).blur();
      return;
    }

    case "submit": {
      const el = resolve(action.selector) as HTMLFormElement;
      el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return;
    }

    default: {
      const exhaustive: never = action;
      throw new Error(`Unknown action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * React attaches its own value setter to inputs, so assigning `.value` directly
 * is swallowed and the component never sees the change. Go through the
 * prototype setter instead.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) descriptor.set.call(el, value);
  else el.value = value;
}

function dispatchKey(target: HTMLElement, key: string) {
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

/**
 * Programmatic Tab. Real tabbing is a browser behaviour we cannot trigger, so we
 * reproduce the traversal against the current focusable set. Re-querying on each
 * step matters: a click may have opened a dialog, and the tab order moves with it.
 */
function advanceFocus(): void {
  // Imported lazily to keep the focus-order probe the single source of truth.
  const focusables = Array.from(
    document.querySelectorAll<HTMLElement>(
      "a[href],button,input,select,textarea,details > summary,[contenteditable],[tabindex]",
    ),
  ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("tabindex") !== "-1");

  if (!focusables.length) return;

  const current = document.activeElement as HTMLElement | null;
  const index = current ? focusables.indexOf(current) : -1;
  const next = focusables[(index + 1) % focusables.length];
  next?.focus();
}

function watchLiveRegions(sink: string[]): MutationObserver {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target =
        record.target.nodeType === Node.ELEMENT_NODE
          ? (record.target as Element)
          : record.target.parentElement;
      const region = target?.closest("[aria-live],[role='alert'],[role='status']");
      if (!region) continue;
      const text = accessibleName(region);
      if (text) sink.push(text);
    }
  });

  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  return observer;
}

async function handleAxe(scope?: string): Promise<AxeResult> {
  requireMounted();

  const context = scope ? resolve(scope) : getContainer();
  const results = await axe.run(context as Element, {
    resultTypes: ["violations"],
    // Screenshots are useless to us and slow the run down considerably.
    elementRef: false,
  });

  const violations: AxeViolation[] = results.violations.map((v) => ({
    id: v.id,
    impact: (v.impact ?? null) as AxeViolation["impact"],
    help: v.help,
    helpUrl: v.helpUrl,
    tags: v.tags,
    nodes: v.nodes.slice(0, 20).map((n) => ({
      target: n.target.map(String),
      html: n.html.slice(0, 400),
      failureSummary: n.failureSummary ?? "",
    })),
  }));

  return {
    violations,
    passCount: results.passes?.length ?? 0,
    incompleteCount: results.incomplete?.length ?? 0,
  };
}

function handlePing(): PingResult {
  return { version: PROTOCOL_VERSION, mounted };
}

function requireMounted(): void {
  if (!mounted) throw new Error("Nothing is mounted. Send a `mount` command first.");
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                   */
/* -------------------------------------------------------------------------- */

async function dispatch(envelope: CommandEnvelope): Promise<unknown> {
  const { command } = envelope;

  switch (command.type) {
    case "mount":
      return handleMount(command.source, command.props);
    case "drive":
      return handleDrive(command.actions);
    case "reset":
      return handleReset();
    case "run_axe":
      return handleAxe(command.scope);
    case "ping":
      return handlePing();
    case "snapshot_a11y_tree":
    case "transcribe_screen_reader":
    case "trace_focus_order":
      throw new Error(`Probe "${command.type}" is not implemented yet.`);
    default: {
      const exhaustive: never = command;
      throw new Error(`Unknown command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function reply(message: ResponseEnvelope): void {
  // Opaque origin: we cannot name a target origin, so the host authenticates by
  // checking event.source instead.
  window.parent.postMessage(message, "*");
}

function toSandboxError(err: unknown): SandboxError {
  if (err instanceof CompileError) {
    return { message: err.message, stack: err.stack, diagnostics: err.diagnostics };
  }
  const e = err as Error;
  return { message: e?.message ?? String(err), stack: e?.stack };
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as CommandEnvelope | undefined;
  if (!data || data.channel !== "curb" || !data.id) return;
  if (event.source !== window.parent) return;

  void dispatch(data)
    .then((result) => {
      reply({
        channel: "curb",
        version: PROTOCOL_VERSION,
        id: data.id,
        ok: true,
        result,
      });
    })
    .catch((err: unknown) => {
      reply({
        channel: "curb",
        version: PROTOCOL_VERSION,
        id: data.id,
        ok: false,
        error: toSandboxError(err),
      });
    });
});

window.addEventListener("error", (event) => {
  window.parent.postMessage(
    {
      channel: "curb",
      version: PROTOCOL_VERSION,
      type: "runtime-error",
      error: { message: event.message, stack: event.error?.stack },
    },
    "*",
  );
});

installConsoleCapture();

window.parent.postMessage(
  { channel: "curb", version: PROTOCOL_VERSION, type: "ready" },
  "*",
);

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Yield long enough for React to commit and effects to flush.
 *
 * Deliberately NOT requestAnimationFrame. rAF only fires for frames the browser
 * is actually painting, so an offscreen or occluded sandbox stops ticking and
 * every probe stalls for seconds. A macrotask hop is not throttled that way and
 * is sufficient for React to finish its work.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
