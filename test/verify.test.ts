import { describe, expect, it } from "vitest";
import {
  annotateSteps,
  assertsPresence,
  chunkLines,
  fileLines,
  findQuote,
  normalise,
  parseHunks,
  renderHunks
} from "../src/checker/verify";

const PATCH = [
  "@@ -1,4 +1,5 @@",
  ' import a from "a";',
  '-import b from "b";',
  '+import b from "./b";',
  '+import c from "c";',
  " ",
  " export const x = 1;",
  "@@ -20,3 +21,4 @@ function f() {",
  "   return 1;",
  " }",
  "+console.log(x);",
  "\\ No newline at end of file"
].join("\n");

const lines = parseHunks(PATCH);

describe("parseHunks", () => {
  it("numbers lines by the new file and leaves removed lines unnumbered", () => {
    expect(lines.map((l) => [l.kind, l.line])).toEqual([
      ["ctx", 1],
      ["del", null],
      ["add", 2],
      ["add", 3],
      ["ctx", 4],
      ["ctx", 5],
      ["ctx", 21],
      ["ctx", 22],
      ["add", 23]
    ]);
    expect(lines[8].text).toBe("console.log(x);");
  });
});

describe("fileLines", () => {
  const content = [
    'import a from "a";',
    'import b from "./b";',
    'import c from "c";',
    "",
    "export const x = 1;",
    ...Array.from({ length: 15 }, (_, i) => `// ${i + 6}`),
    "  return 1;",
    "}",
    "console.log(x);"
  ].join("\n");

  it("marks added lines, keeps the rest as context and shows removed lines in place", () => {
    const full = fileLines(content + "\n", PATCH);
    expect(full).toHaveLength(24);
    expect(full.slice(0, 4).map((l) => [l.kind, l.line, l.text])).toEqual([
      ["ctx", 1, 'import a from "a";'],
      ["del", null, 'import b from "b";'],
      ["add", 2, 'import b from "./b";'],
      ["add", 3, 'import c from "c";']
    ]);
    expect(full[9]).toEqual({ kind: "ctx", line: 9, text: "// 9" });
    expect(full[23]).toEqual({
      kind: "add",
      line: 23,
      text: "console.log(x);"
    });
  });

  it("puts a deletion at the end of the file after the last line and strips CR", () => {
    const full = fileLines("a\r\nb\r\n", "@@ -1,3 +1,2 @@\n a\n b\n-c");
    expect(full.map((l) => [l.kind, l.line, l.text])).toEqual([
      ["ctx", 1, "a"],
      ["ctx", 2, "b"],
      ["del", null, "c"]
    ]);
  });
});

describe("renderHunks", () => {
  it("shows marker, line number and text, with a break between hunks", () => {
    const { text, truncated } = renderHunks(lines);
    expect(truncated).toBe(false);
    expect(text).toContain('+     2 | import b from "./b";');
    expect(text).toContain('-       | import b from "b";');
    expect(text.split("\n")).toContain("@@");
  });

  it("cuts at the size cap and says so", () => {
    const { text, truncated } = renderHunks(lines, 60);
    expect(truncated).toBe(true);
    expect(text).toContain("[cut here");
  });
});

describe("chunkLines", () => {
  const row = (i: number, kind: "add" | "ctx" = "ctx") => ({
    kind,
    line: i + 1,
    text: `line ${i + 1} ${"x".repeat(40)}`
  });
  const big = Array.from({ length: 1000 }, (_, i) =>
    row(i, i === 100 || i === 150 || i === 800 ? "add" : "ctx")
  );

  it("keeps a file that fits whole", () => {
    expect(chunkLines(lines)).toEqual({ chunks: [lines], cut: false });
  });

  it("cuts a big file into windows around its changes and merges neighbours", () => {
    const { chunks, cut } = chunkLines(big, 10_000, 30, 6);
    expect(cut).toBe(false);
    expect(chunks.map((c) => [c[0].line, c[c.length - 1].line])).toEqual([
      [71, 181],
      [771, 831]
    ]);
    expect(chunks[0].filter((l) => l.kind === "add")).toHaveLength(2);
  });

  it("stops at the chunk cap and reports the cut", () => {
    const { chunks, cut } = chunkLines(big, 10_000, 10, 1);
    expect(chunks).toHaveLength(1);
    expect(cut).toBe(true);
  });

  it("reports the cut when one window is still over the cap", () => {
    const { chunks, cut } = chunkLines(big, 2_000, 80, 6);
    expect(chunks).toHaveLength(2);
    expect(cut).toBe(true);
  });
});

describe("findQuote", () => {
  it("matches a whole line ignoring whitespace and strips a copied prefix", () => {
    expect(
      findQuote("  console.log( x );".replace("( x )", "(x)"), lines)?.line
    ).toBe(23);
    expect(findQuote("+    23 | console.log(x);", lines)?.line).toBe(23);
  });

  it("prefers an added line over context when both match", () => {
    const dup = parseHunks("@@ -1,2 +1,3 @@\n same();\n+same();\n other();");
    expect(findQuote("same();", dup)).toMatchObject({ kind: "add", line: 2 });
  });

  it("accepts a long substring but not a short one", () => {
    const long = parseHunks(
      "@@ -1 +1 @@\n+const token = process.env.SECRET_TOKEN ?? fallback; // read once"
    );
    expect(findQuote("process.env.SECRET_TOKEN ?? fallback", long)?.line).toBe(
      1
    );
    expect(
      findQuote("console.log(x);", [
        { kind: "add", line: 1, text: "f(x) { console.log(x); return x; }" }
      ])?.line
    ).toBe(1);
    expect(findQuote('from "./b"', lines)).toBeNull();
    expect(findQuote("x", lines)).toBeNull();
    expect(findQuote("nothing like this at all, really", lines)).toBeNull();
  });
});

describe("assertsPresence", () => {
  it("needs a quote only when something is claimed to be there", () => {
    expect(assertsPresence("FAIL", "must_not")).toBe(true);
    expect(assertsPresence("PASS", "must")).toBe(true);
    expect(assertsPresence("FAIL", "must")).toBe(false);
    expect(assertsPresence("PASS", "must_not")).toBe(false);
    expect(assertsPresence("UNSURE", "must")).toBe(false);
    expect(assertsPresence("NA", "must_not")).toBe(false);
  });
});

describe("annotateSteps", () => {
  const paths = new Set(["src/a.ts", "test/a.test.ts"]);
  const run = (steps: string[]) =>
    annotateSteps(steps, paths, "src/a.ts", lines);

  it("leaves paths from the PR and directories alone", () => {
    expect(
      run([
        "Open src/a.ts:23 and remove the log",
        "Add a case to test/a.test.ts",
        "Look under test/ for coverage"
      ])
    ).toEqual([
      "Open src/a.ts:23 and remove the log",
      "Add a case to test/a.test.ts",
      "Look under test/ for coverage"
    ]);
  });

  it("marks files the checker never saw and lines it was not shown", () => {
    expect(
      run(["Check src/other.ts and package.json", "See src/a.ts:99"])
    ).toEqual([
      "Check src/other.ts (not in this PR) and package.json (not in this PR)",
      "See src/a.ts:99 (line not shown)"
    ]);
  });

  it("caps the number of steps", () => {
    expect(run(["1", "2", "3", "4", "5", "6"])).toHaveLength(4);
  });

  it("does not swallow a sentence period and tolerates a missing extension", () => {
    expect(
      annotateSteps(
        ["Check for tests in test/.", "Open src/a and fix it."],
        new Set(["src/a.ts"]),
        "src/a.ts",
        []
      )
    ).toEqual([
      "Check for tests in test/ (not in this PR).",
      "Open src/a and fix it."
    ]);
  });
});

describe("normalise", () => {
  it("collapses whitespace", () => {
    expect(normalise("  a \t b\n")).toBe("a b");
  });
});
