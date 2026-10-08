import { describe, expect, it } from "vitest";
import { limits } from "../src/checker/limits";
import { priority, selectFiles } from "../src/checker/select";
import type { PrFile } from "../src/checker/types";

const f = (
  path: string,
  patch: string | null = "@@ -1 +1 @@\n-a\n+b"
): PrFile => ({
  path,
  previousPath: null,
  status: "modified",
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
  it("skips noise without hurting coverage, and files with no diff with", () => {
    const { checked, skipped, coverageComplete } = selectFiles([
      f("package-lock.json"),
      f("dist/app.min.js"),
      f("vendor/x.js"),
      f("logo.png"),
      f("src/a.ts")
    ]);
    expect(checked.map((x) => x.path)).toEqual(["src/a.ts"]);
    expect(skipped).toHaveLength(4);
    expect(coverageComplete).toBe(true);

    const big = selectFiles([f("src/huge.ts", null)]);
    expect(big.skipped[0].reason).toMatch(/no diff available/);
    expect(big.coverageComplete).toBe(false);
  });

  it("orders source, tests, docs and applies the cap to the tail", () => {
    const files = [
      f("README.md"),
      f("test/a.test.ts"),
      ...Array.from({ length: limits.filesPerCheck }, (_, i) =>
        f(`src/f${i}.ts`)
      )
    ];
    const { checked, skipped, coverageComplete } = selectFiles(files);
    expect(checked).toHaveLength(limits.filesPerCheck);
    expect(checked[0].path).toBe("src/f0.ts");
    expect(checked.some((x) => x.path === "README.md")).toBe(false);
    expect(skipped.map((s) => s.path)).toEqual(["test/a.test.ts", "README.md"]);
    expect(skipped[0].reason).toMatch(/over the cap/);
    expect(coverageComplete).toBe(false);
  });
});
