import { limits } from "./limits";
import type { Polarity, Verdict } from "./types";

export type HunkLine = {
  kind: "add" | "del" | "ctx";
  line: number | null;
  text: string;
};

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Turns a unified diff patch into lines with new-file line numbers.
export function parseHunks(patch: string): HunkLine[] {
  const out: HunkLine[] = [];
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      line = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") out.push({ kind: "add", line: line++, text });
    else if (marker === "-") out.push({ kind: "del", line: null, text });
    else out.push({ kind: "ctx", line: line++, text });
  }
  return out;
}

// What the model sees: marker, new-file line number, content.
export function renderHunks(
  lines: HunkLine[],
  maxChars: number = limits.charsPerModelCall
): { text: string; truncated: boolean } {
  const rows: string[] = [];
  let chars = 0;
  let previous: number | null = null;
  for (const l of lines) {
    if (l.line !== null && previous !== null && l.line > previous + 1) {
      rows.push("@@");
    }
    if (l.line !== null) previous = l.line;
    const marker = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
    const number = l.line === null ? "" : String(l.line);
    const row = `${marker}${number.padStart(6)} | ${l.text}`;
    chars += row.length + 1;
    if (chars > maxChars) {
      rows.push("[diff cut here: over the size cap]");
      return { text: rows.join("\n"), truncated: true };
    }
    rows.push(row);
  }
  return { text: rows.join("\n"), truncated: false };
}

export function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Finds the shown line a quote came from: added lines first, exact match before substring.
export function findQuote(quote: string, lines: HunkLine[]): HunkLine | null {
  const first = quote.split("\n").find((s) => s.trim());
  const q = first ? normalise(first.replace(/^[+-]?\s*\d*\s*\|\s?/, "")) : "";
  if (q.length < limits.quoteMinChars) return null;
  const order: HunkLine["kind"][] = ["add", "ctx", "del"];
  for (const kind of order) {
    const hit = lines.find((l) => l.kind === kind && normalise(l.text) === q);
    if (hit) return hit;
  }
  for (const kind of order) {
    const hit = lines.find(
      (l) => l.kind === kind && normalise(l.text).includes(q)
    );
    if (hit) return hit;
  }
  return null;
}

// A verdict that says something is present must quote it. Absence cannot be quoted.
export function assertsPresence(verdict: Verdict, polarity: Polarity): boolean {
  return (
    (verdict === "FAIL" && polarity === "must_not") ||
    (verdict === "PASS" && polarity === "must")
  );
}

const PATH_TOKEN =
  /(?<![\w/])((?:[\w.-]+\/)+[\w-]*(?:\.[\w-]+)*|[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|cpp|c|h|swift|md|json|ya?ml|toml|css|scss|html|sql|sh))(?::(\d+))?(?![\w/])/g;

// Steps may name files. A file the checker never saw is marked, so the reader
// knows the location was not verified.
export function annotateSteps(
  steps: string[],
  paths: Set<string>,
  ownPath: string,
  lines: HunkLine[]
): string[] {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/") + "/");
    }
  }
  return steps.slice(0, limits.stepsPerFinding).map((step) =>
    step.replace(PATH_TOKEN, (token: string, path: string, line?: string) => {
      const known =
        paths.has(path) ||
        path === ownPath ||
        dirs.has(path) ||
        dirs.has(path + "/") ||
        [...paths].some((p) => p.startsWith(path + "."));
      if (!known) return `${token} (not in this PR)`;
      if (
        line &&
        path === ownPath &&
        !lines.some((l) => l.line === Number(line))
      ) {
        return `${token} (line not in the diff)`;
      }
      return token;
    })
  );
}

// The flagged line with a few neighbours, for a second look.
export function renderContext(
  lines: HunkLine[],
  line: number,
  radius = 3
): string {
  return lines
    .filter((l) => l.line !== null && Math.abs(l.line - line) <= radius)
    .map(
      (l) =>
        `${l.line === line ? ">" : " "}${String(l.line).padStart(6)} | ${l.text}`
    )
    .join("\n");
}
