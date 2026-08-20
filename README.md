# Curb

**An agentic frontend reviewer that finds accessibility and performance defects in React components, fixes them in source, and proves the fix held.**

> Named for the *curb cut* — the ramp built for wheelchair users that turned out to help everyone pushing a stroller, a suitcase, or a delivery cart. Accessibility work is rarely only accessibility work.

> **Status: early development.** The sandbox harness (isolated iframe, in-browser compilation, DOM bridge) is in place. The agent loop, probe suite, and UI are being built. Nothing here is production-ready — the claims below describe the target, not a shipped tool.

---

## The problem

Frontend teams ship inaccessible and slow interfaces continuously, while owning tools that already told them so.

The failure is not detection — detection is solved. The failure is the **economics of remediation**. Lighthouse, axe, and WAVE produce a list. A human then reads each item, locates the source, understands intent, writes a fix, and re-verifies by hand. That loop costs more than most teams will pay, so the list becomes a backlog nobody clears.

Three structural gaps make it worse:

**The static-frame gap.** Automated audits run against one rendered state, usually initial paint. Most real failures live in interaction — modals that trap focus, route changes that drop focus to `<body>`, errors that never reach a live region. A page can score 100 and be unusable with a keyboard.

**The semantic gap.** `alt="image1"` passes every rule engine. So do forty buttons labelled "Click here" and an input labelled "Field 2". Rule engines check whether an accessible name *exists*, never whether it is *useful*.

**The coupling gap.** Accessibility and performance are audited as separate categories with separate scores, yet they trade against each other constantly. A team optimises render cost and silently breaks a screen reader. Nothing in their toolchain will ever tell them.

## How it works

Curb splits the work between a **deterministic oracle** and a **judgment model**:

- The **oracle** — `axe-core`, the accessibility tree, focus tracing, React Profiler, AST analysis — handles everything decidable. It runs entirely in the browser, so it is free and repeatable.
- The **agent** handles what needs judgment: semantics, intent, prioritisation, and authoring the patch.
- The **oracle then gates the agent.** Probes re-run against the patched source, and a patch that fails verification is never presented as a fix.

```
ingest(source)
  → plan()               # which interaction states matter
  → for each state:
      drive(actions)     # reach it
      probe(*)           # run the oracle
  → diagnose()           # cluster, root-cause, correlate
  → patch()              # author a source diff
  → verify()             # re-mount, re-probe, diff results
  → repair() if regressed
  → report()
```

Tools are **declared server-side and executed client-side**: the model plans, and the visitor's browser runs the measurements against a sandboxed iframe. That is what makes an unbounded verify-repair loop affordable.

### Verified vs. asserted

Not every finding can be machine-checked, and Curb does not pretend otherwise:

| Finding class | Example | Gated by the oracle? |
|---|---|---|
| **Oracle-verified** | Focus lost to `<body>` after a state change; an `aria-live` region inside a memoised subtree that stops announcing | **Yes** — re-probed before and after the patch |
| **Model-asserted** | `alt="image1"` is technically valid but useless; forty buttons all labelled "Click here" | **No** — flagged as judgment, surfaced with lower confidence |

Semantic quality has no deterministic oracle. Those findings are labelled as judgment calls rather than laundered through a verification claim that cannot apply to them.

## What Curb is not

- **Not an accessibility overlay.** Overlays are widely condemned and legally counterproductive. Curb changes source; it never patches runtime DOM in production.
- **Not a compliance certification.** Deque reports that automated testing with axe covers [~57% of WCAG issues](https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues/); broader industry estimates for automation run lower. Curb reduces defects. It does not certify conformance and must never imply it.
- **Not a Lighthouse replacement.** Lighthouse measures whole pages. Curb operates on components and source. Different unit of analysis.
- **Not a general code reviewer.** Scoped to accessibility and performance, where a deterministic oracle exists. That scope is what makes it credible.

## On Core Web Vitals

LCP, CLS, and INP are *page-level* metrics. Measuring them against a single component in an iframe produces numbers that look authoritative and mean nothing. Curb reports component-appropriate signals instead — render counts, wasted renders, estimated bundle contribution, long tasks during interaction — and deliberately does not display a fake LCP. Real Core Web Vitals arrive with URL mode.

## Cost

Rendering, axe, tree snapshots, focus tracing, profiling, and AST analysis all run in the visitor's browser at zero marginal cost. Only planning, semantic judgment, and patch authoring reach a model. Because verification is free, the agent can afford to verify obsessively — the cost structure is not an operational footnote, it is what makes the central claim affordable.

## Self-audit

Curb must pass its own audit: full keyboard operability, correct live-region usage for streaming content, `prefers-reduced-motion` honoured, WCAG 2.2 AA. The result ships here. A failing self-audit is a release blocker.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind · Zustand · AI SDK · `axe-core` · Babel standalone · sandboxed cross-origin iframe (`allow-scripts`, no `allow-same-origin`)

## Documentation

Full product requirements — probe contracts, the correlation-rule catalog, risks, and open questions: **[docs/PRD.md](./docs/PRD.md)**

## Development

```bash
npm install
npm run dev            # http://localhost:3000
npm run build:sandbox
npm run typecheck
```

---

Built by [Shahid Ansari](https://github.com/iamshahid1997).
