import Link from "next/link";

import { Card, CopyCommand, Reveal, Section, ThemeToggle } from "@/components/landing";
import { Terminal } from "@/components/terminal";
import {
  RECORDED_RUN,
  SHOWCASE_FINDINGS,
  SHOWCASE_VERIFICATION,
  type ShowcaseFinding,
} from "@/lib/recorded-run";

export const metadata = {
  title: "Curb — the accessibility audit that fixes your code",
  description:
    "An agent that drives your real pages through real interaction states, judges what a rule engine cannot, and ships patches it has verified. Accessibility and performance, in one pass.",
};

const SEVERITY: Record<ShowcaseFinding["severity"], { fg: string; bg: string }> = {
  critical: { fg: "var(--critical)", bg: "var(--critical-bg)" },
  serious: { fg: "var(--serious)", bg: "var(--serious-bg)" },
  moderate: { fg: "var(--moderate)", bg: "var(--moderate-bg)" },
  minor: { fg: "var(--minor)", bg: "var(--minor-bg)" },
};

export default function Home() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:px-3 focus:py-2"
        style={{ background: "var(--accent)", color: "var(--accent-text)" }}
      >
        Skip to content
      </a>

      <header
        className="sticky top-0 z-40 border-b backdrop-blur"
        style={{ borderColor: "var(--border)", background: "color-mix(in srgb, var(--bg) 82%, transparent)" }}
      >
        <nav
          aria-label="Main"
          className="mx-auto flex max-w-[1080px] items-center gap-6 px-6 py-3.5"
        >
          <span className="text-[15px] font-semibold tracking-[-0.01em]">Curb</span>

          <div className="ml-auto flex items-center gap-5 text-[13px]">
            {/* Hidden below sm: three links plus a toggle in 375px wraps
                "How it works" onto three lines. The content they point at is
                all reachable by scrolling, and Playground stays available from
                the hero and the footer. */}
            <Link href="#how" className="hidden sm:inline" style={{ color: "var(--text-muted)" }}>
              How it works
            </Link>
            <Link href="/playground" className="hidden sm:inline" style={{ color: "var(--text-muted)" }}>
              Playground
            </Link>
            <a
              href="https://github.com/iamshahid1997/curb"
              className="hidden sm:inline"
              style={{ color: "var(--text-muted)" }}
            >
              GitHub
            </a>
            <ThemeToggle />
          </div>
        </nav>
      </header>

      <main id="main">
        {/* ---------------------------------------------------------------- */}
        {/* Hero                                                             */}
        {/* ---------------------------------------------------------------- */}
        <div className="relative">
          <div className="curb-grid pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />

          <div className="mx-auto max-w-[1080px] px-6 pb-16 pt-20 md:pt-28">
            <Reveal>
              <p
                className="mb-5 inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11.5px] font-medium"
                style={{
                  border: "1px solid var(--correlation-border)",
                  background: "var(--correlation-bg)",
                  color: "var(--correlation)",
                }}
              >
                Accessibility × performance, in one pass
              </p>

              <h1 className="max-w-[17ch] text-[clamp(2.2rem,6vw,4rem)] font-semibold leading-[1.03] tracking-[-0.035em]">
                Your audit tool stops at the list.
              </h1>

              <p
                className="mt-6 max-w-[58ch] text-[clamp(1rem,1.6vw,1.15rem)] leading-[1.6]"
                style={{ color: "var(--text-muted)" }}
              >
                Curb drives your real pages through the states nobody audits, judges the
                things a rule engine structurally cannot, traces every defect to the line
                that caused it — and ships a patch it has already re-measured.
              </p>
            </Reveal>

            <Reveal delay={120}>
              <div className="mt-9 flex flex-wrap items-center gap-4">
                <CopyCommand command="npx curb" />
                <Link
                  href="/playground"
                  className="rounded-lg px-4 py-2.5 text-[13.5px] font-medium"
                  style={{ background: "var(--accent)", color: "var(--accent-text)" }}
                >
                  Try it in the browser →
                </Link>
              </div>
              <p className="mt-3 text-[12.5px]" style={{ color: "var(--text-faint)" }}>
                Reports and changes nothing by default. <code style={{ fontFamily: "var(--font-mono)" }}>--fix</code>{" "}
                is the deliberate act.
              </p>
            </Reveal>

            <Reveal delay={220} className="mt-14">
              <Terminal lines={RECORDED_RUN} title="curb — audit" />
              <p className="mt-3 text-[12px]" style={{ color: "var(--text-faint)" }}>
                A real session, transcribed verbatim — including the quota error that ended
                it. Nothing here is a mockup.
              </p>
            </Reveal>
          </div>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* The gap                                                          */}
        {/* ---------------------------------------------------------------- */}
        <Section
          eyebrow="The gap"
          title="Detection is solved. Remediation isn't."
          lede={
            <>
              Lighthouse and axe are good at finding things, and Curb uses axe for exactly
              that. The cost is everything after: a human reads each item, finds the source,
              works out the intent, writes a fix, and re-checks by hand. That loop costs more
              than most teams will pay, so the list becomes a backlog and never clears.
            </>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-[13.5px]">
              <caption className="sr-only">
                Comparison of a page auditor against Curb
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="border-b px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.1em]"
                    style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
                  >
                    A page auditor
                  </th>
                  <th
                    scope="col"
                    className="border-b px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-[0.1em]"
                    style={{ borderColor: "var(--border)", color: "var(--accent-ink)" }}
                  >
                    Curb
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "Audits the state currently rendered",
                    "Drives into the open dialog, the error, the submitted form — and probes each",
                  ],
                  [
                    "Checks an accessible name exists",
                    "Judges whether it means anything. alt=\"image1\" passes every rule engine",
                  ],
                  [
                    "Reports symptoms in the built artifact",
                    "Resolves each element to the JSX line that rendered it",
                  ],
                  [
                    "Lists N violations",
                    "Groups them by shared origin — 40 from one primitive is one finding",
                  ],
                  [
                    "Doesn't know React exists",
                    "Reads handlers off the fiber, catching a <div onClick> no selector can find",
                  ],
                  [
                    "Scores accessibility and performance separately",
                    "Reports where they collide",
                  ],
                  [
                    "Hands you a list",
                    "Patches, re-probes every route, and rolls back anything that regresses",
                  ],
                ].map(([before, after], i) => (
                  <tr key={i}>
                    <td
                      className="border-b px-4 py-3.5 align-top"
                      style={{ borderColor: "var(--border)", color: "var(--text-faint)" }}
                    >
                      {before}
                    </td>
                    <td
                      className="border-b px-4 py-3.5 align-top"
                      style={{ borderColor: "var(--border)", color: "var(--text)" }}
                    >
                      {after}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* How it works                                                     */}
        {/* ---------------------------------------------------------------- */}
        <Section
          id="how"
          eyebrow="The mechanism"
          title="The model never gets to say a fix worked."
          lede={
            <>
              Curb splits the work between a deterministic oracle and a judgement model. The
              oracle — axe-core, an accessibility tree, a spec-correct focus tracer, real Core
              Web Vitals — owns everything decidable. The model owns meaning. Then the oracle
              grades the model.
            </>
          }
        >
          <ol className="grid gap-3 md:grid-cols-5">
            {[
              { n: "01", t: "Probe", d: "Every route, every state the agent can reach." },
              { n: "02", t: "Locate", d: "Each element traced to its JSX line via React owner stacks." },
              { n: "03", t: "Judge", d: "The model reads evidence and decides what actually matters." },
              { n: "04", t: "Patch", d: "It writes the fix into your source file." },
              { n: "05", t: "Verify", d: "Every route re-probed. Regressions rolled back byte-for-byte." },
            ].map((step, i) => (
              <li key={step.n}>
                <Reveal delay={i * 70}>
                  <Card className="h-full">
                    <span
                      className="text-[11px] font-semibold tracking-[0.1em]"
                      style={{ color: "var(--accent-ink)", fontFamily: "var(--font-mono)" }}
                    >
                      {step.n}
                    </span>
                    <h3 className="mt-2 text-[14.5px] font-semibold">{step.t}</h3>
                    <p className="mt-1.5 text-[12.5px] leading-[1.55]" style={{ color: "var(--text-muted)" }}>
                      {step.d}
                    </p>
                  </Card>
                </Reveal>
              </li>
            ))}
          </ol>

          <Reveal delay={200}>
            <Card
              className="mt-4"
              accent="var(--correlation-border)"
            >
              <p className="text-[13.5px] leading-[1.6]">
                <strong>The invariant:</strong> the agent cannot apply a patch — it can only
                call a tool whose return value <em>is</em> the oracle&rsquo;s verdict. There is no
                code path where a fix is reported without every probe having re-run. That is
                structural, not a matter of prompting.
              </p>
            </Card>
          </Reveal>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Coupled findings                                                 */}
        {/* ---------------------------------------------------------------- */}
        <Section
          eyebrow="The part nothing else ships"
          title="Where your performance work broke your accessibility."
          lede={
            <>
              Accessibility and performance are audited as separate categories with separate
              scores, so the places they trade against each other go unreported by both. Curb
              runs six rules that pair a performance decision with the accessibility cost it
              silently incurs.
            </>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              {
                id: "C1",
                t: "memo around a live region",
                d: "Skipping the re-render means the DOM never mutates, so the update is never announced.",
              },
              {
                id: "C2",
                t: "content-visibility / virtualization",
                d: "Content leaves the accessibility tree. Screen readers can't browse it; in-page find won't match it.",
              },
              {
                id: "C3",
                t: "Skeleton with no aria-busy",
                d: "Fixes layout shift, and is read aloud as if it were real content.",
              },
              {
                id: "C4",
                t: "Painted before operable",
                d: "A long task after first paint means it looks ready while keystrokes are dropped.",
              },
              {
                id: "C5",
                t: "The LCP element is lazy-loaded",
                d: "Measured, not guessed — the browser names the element, and it carries loading=\"lazy\".",
              },
              {
                id: "C7",
                t: "Animation with no motion guard",
                d: "Vestibular risk and main-thread cost. One guard removes both.",
              },
            ].map((rule, i) => (
              <Reveal key={rule.id} delay={i * 60}>
                <Card className="h-full" accent="var(--correlation-border)">
                  <div className="flex items-baseline gap-2">
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                      style={{
                        background: "var(--correlation-bg)",
                        color: "var(--correlation)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {rule.id}
                    </span>
                    <h3 className="text-[14px] font-semibold">{rule.t}</h3>
                  </div>
                  <p className="mt-2 text-[12.5px] leading-[1.6]" style={{ color: "var(--text-muted)" }}>
                    {rule.d}
                  </p>
                </Card>
              </Reveal>
            ))}
          </div>

          <Reveal delay={200}>
            <p className="mt-5 text-[12.5px] leading-[1.6]" style={{ color: "var(--text-faint)" }}>
              These rules were derived from known failure modes, not measured against a
              corpus. Their real-world frequency is not yet established, and that number gets
              published either way.
            </p>
          </Reveal>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Real findings                                                    */}
        {/* ---------------------------------------------------------------- */}
        <Section
          eyebrow="From a completed run"
          title="Four defects axe reported zero violations for."
          lede={
            <>
              These come from a run against a deliberately broken card component, in the
              browser mode you can try below. The rule engine passed every one of them.
            </>
          }
        >
          <ul className="grid gap-3">
            {SHOWCASE_FINDINGS.map((finding, i) => (
              <li key={finding.title}>
                <Reveal delay={i * 60}>
                  <Card
                    accent={finding.kind === "correlation" ? "var(--correlation-border)" : undefined}
                    className={finding.kind === "correlation" ? "" : ""}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                        style={{
                          color: SEVERITY[finding.severity].fg,
                          background: SEVERITY[finding.severity].bg,
                        }}
                      >
                        {finding.severity}
                      </span>
                      {finding.kind === "correlation" && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{
                            color: "var(--correlation)",
                            background: "var(--correlation-bg)",
                            border: "1px solid var(--correlation-border)",
                          }}
                        >
                          a11y × perf
                        </span>
                      )}
                      {!finding.caughtByAxe && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ color: "var(--ok)", background: "var(--ok-bg)" }}
                        >
                          axe missed this
                        </span>
                      )}
                    </div>

                    <h3 className="text-[15px] font-semibold leading-snug">{finding.title}</h3>
                    <p className="mt-1.5 text-[13px] leading-[1.6]" style={{ color: "var(--text-muted)" }}>
                      {finding.detail}
                    </p>
                    <p className="mt-1.5 text-[13px] leading-[1.6]" style={{ color: "var(--text-muted)" }}>
                      <span style={{ color: "var(--text-faint)" }}>Impact: </span>
                      {finding.impact}
                    </p>
                    <p
                      className="mt-2.5 rounded px-2.5 py-1.5 text-[11.5px] leading-[1.5]"
                      style={{
                        background: "var(--code-bg)",
                        color: "var(--text-muted)",
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {finding.evidence}
                    </p>
                  </Card>
                </Reveal>
              </li>
            ))}
          </ul>

          <Reveal delay={200}>
            <Card className="mt-4" accent="var(--ok)">
              <p className="mb-3 text-[13px] font-semibold" style={{ color: "var(--ok)" }}>
                Patch verified and accepted
              </p>
              <div className="flex flex-wrap gap-2">
                {SHOWCASE_VERIFICATION.deltas.map((d) => (
                  <span
                    key={d.label}
                    className="rounded px-2 py-1 text-[11.5px]"
                    style={{ background: "var(--ok-bg)", color: "var(--ok)", fontFamily: "var(--font-mono)" }}
                  >
                    {d.label} {d.before} → {d.after}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-[12.5px]" style={{ color: "var(--text-muted)" }}>
                And it said what it could <em>not</em> fix: {SHOWCASE_VERIFICATION.residual}
              </p>
            </Card>
          </Reveal>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* Limitations                                                      */}
        {/* ---------------------------------------------------------------- */}
        <Section
          eyebrow="Read this part"
          title="What Curb does not do."
          lede="A tool that argues for honest measurement has to be honest about itself."
        >
          <ul className="grid gap-2.5 md:grid-cols-2">
            {[
              ["It does not certify compliance.", "Automated checks cover roughly 30–40% of WCAG. Curb reduces defects; it does not make you conformant."],
              ["The screen-reader transcript is a model.", "Browsers don't expose their accessibility tree to JavaScript. Names come from axe's ACCNAME implementation; the linearisation is ours and approximate."],
              ["The coupled rules are unvalidated.", "Derived from known failure modes, not measured against a corpus. Frequency unknown."],
              ["Dev-server numbers are inflated.", "Bundle size and long tasks are dev-mode artefacts. Treat them as relative, not production figures."],
              ["The focus-indicator check often abstains.", "Programmatic focus doesn't reliably trigger :focus-visible, so it reports \"indeterminate\" rather than guessing."],
              ["A full CLI loop hasn't finished yet.", "The free tier allows 20 requests per model per day, and a whole-page audit spends them quickly."],
            ].map(([title, body], i) => (
              <li key={title}>
                <Reveal delay={i * 50}>
                  <Card className="h-full">
                    <h3 className="text-[13.5px] font-semibold">{title}</h3>
                    <p className="mt-1.5 text-[12.5px] leading-[1.6]" style={{ color: "var(--text-muted)" }}>
                      {body}
                    </p>
                  </Card>
                </Reveal>
              </li>
            ))}
          </ul>
        </Section>

        {/* ---------------------------------------------------------------- */}
        {/* CTA                                                              */}
        {/* ---------------------------------------------------------------- */}
        <section className="mx-auto w-full max-w-[1080px] px-6 pb-28">
          <Reveal>
            <div
              className="rounded-2xl px-8 py-12 text-center"
              style={{ border: "1px solid var(--border-strong)", background: "var(--bg-raised)" }}
            >
              <h2 className="text-[clamp(1.4rem,3vw,2rem)] font-semibold tracking-[-0.02em]">
                Point it at your app.
              </h2>
              <p
                className="mx-auto mt-3 max-w-[46ch] text-[14px] leading-[1.6]"
                style={{ color: "var(--text-muted)" }}
              >
                It boots your dev server, finds your routes, and tells you what a keyboard
                user actually experiences.
              </p>
              <div className="mt-7 flex flex-wrap justify-center gap-3">
                <CopyCommand command="npx curb" />
              </div>
            </div>
          </Reveal>
        </section>
      </main>

      <footer className="border-t" style={{ borderColor: "var(--border)" }}>
        <div className="mx-auto flex max-w-[1080px] flex-wrap items-center gap-4 px-6 py-8 text-[12.5px]">
          <span style={{ color: "var(--text-faint)" }}>
            Built by{" "}
            <a href="https://github.com/iamshahid1997" style={{ color: "var(--text-muted)" }}>
              Shahid Ansari
            </a>
          </span>
          <div className="ml-auto flex gap-5">
            <Link href="/playground" style={{ color: "var(--text-muted)" }}>
              Playground
            </Link>
            <a href="https://github.com/iamshahid1997/curb" style={{ color: "var(--text-muted)" }}>
              Source
            </a>
          </div>
        </div>
      </footer>
    </>
  );
}
