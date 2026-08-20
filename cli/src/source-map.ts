/**
 * Maps a position in a bundled chunk back to the original source file.
 *
 * This is what lets Curb say "your Button primitive at primitives.tsx:107" for
 * a live DOM node, rather than "some button somewhere". Two things make it
 * work:
 *
 *   - React 19 attaches `_debugStack` to every fiber in development: an Error
 *     created at the JSX call site. React 18's `_debugSource` is gone, and the
 *     `__source` prop from @babel/plugin-transform-react-jsx-source is not
 *     present under Turbopack, so owner stacks are the only route.
 *   - Dev bundles ship source maps, so the chunk position in that stack
 *     resolves to a real file and line.
 *
 * Turbopack emits *sectioned* (index) source maps, which need FlattenMap rather
 * than TraceMap — passing one to TraceMap throws rather than degrading.
 */

import { FlattenMap, TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

/** FlattenMap is a class, so its instance type has to be derived. */
type ResolvedMap = TraceMap | InstanceType<typeof FlattenMap>;

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

interface AnyMap {
  sections?: unknown;
}

export class SourceMapResolver {
  private readonly maps = new Map<string, ResolvedMap | null>();

  constructor(private readonly projectRoot: string) {}

  /** Resolve a bundled position, or null when no usable map exists. */
  async resolve(
    chunkUrl: string,
    line: number,
    column: number,
  ): Promise<SourceLocation | null> {
    const map = await this.mapFor(chunkUrl);
    if (!map) return null;

    const pos = originalPositionFor(map, { line, column });
    if (!pos?.source || pos.line == null) return null;

    const file = this.normalise(pos.source);

    // A location inside a dependency is not actionable — nobody is going to
    // patch next/link to fix their own page. Owner stacks routinely resolve
    // into framework internals when a component is rendered by one, and
    // reporting those as root causes is noise at best and misleading at worst.
    if (isDependency(file)) return null;

    return { file, line: pos.line, column: pos.column ?? 0 };
  }

  private async mapFor(chunkUrl: string): Promise<ResolvedMap | null> {
    const cached = this.maps.get(chunkUrl);
    if (cached !== undefined) return cached;

    try {
      const chunk = await fetch(chunkUrl).then((r) => r.text());
      const marker = chunk.match(/\/\/# sourceMappingURL=(\S+)/);

      if (!marker) {
        this.maps.set(chunkUrl, null);
        return null;
      }

      const mapUrl = new URL(marker[1], chunkUrl).href;
      const json = (await fetch(mapUrl).then((r) => r.json())) as AnyMap;

      // Turbopack ships sectioned maps; TraceMap throws on those.
      const map = json.sections
        ? new FlattenMap(json as never)
        : new TraceMap(json as never);

      this.maps.set(chunkUrl, map);
      return map;
    } catch {
      this.maps.set(chunkUrl, null);
      return null;
    }
  }

  /** Turn a source-map entry into a path relative to the project root. */
  private normalise(source: string): string {
    let file = source;

    // Webpack/Turbopack prefixes vary: webpack://_N_E/./src/x.tsx, file:///…
    file = file.replace(/^webpack:\/\/[^/]*\//, "");
    file = file.replace(/^file:\/\//, "");
    file = file.replace(/^\.\//, "");

    try {
      file = decodeURIComponent(file);
    } catch {
      /* leave as-is if it is not percent-encoded */
    }

    const rootIndex = file.indexOf(this.projectRoot);
    if (rootIndex >= 0) {
      file = file.slice(rootIndex + this.projectRoot.length).replace(/^\//, "");
    }

    return file;
  }
}

/** Paths the user does not own and cannot reasonably be asked to change. */
function isDependency(file: string): boolean {
  return (
    file.includes("node_modules") ||
    file.startsWith("webpack/") ||
    file.startsWith("next/") ||
    file.includes("/.next/")
  );
}

/* -------------------------------------------------------------------------- */
/* Stack parsing                                                              */
/* -------------------------------------------------------------------------- */

/** Frames that are React's own machinery, never the app's JSX. */
const INTERNAL_FRAME =
  /node_modules|react-stack-bottom-frame|react-stack-top-frame|jsxDEV|renderWithHooks|beginWork|performWorkOn/;

export interface ParsedFrame {
  url: string;
  line: number;
  column: number;
}

/**
 * Pull the first application frame out of an owner stack.
 *
 * The top frames are always React internals; the first frame below them is the
 * component that rendered the element.
 */
export function firstAppFrame(stack: string | null | undefined): ParsedFrame | null {
  if (!stack) return null;

  for (const rawLine of stack.split("\n")) {
    if (!rawLine.includes("http")) continue;
    if (INTERNAL_FRAME.test(rawLine)) continue;

    const match = rawLine.match(/(https?:\/\/[^\s)]+):(\d+):(\d+)/);
    if (!match) continue;

    return { url: match[1], line: Number(match[2]), column: Number(match[3]) };
  }

  return null;
}
