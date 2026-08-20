"use client";

/**
 * Live sandbox render with a violation overlay.
 *
 * The overlay only exists because the sandbox measures for us. The frame has an
 * opaque origin, so the host cannot read `contentDocument` and cannot ask the
 * browser where anything is — every box here came back over postMessage from
 * `measure_boxes`. Coordinates map 1:1 because the sandbox viewport is the
 * iframe's own rendered size.
 */

import { useEffect, useRef, useState } from "react";
import type { MeasuredBox } from "@/sandbox/protocol";

export type OverlayKind = "violation" | "focus" | "unreachable";

export interface Overlay {
  selector: string;
  kind: OverlayKind;
  /** Tab position, for focus overlays. */
  order?: number;
  label: string;
}

const KIND_STYLE: Record<OverlayKind, { border: string; bg: string; fg: string }> = {
  violation: { border: "var(--critical)", bg: "color-mix(in srgb, var(--critical) 12%, transparent)", fg: "var(--critical)" },
  unreachable: { border: "var(--serious)", bg: "color-mix(in srgb, var(--serious) 12%, transparent)", fg: "var(--serious)" },
  focus: { border: "var(--accent)", bg: "transparent", fg: "var(--accent)" },
};

export function SandboxPreview({
  frameHostRef,
  overlays,
  boxes,
  showOverlays,
}: {
  frameHostRef: React.RefObject<HTMLDivElement | null>;
  overlays: Overlay[];
  boxes: MeasuredBox[];
  showOverlays: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [, forceRerender] = useState(0);

  // Boxes are in sandbox coordinates; if the host resizes, they are stale until
  // the next measure. Re-render on resize so the layer at least repositions
  // with its container rather than drifting.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => forceRerender((n) => n + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const byySelector = new Map(boxes.filter((b) => b.found).map((b) => [b.selector, b]));

  return (
    <div ref={wrapperRef} className="relative">
      <div
        ref={frameHostRef}
        className="h-[340px] w-full overflow-hidden"
        style={{ background: "#fff" }}
      />

      {showOverlays && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        >
          {overlays.map((overlay) => {
            const box = byySelector.get(overlay.selector);
            if (!box || box.width === 0) return null;
            const style = KIND_STYLE[overlay.kind];

            return (
              <div
                key={`${overlay.kind}-${overlay.selector}`}
                className="absolute"
                style={{
                  left: box.x,
                  top: box.y,
                  width: box.width,
                  height: box.height,
                  border: `2px solid ${style.border}`,
                  background: style.bg,
                  borderRadius: 3,
                }}
              >
                {/*
                  Dark chip with white text rather than the kind colour as a
                  background: at 9px bold, white on the accent measures ~3.2:1,
                  which our own audit flagged. The coloured border still carries
                  the meaning, and this stays legible over any component.
                */}
                <span
                  className="absolute -top-[9px] left-0 whitespace-nowrap rounded px-1 text-[9px] font-bold leading-[14px]"
                  style={{
                    background: "#0d0d10",
                    color: "#ffffff",
                    border: `1px solid ${style.border}`,
                  }}
                >
                  {overlay.order !== undefined ? overlay.order : overlay.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
