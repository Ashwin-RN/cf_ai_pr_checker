import { describe, expect, it } from "vitest";
import { limits } from "../src/checker/limits";
import { priority, selectFiles } from "../src/checker/select";
import type { PrFile } from "../src/checker/types";

const f = (
  path: string,
  patch: string | null = "@@ -1 +1 @@\n-a\n+b",
  status = "modified"
): PrFile => ({
  path,
  previousPath: null,
  status,
  sha: "s",
  additions: 1,
  deletions: 1,
  patch
});

describe("priority", () => {
  it("ranks source before tests before config and docs", () => {
    expect(priority("src/a.ts")).toBe(0);
    expect(priority("test/a.test.ts")).toBe(1);
    expect(priority("src/__tests__/a.ts")).toBe(1);
    expect(priority("README.md")).toBe(2);
    expect(priority(".github/workflows/ci.yml")).toBe(2);
    expect(priority(".gitignore")).toBe(2);
  });
});

describe("selectFiles", () => {
  it("skips noise and deleted files without a coverage gap, and files with no diff with one", () => {
    const { checked, skipped } = selectFiles([
      f("package-lock.json"),
      f("dist/app.min.js"),
      f("vendor/x.js"),
      f("logo.png"),
      f("src/old.ts", "@@ -1 +0,0 @@\n-a", "removed"),
      f("src/a.ts")
    ]);
    expect(checked.map((x) => x.path)).toEqual(["src/a.ts"]);
    expect(skipped).toHaveLength(5);
    expect(skipped.every((s) => !s.coverage)).toBe(true);
    expect(skipped[4].reason).toBe("deleted by this pull request");

    const big = selectFiles([f("src/huge.ts", null)]);
    expect(big.skipped[0]).toMatchObject({
      reason: "no diff available (binary or too large)",
      coverage: true
    });
  });

  it("orders source, tests, docs and applies the cap to the tail", () => {
    const files = [
      f("README.md"),
      f("test/a.test.ts"),
      ...Array.from({ length: limits.filesPerCheck }, (_, i) =>
        f(`src/f${i}.ts`)
      )
    ];
    const { checked, skipped } = selectFiles(files);
    expect(checked).toHaveLength(limits.filesPerCheck);
    expect(checked[0].path).toBe("src/f0.ts");
    expect(checked.some((x) => x.path === "README.md")).toBe(false);
    expect(skipped.map((s) => s.path)).toEqual(["test/a.test.ts", "README.md"]);
    expect(skipped[0]).toMatchObject({ coverage: true });
    expect(skipped[0].reason).toMatch(/over the cap/);
  });
});
