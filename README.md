# Curb

An agent that drives a React component through its real interaction states, judges what a rule engine structurally cannot, and ships a patch it has already verified.

The claim is not detection. Detection is solved — axe-core is excellent and Curb uses it. The claim is that **a patch is never surfaced as a fix unless the oracle re-ran and confirmed it**, and that the whole loop costs nothing because the expensive half runs in your browser.

---

## What it does that a page auditor cannot

| Lighthouse / axe | Curb |
|---|---|
| Audits the state currently rendered | Drives the component into its **other states** — opens the modal, triggers the error — and probes each |
| Checks an accessible name **exists** | Judges whether it **means** anything. `alt="image1"` and a field labelled "Field 2" pass every rule engine |
| Reports symptoms in the built artifact | Reads the **source**: which import, which memo boundary, which conditional branch |
| Lists N violations | Groups them by **root cause** |
| Doesn't know React exists | Reads handlers off the fiber — catches a `<div onClick>` that no `[onclick]` selector will ever match |
| Accessibility and performance scored **separately** | Reports where they **collide** |
| Hands you a list | Patches, re-probes every visited state, and reports what it could *not* fix |

That last-but-one row is the part nothing else ships.

### Coupled accessibility × performance findings

Six deterministic rules pair a performance decision with the accessibility cost it silently incurs:

| Rule | The trade nobody reports |
|---|---|
| C1 | `React.memo` around an `aria-live` region — updates stop being announced |
| C2 | `content-visibility` / virtualization — content leaves the accessibility tree, in-page find breaks |
| C3 | A skeleton fixes layout shift and is read aloud as if it were content, with no `aria-busy` |
| C5 | `loading="lazy"` on the image most likely to be the largest contentful paint |
| C7 | Animation with no `prefers-reduced-motion` guard — vestibular risk *and* main-thread cost |
| C8 | A barrel icon import ships the whole set, and the icons carry no accessible name |

These emit **candidates with evidence**, not findings. The agent judges each in context. Detection stays mechanical; judgement stays modelled.

---

## Why it's free to run

The verify-repair loop is the expensive part of an agent like this, and here it costs nothing, because it runs on the visitor's machine:

| Work | Where | Cost |
|---|---|---|
| Rendering, axe-core, accessibility tree, focus tracing, AST | Your browser | **$0** |
| Every verification and repair iteration | Your browser | **$0** |
| Planning, semantic judgement, patch authoring | Gemini free tier | **$0** to quota |
| Replaying a recorded run | Your browser | **$0**, always |

Because verification is free, the agent can afford to verify obsessively. The cost model isn't an implementation detail — it's what makes the central claim affordable.

---

## Architecture

```
Browser                                   Server
┌─────────────────────────────┐          ┌────────────────────┐
│ App shell + trace UI        │◄────────►│ /api/agent/step    │
│ Agent loop (owns the run)   │  1 hop   │ key + system prompt│
├─────────────────────────────┤  /step   └────────────────────┘
│ Tool executor               │
│  ├ axe-core                 │  The loop runs client-side because every
│  ├ a11y tree + transcript   │  tool is a browser API. A server-side loop
│  ├ focus-order tracer       │  would cost a network round trip per probe,
│  ├ Babel AST analyser       │  and a run makes many.
│  └ box measurement          │
├─────────────────────────────┤
│ Sandbox iframe              │
│ sandbox="allow-scripts"     │  No allow-same-origin: pasted code gets an
│ (opaque origin)             │  opaque origin and cannot touch the host.
└─────────────────────────────┘
```

**Stack:** Next.js 16, React 19, TypeScript, Tailwind 4, AI SDK 7, axe-core 4.13, Babel standalone.

### Three things that were harder than expected

**An opaque-origin frame cannot load our own scripts.** Not via `srcdoc`, and in some environments not even its own document via `src`. Inline scripts inside a sandboxed `srcdoc` *do* run, so the host fetches `runtime.js` over ordinary same-origin HTTP (still cached) and hands the source to a tiny bootstrap over `postMessage`, which evaluates it. The CSP ended up stricter as a result — it whitelists no origin for scripts at all.

**A hostile component cannot be timed out from inside.** A `while (true)` wedges the sandbox's main thread, so no timer in the frame will ever fire. The host watchdog destroys and rebuilds the iframe instead. Verified against exactly that input.

**A backgrounded tab silently breaks geometry.** Every `getBoundingClientRect` returns `0x0`, so every focusable element was filtered out and the probe reported "nothing focusable" — which the agent would read as *this component has no keyboard problems*. Geometry probes now refuse to run without layout, and the loop waits for visibility rather than failing.

---

## Honest limitations

Read this section before believing anything above.

- **Automated checks cover roughly 30–40% of WCAG.** Curb reduces defects. It does not certify conformance and must never be described as doing so.
- **The screen-reader transcript is a model, not a capture.** Browsers do not expose their accessibility tree to JavaScript. Accessible names come from axe's ACCNAME implementation, but the linearisation is ours and approximate.
- **The correlation rules are unvalidated.** They were derived from known failure modes, not measured against a corpus. Their real-world frequency is unknown. Measuring it is the next task, and the number gets published either way.
- **Core Web Vitals are deliberately absent.** LCP/CLS/INP are page-level. Measuring them against one component in an iframe yields authoritative-looking nonsense, so the perf signals here are component-scoped (source weight, barrel imports, render cost) and C5 is labelled a source-level heuristic rather than a measurement.
- **Unresolvable imports are stubbed.** `lucide-react` and friends render as placeholder spans so real code can be audited at all. Stubs pass through `aria-*`/`role`/`class` so they can't mask a defect, and the agent is told which subtrees are not real.
- **The focus-indicator check often reports `indeterminate`.** Programmatic `.focus()` doesn't reliably trigger `:focus-visible`, so it says "I can't tell" rather than guessing.
- **The sandbox runtime is 3.3MB minified (~610KB brotli).** Babel is 2.4MB of it. It's a one-time cached load in an iframe, and it's stated here rather than hidden, given what this tool reports on.
- **Free-tier quota is 20 requests per model per day** — roughly two live audits. This is why recorded runs exist.

---

## Running it

```bash
npm install
npm run dev
```

Add a free key from [aistudio.google.com/apikey](https://aistudio.google.com/apikey):

```bash
echo 'GOOGLE_GENERATIVE_AI_API_KEY=your-key' > .env.local
```

Without a key the app still mounts components and runs every probe — only the agent needs one.

```bash
npm run typecheck    # tsc --noEmit
npm run build        # builds the sandbox bundle, then Next
```

---

## Status

Working: sandbox and watchdog, probe toolkit, agent loop with verified patching, correlation engine, product UI, cassette replay.

Not done: corpus validation of the correlation rules, multi-file/repo mode, real Core Web Vitals via URL mode, extracting the probe toolkit as a standalone package.
