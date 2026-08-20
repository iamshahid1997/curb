# Curb — Product Requirements Document

**Status:** Draft v0.1 — awaiting sign-off
**Author:** Shahid Ansari
**Last updated:** 2026-08-20

---

## 1. Summary

Curb is an agentic frontend reviewer that finds accessibility and performance defects in React components, **fixes them in source**, and **proves the fix held** by re-running a deterministic in-browser oracle against the patched code.

Its distinguishing claim is not detection. Detection is solved. Its claim is:

1. It audits components across **interaction states**, not one static frame.
2. It makes **semantic judgments** that rule engines structurally cannot encode.
3. It traces violations to **source root causes** rather than reporting symptoms.
4. It **patches and verifies**, closing the report-to-fix gap.
5. It reports **where performance work broke accessibility** — a coupled analysis no existing tool ships.

---

## 2. Problem

Frontend teams ship inaccessible and slow interfaces, continuously, while owning tools that already told them so.

The failure is not detection, it is **economics of remediation**. Lighthouse, axe, and WAVE produce a list. A human then reads each item, locates the source, understands intent, writes a fix, and re-verifies by hand. That loop costs more than most teams will pay, so the list is triaged into a backlog and never cleared. The tools' output is not the product; it is the beginning of the work.

Three structural gaps make the loop worse than it looks:

**The static-frame gap.** Automated audits run against one rendered state, usually initial paint. Most real accessibility failures live in interaction — modals that trap focus, route changes that drop focus to `<body>`, error messages that never reach a live region, disclosure widgets unreachable by keyboard. A page can score 100 and be unusable with a keyboard.

**The semantic gap.** `alt="image1"` passes every rule engine. So do forty buttons labelled "Click here", a heading hierarchy that is visually correct and structurally meaningless, and a form input labelled "Field 2". Rule engines check for the *presence* of an accessible name, never its *usefulness*. Deque's own guidance is that automation catches roughly 30–40% of WCAG issues; the rest needs judgment.

**The coupling gap.** Accessibility and performance are audited as independent categories with independent scores. In practice they trade against each other constantly, and the trade is invisible because no tool looks at both at once. A team optimises render cost and silently breaks a screen reader. Nothing in their toolchain will ever tell them.

### 2.1 Why now

- **Regulatory pressure.** The European Accessibility Act became enforceable in June 2025, moving a11y from "should" to "must" for a large class of products.
- **Verification is free in the browser.** `axe-core`, the accessibility tree, `PerformanceObserver`, and React's `<Profiler>` all run client-side at zero marginal cost. An agent can therefore afford an unbounded verify-repair loop.
- **Agentic patching is newly viable.** Frontier models can write a correct ARIA fix; what they lacked was a ground-truth oracle to stop them shipping a confident wrong one. That oracle exists and is free.

---

## 3. Goals and non-goals

### Goals

| # | Goal |
|---|---|
| G1 | Detect a11y and performance defects a rule engine cannot: interaction-state failures, semantic emptiness, source-level perf causes |
| G2 | Produce a **verified** source patch — never surface a fix the oracle has not confirmed |
| G3 | Report **coupled a11y↔perf regressions** as first-class findings |
| G4 | Cost approximately zero to operate at portfolio traffic levels |
| G5 | Be legible to a non-expert in under 60 seconds |
| G6 | Demonstrate senior frontend engineering in the artifact itself |

### Non-goals

- **Not an accessibility overlay.** Overlays are widely condemned and legally counterproductive. Curb changes source, never runtime DOM in production.
- **Not a compliance certification.** Curb reduces defects; it does not certify WCAG conformance and must never imply it.
- **Not a Lighthouse replacement.** Lighthouse measures whole-page field and lab performance. Curb operates on components and source. Different unit of analysis. Complementary, not competitive.
- **Not a CI product in V1.** No GitHub App, no PR bot, no auth. Deliberate.
- **Not a general code reviewer.** Scoped to a11y and perf, where a deterministic oracle exists. That scope is what makes it credible.

---

## 4. Users

**Primary — the frontend developer on a team with no accessibility specialist.** Knows the audit is failing, does not know which of the 57 violations matter, has no budget to find out. Wants a diff, not a lecture.

**Secondary — the senior/staff engineer owning a design system.** Cares that one Button primitive is generating forty downstream violations. Wants root cause, not instances.

**Tertiary, and stated honestly — the engineering hiring manager evaluating this project.** This is a portfolio artifact and that shapes real requirements: it must run without signup, demo in under a minute, cost nothing, and hold up to a senior engineer reading the source. Where this conflicts with product purity, it wins in V1.

### Jobs to be done

- "Tell me which of these violations actually matter and why."
- "Fix it and show me the diff."
- "Show me it still works and I broke nothing."
- "Tell me if the thing I did for speed hurt somebody."

---

## 5. Competitive landscape

| Tool | What it does well | Gap Curb addresses |
|---|---|---|
| **Lighthouse** | Page-level lab metrics, broad audit, ubiquitous | One state, built artifact only, no semantic judgment, no fixes, a11y and perf scored separately |
| **axe DevTools (Deque)** | Best-in-class rule engine; Intelligent Guided Tests add human-in-loop coverage | Detection-first; guided tests need a human operator; no autonomous source patching or verification loop |
| **WAVE** | Excellent visual reporting for manual review | Reporting only; no source access; no fixes |
| **Bundle analyzers** | Accurate artifact composition | Post-build symptoms; no source intent; no remediation; a11y-blind |
| **React Scan / why-did-you-render** | Precise render diagnostics | Diagnosis only; no fixes; a11y-blind |
| **CodeRabbit / Greptile** | Broad agentic PR review | General purpose; no deterministic a11y/perf oracle, so findings are unverified opinion |
| **Accessibility overlays** | — | Actively harmful; named here as an anti-pattern Curb must not resemble |

**Honest assessment.** Deque is the serious incumbent and out-detects Curb on rule coverage; that is not the axis Curb competes on. Curb's defensible position is the **verified remediation loop** and the **coupled a11y↔perf analysis**. If Deque shipped autonomous verified patching tomorrow, Curb's differentiation would reduce to the coupling analysis alone.

---

## 6. Differentiation thesis

> Rule engines answer *what is wrong*. Curb answers *why, whether it matters, what the fix is, and whether the fix worked* — and it is the only tool that looks at accessibility and performance in the same pass.

The architecture that makes this possible is a **division of labour between a deterministic oracle and a judgment model**:

- The **oracle** (`axe-core`, a11y tree, focus tracer, Profiler, AST) handles everything decidable. Free, repeatable, trustworthy.
- The **agent** handles everything requiring judgment — semantics, intent, prioritisation, patch authoring.
- The **oracle then gates the agent.** No patch reaches the user until re-running every probe confirms violations went down and nothing regressed.

This inverts the usual failure mode of LLM code tools. The model is never the judge of its own work.

---

## 7. Core concepts

| Term | Definition |
|---|---|
| **Subject** | The React component under audit (V1: pasted source; V2: a repo path) |
| **State** | A distinct interaction state of the subject — default, modal-open, error, loading, expanded |
| **Probe** | A deterministic client-side measurement returning structured facts |
| **Finding** | A defect with severity, evidence, source location, and a root-cause link |
| **Correlation** | A finding coupling an a11y defect to a perf decision, or the reverse |
| **Patch** | A unified source diff proposed by the agent |
| **Verification** | Re-running all probes against the patched subject and diffing results |
| **Run** | One complete plan → probe → diagnose → patch → verify → repair cycle, recorded to a **cassette** |
| **Cassette** | Serialised run record enabling free replay with no model calls |

---

## 8. Functional requirements

### 8.1 The agent loop

```
ingest(source)
  → plan()                  # which states to visit, which probes matter
  → for each state:
      drive(actions)        # reach the state
      probe(*)              # run the oracle
  → diagnose()              # cluster, root-cause, correlate
  → patch()                 # author a source diff
  → verify()                # re-mount, re-probe, diff results
  → repair() if regressed   # bounded retries, failure fed back
  → report()
```

**FR-1** The agent must plan which interaction states to explore from the source, not from a fixed script.
**FR-2** Every write must be gated by verification. A patch that fails verification is never presented as a fix.
**FR-3** The repair loop must be bounded (default 3 attempts per finding) with a hard token/time budget per run.
**FR-4** The full trace — plan, tool calls, results, retries, dead ends — must be visible to the user. Failed attempts are shown, not hidden.
**FR-5** A run must be serialisable to a cassette and replayable with zero model calls.

### 8.2 Probe contracts

All probes execute **in the browser**, inside the sandbox, and cost nothing.

| Probe | Returns | Detects |
|---|---|---|
| `mount(source, props?)` | mount id, compile diagnostics | Build failures |
| `drive(actions[])` | state id, DOM delta | — (state traversal) |
| `run_axe(scope?)` | violations with node refs | Mechanical WCAG failures |
| `snapshot_a11y_tree()` | accessibility tree | Structure, exposed names/roles |
| `transcribe_screen_reader()` | linear transcript | Semantic emptiness, reading-order defects |
| `trace_focus_order(maxTabs)` | focus sequence, traps, unreachable controls | Focus traps, tab-order defects, keyboard-dead controls |
| `profile_renders(interaction)` | per-component render counts, wasted renders | Re-render storms, missing memo boundaries |
| `analyze_source(source)` | imports, barrel imports, est. weight, memo/effect/aria facts | Source-level perf causes |
| `apply_and_verify(diff)` | before/after probe delta, regression list | Whether the fix held |

**Deliberate scope note on Core Web Vitals.** LCP, CLS, and INP are *page-level* metrics. Measuring them against a single component mounted in an iframe produces numbers that look authoritative and mean nothing. V1 therefore reports component-appropriate perf signals — render counts, wasted renders, estimated bundle contribution, long tasks during interaction — and explicitly does **not** display a fake LCP. Real CWV arrive in V2 with URL/repo mode. Shipping an honest metric set over an impressive-looking one is a deliberate product decision.

### 8.3 Root-cause clustering

**FR-6** Findings sharing a source origin must be collapsed into one root-cause finding with an instance count. "40 violations from `<Button>`" is the finding; the 40 instances are evidence.

### 8.4 Correlation catalog

The differentiating analysis. Each rule pairs a performance decision with the accessibility cost it silently incurs.

| ID | Coupled failure | Detection | Confidence |
|---|---|---|---|
| C1 | Memoised subtree contains `aria-live`; updates no longer announce | AST (`memo`/`useMemo`) + MutationObserver shows no mutation on state change | Runtime-verifiable |
| C2 | `content-visibility: auto` or virtualization removes content from the a11y tree; in-page find breaks | CSS/windowing-lib detection + a11y tree missing nodes present in data | Runtime-verifiable |
| C3 | Skeleton screen fixes CLS but is read aloud as content; no `aria-busy` | Loading-state swap + SR transcript contains skeleton text | Runtime-verifiable |
| C4 | Visually ready but not operable — paint completes before handlers attach | Time gap between paint and first successfully handled synthetic keydown | Runtime-verifiable |
| C5 | LCP-candidate image carries `loading="lazy"` | Largest paint candidate + `loading` attribute | Runtime-verifiable |
| C6 | Focus lost to `<body>` after route/state change | `activeElement` after `drive()` | Runtime-verifiable |
| C7 | Animation without `prefers-reduced-motion` guard — vestibular risk and main-thread cost | AST + computed style | Heuristic |
| C8 | Icon barrel import ships whole set; icons also unlabelled | Import analysis + missing accessible names | Heuristic |

**Honest status.** These eight rules were derived from reasoning about known failure modes, **not from measurement against a corpus.** Their real-world frequency is unvalidated. Validation is a V1 exit criterion (§13): run Curb against a set of real open-source components and publish the observed hit rate, including if it is low. If these prove rare, the correct reframing is "rare but expensive and otherwise undetectable" — not a quiet deletion of the section.

---

## 9. User flow

1. Land on the app. A cursed demo component is preloaded. No signup.
2. Press **Audit**. The trace begins streaming immediately.
3. Watch the agent plan, drive the component into its modal-open and error states, and probe each.
4. Findings populate live, grouped by root cause, with a11y↔perf correlations flagged distinctly.
5. Inspect any finding: violation overlaid on the live render, screen-reader transcript, focus path.
6. Press **Fix**. The agent patches, re-verifies, and shows the diff plus before/after deltas — including any repair attempt that failed.
7. Copy the diff, or paste your own component and run it again.

---

## 10. UX requirements

The interface is a deliverable, not a wrapper.

| Screen element | Requirement |
|---|---|
| **Agent trace** | Streaming timeline: plan, tool calls, results, retries, dead ends. Never a spinner. |
| **Live render** | Sandboxed component with violation overlays anchored to real nodes |
| **Screen-reader transcript** | What a blind user actually hears, as readable text. Primary legibility device for non-experts. |
| **Focus path visualizer** | Animated tab order over the render; traps and skipped controls called out |
| **Findings panel** | Grouped by root cause; correlations visually distinct from ordinary findings |
| **Diff viewer** | Unified diff with per-finding attribution |
| **Before/after** | Probe deltas side by side, regressions highlighted |

**Non-negotiable:** Curb must pass its own audit. Full keyboard operability, correct live-region usage for streaming content, `prefers-reduced-motion` honoured, WCAG 2.2 AA. The self-audit result ships in the README. A failing self-audit is a release blocker.

---

## 11. Architecture

```
Browser                                  Server (Vercel)
┌────────────────────────────┐          ┌──────────────────────┐
│  App shell (Next 16 RSC)   │          │  /api/agent          │
│  Zustand run store         │◄────────►│  AI SDK streamText   │
│  Trace / findings / diff   │  stream  │  Gemini free tier    │
├────────────────────────────┤          │  (BYO key supported) │
│  Tool executor             │          └──────────────────────┘
│   ├ axe-core               │
│   ├ a11y tree + SR transcript        Tools are DECLARED server-side,
│   ├ focus tracer                     EXECUTED client-side. The model
│   ├ React Profiler                   never touches user source on the
│   └ Babel AST analyzer               server beyond planning context.
├────────────────────────────┤
│  Sandbox iframe            │
│  sandbox="allow-scripts"   │
│  (no allow-same-origin)    │
│  Babel standalone + React  │
└────────────────────────────┘
```

**Stack:** Next.js 16 (App Router), TypeScript, Tailwind, Zustand, AI SDK 7 (`@ai-sdk/google`), `axe-core` 4.13, Babel standalone. Deployed on Vercel free tier.

**Client-side tool execution.** Tools are declared to the model without an `execute` implementation, so the SDK forwards the call to the client, which runs it against the sandbox and returns the result. This is what makes the verify-repair loop free — and it is a genuine architectural decision worth defending in review.

---

## 12. Cost model

| Work | Where | Marginal cost |
|---|---|---|
| Rendering, axe, a11y tree, focus tracing, profiling, AST | Visitor's browser | **$0** |
| Verify-repair iterations | Visitor's browser | **$0** |
| Planning, semantic judgment, patch authoring | Gemini free tier (1,500 req/day, no card) | **$0** up to quota |
| Demo runs | Replayed from cassettes | **$0**, always |
| Hosting | Vercel free tier | **$0** |

**Design consequence:** because verification is free, the agent can afford to verify obsessively. The cost structure is not an operational detail; it is what makes the product's central claim affordable.

**Quota exhaustion behaviour:** fall back to cassette replay and offer BYO-key. The demo must never present a broken state to a visitor.

---

## 13. Success metrics

**Product**
- ≥70% of mechanical findings auto-fixed and verified without human edit
- **Zero** unverified patches surfaced as fixes (hard invariant)
- <5% of runs introduce a regression that verification fails to catch
- Median run under 45s on the demo fixture

**Credibility (V1 exit criteria)**
- Curb scores 100 on its own audit, published
- Validated against ≥10 real open-source components with the hit rate published, favourable or not
- Correlation rule frequency measured and reported honestly

**Portfolio**
- Live URL, public repo, written case study covering failure modes and fixes
- Demo comprehensible to a non-engineer in under 60 seconds

---

## 14. Scope

### V1 — one build session

- Single pasted React component
- Probes: `mount`, `drive`, `run_axe`, `snapshot_a11y_tree`, `transcribe_screen_reader`, `trace_focus_order`, `analyze_source`
- Agent loop with patch, verify, bounded repair
- Correlation rules **C1, C3, C6** (highest confidence, runtime-verifiable, demonstrable on one component)
- Root-cause clustering
- UI: trace timeline, live render with overlays, SR transcript, focus path, findings, diff, before/after
- One cursed demo fixture + recorded cassette
- Deployed, self-audited, README

**Explicitly deferred from V1:** `profile_renders`, remaining correlation rules, share links, repo mode.

### V1.1 — same week
- `profile_renders` and correlation rules C2, C4, C5, C7, C8
- Multi-component paste
- Shareable run URLs
- Corpus validation run and published results

### V2 — if it earns it
- GitHub repo mode: real root-cause clustering across a design system
- Live URL mode with genuine Core Web Vitals
- CI integration / PR bot
- Extractable OSS package for the probe toolkit

---

## 15. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Sandbox escape from untrusted pasted code** | High | Cross-origin iframe without `allow-same-origin`, strict CSP with `connect-src 'none'`, execution timeout. Reviewed before deploy. |
| **Correlation rules turn out to be rare in real code** | High | Corpus validation is a V1 exit criterion; publish the number either way and reframe rather than hide |
| **Free tier changes or is withdrawn** | Medium | BYO-key, multi-provider adapter, cassette replay as permanent fallback |
| **Agent writes a plausible but wrong ARIA fix** | Medium | Oracle gating — unverified patches are never surfaced. This is the architecture's whole point. |
| **V1 scope exceeds one session** | Medium | Correlation rules and probes are independently droppable; the loop plus three rules is a complete product |
| **Reads as "yet another AI wrapper"** | Medium | Lead with the oracle and the verification invariant, not the model |
| **Implied compliance guarantee** | Medium | Explicit disclaimer; automation covers ~40% of WCAG and the UI must say so |

---

## 16. Open questions

1. **Demo fixture realism.** A component with five planted defects is legible but obviously synthetic. Use a real open-source component with genuine defects instead, accepting a less tidy demo?
2. **Scope of `drive()`.** Should the agent author arbitrary interaction scripts, or choose from a constrained vocabulary? Arbitrary is more impressive and more likely to hang.
3. **Presenting failed repairs.** Showing dead ends is honest and demonstrates the loop, but risks reading as "the agent is unreliable." Default to showing them?
4. **Name.** Curb is memorable but obscure. Alternative framing may communicate faster.
5. **Correlation-first or a11y-first framing?** Correlation is the novel claim; a11y-with-fixes is the legible one. Which leads the landing page?

---

## 17. Positioning for the resume

Draft — to be rewritten against measured outcomes, not intentions:

> Built an agentic frontend auditor that drives React components through their interaction states, root-causes accessibility and performance defects to source, and ships verified patches — gating every fix behind a deterministic in-browser oracle (axe-core, accessibility tree, focus tracing, AST analysis) so no unverified change is ever surfaced. Architected client-side tool execution so the verify-repair loop runs in the visitor's browser at zero marginal cost. Surfaces coupled accessibility/performance regressions that page-level auditors cannot detect.

**Numbers to fill in after validation:** auto-fix rate, corpus size, correlation hit rate, self-audit score.
