/**
 * Minimal line diff.
 *
 * Hand-rolled rather than pulled from npm: the patched source is a whole file,
 * diffs here are small, and adding a dependency to a project whose own report
 * flags bundle weight would be a poor look.
 */

export type DiffKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  /** 1-indexed line number in the original, when present. */
  beforeLine: number | null;
  /** 1-indexed line number in the patched source, when present. */
  afterLine: number | null;
}

export interface DiffHunk {
  beforeStart: number;
  afterStart: number;
  lines: DiffLine[];
}

/** Longest common subsequence over lines, memoised iteratively. */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }

  return table;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const cols = b.length + 1;
  const table = lcsTable(a, b);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i], beforeLine: i + 1, afterLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      out.push({ kind: "removed", text: a[i], beforeLine: i + 1, afterLine: null });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j], beforeLine: null, afterLine: j + 1 });
      j += 1;
    }
  }

  while (i < a.length) {
    out.push({ kind: "removed", text: a[i], beforeLine: i + 1, afterLine: null });
    i += 1;
  }

  while (j < b.length) {
    out.push({ kind: "added", text: b[j], beforeLine: null, afterLine: j + 1 });
    j += 1;
  }

  return out;
}

/** Collapse long runs of unchanged lines, keeping `context` lines either side. */
export function toHunks(lines: DiffLine[], context = 3): DiffHunk[] {
  const changed = lines
    .map((l, index) => (l.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);

  if (!changed.length) return [];

  const hunks: DiffHunk[] = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(lines.length - 1, changed[0] + context);

  for (const index of changed.slice(1)) {
    if (index - context <= end + 1) {
      end = Math.min(lines.length - 1, index + context);
      continue;
    }
    hunks.push(makeHunk(lines, start, end));
    start = Math.max(0, index - context);
    end = Math.min(lines.length - 1, index + context);
  }

  hunks.push(makeHunk(lines, start, end));
  return hunks;
}

function makeHunk(lines: DiffLine[], start: number, end: number): DiffHunk {
  const slice = lines.slice(start, end + 1);
  return {
    beforeStart: slice.find((l) => l.beforeLine !== null)?.beforeLine ?? 0,
    afterStart: slice.find((l) => l.afterLine !== null)?.afterLine ?? 0,
    lines: slice,
  };
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((l) => l.kind === "added").length,
    removed: lines.filter((l) => l.kind === "removed").length,
  };
}
