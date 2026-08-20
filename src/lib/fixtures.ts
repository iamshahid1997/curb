/**
 * Demo components.
 *
 * `TicketCard` is deliberately broken, and broken across both halves of the
 * claim: plain accessibility defects a rule engine passes, plus coupled
 * accessibility/performance patterns. It is synthetic — a real open-source
 * component would be more credible and less legible, and legibility wins for a
 * 60-second demo. Anything pasted into the editor gets the same treatment.
 */

export interface Fixture {
  id: string;
  name: string;
  blurb: string;
  source: string;
}

export const FIXTURES: Fixture[] = [
  {
    id: "ticket-card",
    name: "TicketCard",
    blurb: "Scores well on a rule engine. Unusable with a keyboard.",
    source: `import { Bell, ChevronDown } from "lucide-react";

const TicketCard = React.memo(function TicketCard({ ticket }) {
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  return (
    <div className="card animate-pulse transition-all duration-300">
      <h3>Ticket</h3>
      <img src="/hero.png" alt="image1" loading="lazy" />

      <div onClick={() => setOpen(true)}>
        Open details <ChevronDown />
      </div>

      <button><Bell /></button>

      <a href="/terms" tabIndex={3}>Terms</a>
      <input placeholder="Field 2" />

      <div aria-live="polite">{ticket?.status}</div>

      {saving && <div>Saving…</div>}

      {open && (
        <div role="dialog">
          <h4>Details</h4>
          <p>Seat 14A, gate B7.</p>
          <button onClick={() => setSaving(true)}>Save</button>
          <button onClick={() => setOpen(false)}>Close</button>
        </div>
      )}
    </div>
  );
});`,
  },
  {
    id: "clean-card",
    name: "AccessibleCard",
    blurb: "A control. If Curb invents findings here, Curb is wrong.",
    source: `function AccessibleCard() {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <section aria-labelledby="card-title">
      <h2 id="card-title">Boarding pass</h2>

      <img
        src="/seat-map.png"
        alt="Seat map showing seat 14A beside the window in row 14"
      />

      <button
        aria-expanded={expanded}
        aria-controls="card-details"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? "Hide flight details" : "Show flight details"}
      </button>

      {expanded && (
        <div id="card-details">
          <p>Gate B7, boarding at 14:20.</p>
        </div>
      )}

      <label htmlFor="ref">Booking reference</label>
      <input id="ref" name="ref" />
    </section>
  );
}`,
  },
];

export const DEFAULT_FIXTURE = FIXTURES[0];
