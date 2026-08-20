"use client";

/**
 * Isolates why a sandboxed iframe does or does not execute the runtime script.
 * Frames self-identify by index so matching never depends on window identity.
 */

import { useEffect, useState } from "react";

type Variant = {
  name: string;
  sandbox: boolean;
  csp: boolean;
  mode: "srcdoc" | "src";
};

const VARIANTS: Variant[] = [
  { name: "A: sandbox + CSP (srcdoc)", sandbox: true, csp: true, mode: "srcdoc" },
  { name: "B: sandbox, no CSP (srcdoc)", sandbox: true, csp: false, mode: "srcdoc" },
  { name: "C: no sandbox + CSP (srcdoc)", sandbox: false, csp: true, mode: "srcdoc" },
  { name: "D: sandbox, real src URL", sandbox: true, csp: false, mode: "src" },
  { name: "E: no sandbox, real src URL", sandbox: false, csp: false, mode: "src" },
];

const csp = (origin: string) =>
  [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin}`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "connect-src 'none'",
  ].join("; ");

function srcdocFor(origin: string, withCsp: boolean, index: number): string {
  const meta = withCsp
    ? `<meta http-equiv="Content-Security-Policy" content="${csp(origin)}">`
    : "";
  return `<!doctype html><html><head>${meta}
<script>
var I='${index}';
parent.postMessage({__probe:1,i:I,stage:'inline-ran'},'*');
window.addEventListener('error',function(ev){
  parent.postMessage({__probe:1,i:I,stage:'error',msg:String(ev.message||''),src:String((ev.target&&ev.target.src)||'')},'*');
},true);
<\/script>
<script src="${origin}/sandbox/runtime.js"
  onload="parent.postMessage({__probe:1,i:'${index}',stage:'script-onload'},'*')"
  onerror="parent.postMessage({__probe:1,i:'${index}',stage:'script-onerror'},'*')"><\/script>
</head><body><div id="curb-root"></div></body></html>`;
}

export default function BootDiagnostic() {
  const [events, setEvents] = useState<Record<number, string[]>>({});
  const [unmatched, setUnmatched] = useState<string[]>([]);

  useEffect(() => {
    const origin = window.location.origin;
    const frames: HTMLIFrameElement[] = [];

    const onMessage = (e: MessageEvent) => {
      const data = e.data as Record<string, unknown> | undefined;
      if (!data) return;

      const isProbe = data.__probe === 1;
      const isCurb = data.channel === "curb";
      if (!isProbe && !isCurb) return;

      // Curb "ready" events carry no index, so fall back to window identity.
      let index = isProbe ? Number(data.i) : NaN;
      if (Number.isNaN(index)) {
        index = frames.findIndex((f) => f.contentWindow === e.source);
      }

      const detail = isCurb
        ? `curb:${String(data.type)}`
        : [data.stage, data.msg, data.src].filter(Boolean).join(" | ");

      if (index < 0 || Number.isNaN(index)) {
        setUnmatched((prev) => [...prev, detail]);
        return;
      }

      setEvents((prev) => ({ ...prev, [index]: [...(prev[index] ?? []), detail] }));
    };

    window.addEventListener("message", onMessage);

    VARIANTS.forEach((v, i) => {
      const f = document.createElement("iframe");
      if (v.sandbox) f.setAttribute("sandbox", "allow-scripts");
      f.style.cssText = "position:absolute;left:-9999px;width:300px;height:200px";
      if (v.mode === "src") f.src = `${origin}/sandbox/frame.html?i=${i}`;
      else f.srcdoc = srcdocFor(origin, v.csp, i);
      document.body.appendChild(f);
      frames.push(f);
    });

    return () => {
      window.removeEventListener("message", onMessage);
      frames.forEach((f) => f.remove());
    };
  }, []);

  return (
    <main style={{ font: "13px ui-monospace, monospace", padding: 24 }}>
      <h1>sandbox boot diagnostic</h1>
      {VARIANTS.map((v, i) => (
        <pre key={v.name} style={{ background: "#f4f4f5", padding: 8, marginBottom: 8 }}>
          {v.name}
          {"\n"}
          {(events[i] ?? []).length
            ? (events[i] ?? []).map((e) => `  -> ${e}`).join("\n")
            : "  (nothing)"}
        </pre>
      ))}
      <pre style={{ background: "#fef2f2", padding: 8 }}>
        unmatched:{"\n"}
        {unmatched.length ? unmatched.map((e) => `  -> ${e}`).join("\n") : "  (none)"}
      </pre>
    </main>
  );
}
