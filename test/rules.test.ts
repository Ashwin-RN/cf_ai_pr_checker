import { describe, expect, it } from "vitest";
import { limits } from "../src/checker/limits";
import type { JsonCaller } from "../src/checker/model";
import {
  defaultRules,
  interpretRules,
  normaliseRules,
  parseRuleText,
  parseRulesFile,
  ruleApplies,
  rulesHash,
  scopeFrom
} from "../src/checker/rules";

describe("parseRuleText", () => {
  it("strips the prefix, bullets and numbering, and drops blanks and duplicates", () => {
    expect(
      parseRuleText(
        "rules:\n- No console.log\n\n1. Every route has a test\n* No console.log\n2) No TODO"
      )
    ).toEqual(["No console.log", "Every route has a test", "No TODO"]);
  });
});

describe("defaultRules", () => {
  it("guesses polarity from negations", () => {
    const rules = defaultRules(["No console.log", "Every route has a test"]);
    expect(rules.map((r) => r.polarity)).toEqual(["must_not", "must"]);
    expect(rules[1]).toMatchObject({ id: 2, scope: "file", appliesTo: null });
  });
});

describe("scopeFrom", () => {
  it("keeps a directory prefix only when the rule names it", () => {
    expect(scopeFrom(["src/**/*.ts"], "No console.log under src/")).toEqual([
      "src/"
    ]);
    expect(
      scopeFrom(["src//*.ts", "src//*.js"], "No logs in src files")
    ).toEqual(["src/"]);
    expect(
      scopeFrom(
        [".github/workflows/*.yml"],
        "Every GitHub Actions workflow pins"
      )
    ).toEqual([".github/workflows/"]);
    expect(scopeFrom(["*.ts"], "Files end with a newline")).toBeNull();
    expect(scopeFrom([], "anything")).toBeNull();
  });

  it("never narrows below the directory and merges duplicates", () => {
    expect(
      scopeFrom(
        ["src/routes/*.ts", "./src/routes/**"],
        "Routes in src/routes have tests"
      )
    ).toEqual(["src/routes/"]);
    expect(scopeFrom(["srcx/**"], "Only src matters")).toBeNull();
  });

  it("needs every directory on the path named, not only the last", () => {
    expect(
      scopeFrom(["invented/src/**"], "No console.log under src/")
    ).toBeNull();
    expect(scopeFrom(["src/routes/*.ts"], "Routes in src/ have tests")).toEqual(
      ["src/routes/"]
    );
    expect(scopeFrom(["src/routes/*.ts"], "Every route has a test")).toBeNull();
  });
});

describe("ruleApplies", () => {
  const r = (prefixes: string[] | null) => ({
    ...defaultRules(["x"])[0],
    appliesTo: prefixes
  });

  it("matches by prefix and applies everywhere without one", () => {
    expect(ruleApplies(r(null), "a/b.ts")).toBe(true);
    expect(ruleApplies(r([]), "a/b.ts")).toBe(true);
    expect(ruleApplies(r(["src/"]), "src/a/b.ts")).toBe(true);
    expect(ruleApplies(r(["src/"]), "test/b.ts")).toBe(false);
    expect(ruleApplies(r(["src/", "test/"]), "test/b.ts")).toBe(true);
    expect(ruleApplies(r(["src/"]), "srcx/b.ts")).toBe(false);
  });
});

describe("normaliseRules", () => {
  const texts = ["No console.log in src", "Every route has a test"];

  it("applies the model's interpretation", async () => {
    const call: JsonCaller = async () => ({
      ok: true,
      raw: "",
      value: {
        rules: [
          { polarity: "must_not", scope: "file", applies_to: ["src/**"] },
          { polarity: "must", scope: "cross_file", applies_to: [] }
        ]
      } as never
    });
    const rules = await normaliseRules(texts, call);
    expect(rules[0]).toMatchObject({
      polarity: "must_not",
      appliesTo: ["src/"]
    });
    expect(rules[1]).toMatchObject({ scope: "cross_file", appliesTo: null });
  });

  it("reports a failed interpretation as null, and the defaults otherwise", async () => {
    const failing: JsonCaller = async () => ({
      ok: false,
      error: "x",
      raw: null
    });
    expect(await interpretRules(texts, failing)).toBeNull();
    expect(await interpretRules([], failing)).toEqual([]);
  });

  it("falls back to defaults when the call fails or the count is off", async () => {
    const failing: JsonCaller = async () => ({
      ok: false,
      error: "x",
      raw: null
    });
    expect(await normaliseRules(texts, failing)).toEqual(defaultRules(texts));
    const short: JsonCaller = async () =>
      ({
        ok: true,
        raw: "",
        value: { rules: [{ polarity: "must", scope: "file", applies_to: [] }] }
      }) as never;
    expect(await normaliseRules(texts, short)).toEqual(defaultRules(texts));
  });
});

describe("rulesHash", () => {
  it("depends only on the rule text", async () => {
    const a = await rulesHash(defaultRules(["x", "y"]));
    const b = await rulesHash([
      {
        id: 9,
        text: "x",
        polarity: "must",
        scope: "cross_file",
        appliesTo: ["a/"]
      },
      { id: 8, text: "y", polarity: "must_not", scope: "file", appliesTo: null }
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await rulesHash(defaultRules(["x"]))).not.toBe(a);
  });
});

describe("scopeFrom directory names", () => {
  it("accepts a prefix when the rule names the directory, singular or plural", () => {
    expect(scopeFrom(["tests/**"], "Every test file imports vitest")).toEqual([
      "tests/"
    ]);
    expect(scopeFrom(["docs/*.md"], "Docs end with a newline")).toEqual([
      "docs/"
    ]);
    expect(
      scopeFrom(
        [".github/workflows/*.yml"],
        "Every GitHub pull request has a description"
      )
    ).toBeNull();
  });
});

describe("normaliseRules scope", () => {
  it("keeps prohibitions per file even when the model says cross-file", async () => {
    const call: JsonCaller = async () => ({
      ok: true,
      raw: "",
      value: {
        rules: [{ polarity: "must_not", scope: "cross_file", applies_to: [] }]
      } as never
    });
    expect((await normaliseRules(["No secrets"], call))[0].scope).toBe("file");
  });
});

describe("parseRulesFile", () => {
  it("takes only list items, outside code blocks, and caps them", () => {
    const md = [
      "# Rules",
      "",
      "Prose that is not a rule.",
      "",
      "- No console.log in src/",
      "* Every route has a test",
      "1. No `TODO` without an issue link",
      "",
      "```",
      "- not a rule, it is in a code block",
      "```",
      "- No console.log in src/"
    ].join("\n");
    expect(parseRulesFile(md)).toEqual([
      "No console.log in src/",
      "Every route has a test",
      "No `TODO` without an issue link"
    ]);
    const many = Array.from({ length: 40 }, (_, i) => `- rule ${i}`).join("\n");
    expect(parseRulesFile(many)).toHaveLength(limits.rulesMax);
    expect(parseRulesFile(`- ${"x".repeat(500)}`)[0]).toHaveLength(
      limits.ruleChars
    );
  });
});
