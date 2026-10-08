import { describe, expect, it } from "vitest";
import {
  annotateSteps,
  assertsPresence,
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
    expect(text).toContain("[diff cut here");
  });
});

describe("findQuote", () => {
  it("matches ignoring whitespace and strips a copied prefix", () => {
    expect(
      findQuote("  console.log( x );".replace("( x )", "(x)"), lines)?.line
    ).toBe(23);
    expect(findQuote("+    23 | console.log(x);", lines)?.line).toBe(23);
  });

  it("prefers an added line over context when both match", () => {
    const dup = parseHunks("@@ -1,2 +1,3 @@\n same();\n+same();\n other();");
    expect(findQuote("same();", dup)).toMatchObject({ kind: "add", line: 2 });
  });

  it("accepts a substring and rejects short or missing quotes", () => {
    expect(findQuote('from "./b"', lines)?.line).toBe(2);
    expect(findQuote("x", lines)).toBeNull();
    expect(findQuote("nothing like this", lines)).toBeNull();
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

  it("marks files the checker never saw and lines outside the diff", () => {
    expect(
      run(["Check src/other.ts and package.json", "See src/a.ts:99"])
    ).toEqual([
      "Check src/other.ts (not in this PR) and package.json (not in this PR)",
      "See src/a.ts:99 (line not in the diff)"
    ]);
  });

  it("caps the number of steps", () => {
    expect(run(["1", "2", "3", "4", "5", "6"])).toHaveLength(4);
  });
});

describe("normalise", () => {
  it("collapses whitespace", () => {
    expect(normalise("  a \t b\n")).toBe("a b");
  });
});

describe("annotateSteps edge cases", () => {
  it("does not swallow a sentence period and tolerates a missing extension", () => {
    const paths = new Set(["src/a.ts"]);
    expect(
      annotateSteps(
        ["Check for tests in test/.", "Open src/a and fix it."],
        paths,
        "src/a.ts",
        []
      )
    ).toEqual([
      "Check for tests in test/ (not in this PR).",
      "Open src/a and fix it."
    ]);
  });
});
