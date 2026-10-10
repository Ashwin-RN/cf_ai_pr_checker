import { describe, expect, it } from "vitest";
import { assemble, checkFile } from "../src/checker";
import {
  BY_PATTERN,
  mechanicalFor,
  mechanicalKind
} from "../src/checker/mechanical";
import type { ChatMessage, JsonCaller } from "../src/checker/model";
import { confirmSchema, type FileOutput } from "../src/checker/prompts";
import { machineReport, renderReport } from "../src/checker/report";
import { interpretRules } from "../src/checker/rules";
import type { Pr, PrFile, Rule } from "../src/checker/types";
import { fileLines, parseHunks } from "../src/checker/verify";
import { rule } from "./fixtures";

const PINNED_TEXT =
  "Every workflow under .github/workflows/ pins each action to a major version tag such as `@v4`";
const pinned: Rule = rule(2, PINNED_TEXT, "must");
const PATH = ".github/workflows/ci.yml";

const workflow = (patch: string): PrFile => ({
  path: PATH,
  previousPath: null,
  status: "modified",
  sha: "s",
  additions: 1,
  deletions: 1,
  patch
});

const content = `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@main
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm test
`;
const patch =
  "@@ -4,7 +4,7 @@ jobs:\n   test:\n     runs-on: ubuntu-24.04\n     steps:\n-      - uses: actions/checkout@v4\n+      - uses: actions/checkout@main\n       - uses: actions/setup-node@v4\n         with:\n           node-version: 22";

const check = mechanicalFor(pinned)!.check;
const lines = (text: string) => fileLines(text, "");

describe("mechanicalKind", () => {
  it("recognises the pinned-action rule however a team words it", () => {
    for (const text of [
      PINNED_TEXT,
      "Every workflow under .github/workflows/ pins each action to a major version tag",
      "Pin every GitHub Action to a version",
      "Actions in workflows are pinned"
    ]) {
      expect(mechanicalKind(text)).toBe("pinned-actions");
    }
  });

  it("leaves every other rule to the model", () => {
    for (const text of [
      "No `console.log` or `console.debug` calls in files under src/",
      "Pin dependencies in package.json to exact versions",
      "Every new exported function under src/ has a test under test/",
      "No action without a reason in the description"
    ]) {
      expect(mechanicalKind(text)).toBeNull();
    }
    expect(mechanicalFor(rule(1, "No console.log"))).toBeNull();
  });
});

describe("the pinned-actions check", () => {
  it("fails on an action named by a branch, quoting the line the pull request adds", () => {
    const v = check(pinned, PATH, fileLines(content, patch));
    expect(v).toMatchObject({
      rule: 2,
      verdict: "FAIL",
      quote: "- uses: actions/checkout@main",
      line: 7,
      verified: true,
      origin: "introduced",
      mechanical: true,
      note: BY_PATTERN,
      reason: "1 action is not pinned to a version tag: actions/checkout@main",
      resolution: `every \`uses:\` line in ${PATH} names a version tag or a commit SHA`
    });
    expect(v.steps).toHaveLength(3);
    expect(v.why).toContain("branch");
  });

  it("calls an unchanged loose line pre-existing, and names the first of several", () => {
    const v = check(pinned, PATH, lines(content));
    expect(v).toMatchObject({ verdict: "FAIL", origin: "pre-existing" });
    const two = check(
      pinned,
      PATH,
      fileLines(
        content.replace("setup-node@v4", "setup-node@master"),
        "@@ -8,1 +8,1 @@\n-      - uses: actions/setup-node@v4\n+      - uses: actions/setup-node@master"
      )
    );
    expect(two).toMatchObject({
      verdict: "FAIL",
      quote: "- uses: actions/setup-node@master",
      line: 8,
      origin: "introduced",
      reason:
        "2 actions are not pinned to a version tag, first actions/setup-node@master"
    });
  });

  it("passes when every action names a tag or a commit, quoting one", () => {
    const text = `steps:
  - uses: actions/checkout@v4
  - uses: "actions/setup-node@v4.1.2"
  - uses: 'owner/action@1.2'
  - uses: owner/other@0123456789abcdef0123456789abcdef01234567
  - uses: ./.github/actions/local
  - uses: docker://alpine:3.14
  - run: echo "uses: nothing@main"
`;
    const v = check(pinned, PATH, lines(text));
    expect(v).toMatchObject({
      verdict: "PASS",
      quote: "- uses: actions/checkout@v4",
      line: 2,
      verified: true,
      mechanical: true,
      reason: "all 4 actions are pinned to a version tag or a commit SHA"
    });
  });

  it("is not triggered by a workflow without actions, or by a file that is not a workflow", () => {
    const none = check(
      pinned,
      PATH,
      lines("on: push\njobs:\n  a:\n    steps:\n      - run: echo hi\n")
    );
    expect(none).toMatchObject({
      verdict: "NA",
      reason: "no action is used in this file",
      mechanical: true
    });
    const local = check(pinned, PATH, lines("steps:\n  - uses: ./x\n"));
    expect(local.verdict).toBe("NA");
    expect(check(pinned, "src/a.ts", lines("uses: a/b@main"))).toMatchObject({
      verdict: "NA",
      reason: "not a workflow file"
    });
    expect(check(pinned, ".github/workflows/x.yaml", lines("")).verdict).toBe(
      "NA"
    );
  });

  it("fails on @latest, @master and a missing version, and ignores removed lines", () => {
    for (const ref of ["a/b@latest", "a/b@master", "a/b", "a/b@release/v1"]) {
      expect(
        check(pinned, PATH, lines(`steps:\n  - uses: ${ref}\n`)).verdict
      ).toBe("FAIL");
    }
    const diffOnly = parseHunks(
      "@@ -1,1 +1,1 @@\n-      - uses: actions/checkout@main\n+      - uses: actions/checkout@v4"
    );
    expect(check(pinned, PATH, diffOnly)).toMatchObject({
      verdict: "PASS",
      quote: "- uses: actions/checkout@v4"
    });
  });
});

const output = (verdicts: FileOutput["verdicts"]): FileOutput => ({
  purpose: "runs the tests",
  verdicts,
  facts: ["runs npm test"],
  warnings: []
});

const v = (
  ruleAt: number,
  verdict: FileOutput["verdicts"][number]["verdict"],
  quote = ""
) => ({
  rule: ruleAt,
  verdict,
  quote,
  reason: "r",
  why: "w",
  steps: ["s"],
  resolution: "res",
  question: "q"
});

function caller(out: FileOutput | null) {
  const prompts: ChatMessage[][] = [];
  let confirms = 0;
  const call: JsonCaller = async (messages, schema) => {
    if ((schema as unknown) === confirmSchema) {
      confirms++;
      return {
        ok: true,
        value: { breaks_rule: true, reason: "c" } as never,
        raw: ""
      };
    }
    prompts.push(messages);
    if (out === null) {
      return { ok: false, error: "model error: none today", raw: null };
    }
    return { ok: true, value: out as never, raw: JSON.stringify(out) };
  };
  return { call, prompts, confirms: () => confirms };
}

const rules = [
  rule(1, "No console.log"),
  pinned,
  rule(3, "No TODO without a link to an issue")
];
const paths = new Set([PATH]);

describe("checkFile with a rule checked by pattern", () => {
  it("decides the rule in code, asks the model about the rest numbered without it, and maps the answers back", async () => {
    // The model is given rules 1 and 3 as "1." and "2."; its "2" is rule 3.
    const { call, prompts, confirms } = caller(
      output([v(1, "PASS"), v(2, "UNSURE")])
    );
    const result = await checkFile(
      rules,
      workflow(patch),
      paths,
      call,
      content
    );
    expect(prompts).toHaveLength(1);
    const user = prompts[0][1].content;
    expect(user).toContain("1. [must not] No console.log");
    expect(user).toContain("2. [must not] No TODO without a link to an issue");
    expect(user).not.toContain("pins each action");
    expect(result.state).toBe("checked");
    expect(result.coverage).toBe("full");
    expect(
      result.verdicts.map((x) => [x.rule, x.verdict, x.mechanical])
    ).toEqual([
      [1, "PASS", false],
      [2, "FAIL", true],
      [3, "UNSURE", false]
    ]);
    expect(result.verdicts[1]).toMatchObject({
      quote: "- uses: actions/checkout@main",
      line: 7,
      origin: "introduced"
    });
    expect(result.verdicts[2].question).toBe("q");
    // A verdict by pattern gets no second look.
    expect(confirms()).toBe(0);
  });

  it("makes no model call when every rule that applies is checked by pattern", async () => {
    const { call, prompts } = caller(output([]));
    const result = await checkFile(
      [pinned],
      workflow(patch),
      paths,
      call,
      content,
      null,
      [{ key: "k1", quote: "- uses: actions/checkout@main" }]
    );
    expect(prompts).toHaveLength(0);
    expect(result).toMatchObject({
      state: "checked",
      coverage: "full",
      chunks: 0,
      reason: "every rule that applies is checked by pattern",
      seen: { k1: true }
    });
    expect(result.verdicts).toEqual([
      expect.objectContaining({ rule: 2, verdict: "FAIL", mechanical: true })
    ]);
    const diffOnly = await checkFile(
      [pinned],
      workflow(patch),
      paths,
      call,
      null
    );
    expect(diffOnly).toMatchObject({ coverage: "partial", state: "checked" });
    expect(diffOnly.verdicts[0].verdict).toBe("FAIL");
  });

  it("holds the pattern verdict when the model cannot answer, and leaves the rest open", async () => {
    const { call } = caller(null);
    const result = await checkFile(
      rules,
      workflow(patch),
      paths,
      call,
      content
    );
    expect(result).toMatchObject({
      state: "checked",
      coverage: "partial",
      reason: "the model could not check it: model error: none today"
    });
    expect(result.verdicts.map((x) => [x.rule, x.verdict])).toEqual([
      [1, "UNSURE"],
      [2, "FAIL"],
      [3, "UNSURE"]
    ]);
    expect(result.verdicts[0]).toMatchObject({
      reason: "the model could not check this rule (model error: none today)",
      question: `Does ${PATH} meet rule 1? The model could not check it.`
    });
    // Without a pattern rule the file is not checked at all, as before.
    const none = await checkFile(
      [rules[0], rules[2]],
      workflow(patch),
      paths,
      call,
      content
    );
    expect(none.state).toBe("failed");
  });
});

describe("a rule checked by pattern through the rules and the report", () => {
  it("is always settled by one file, whatever the model says", async () => {
    const call: JsonCaller = async () => ({
      ok: true,
      raw: "",
      value: {
        rules: [
          {
            polarity: "must",
            scope: "cross_file",
            applies_to: [".github/workflows/*.yml"]
          }
        ]
      } as never
    });
    const out = await interpretRules([PINNED_TEXT], call);
    expect(out?.[0]).toMatchObject({
      scope: "file",
      polarity: "must",
      appliesTo: [".github/workflows/"]
    });
  });

  it("tags the item and the rule as checked by pattern", async () => {
    const { call } = caller(output([v(1, "PASS"), v(2, "PASS")]));
    const file = await checkFile(rules, workflow(patch), paths, call, content);
    const pr: Pr = {
      owner: "o",
      repo: "r",
      number: 1,
      url: "https://github.com/o/r/pull/1",
      title: "T",
      body: "",
      headSha: "abcdef1234567890",
      baseRef: "main",
      files: [workflow(patch)],
      fileListTruncated: false
    };
    const r = assemble({
      input: { id: "c1", workspace: "ws", prUrl: pr.url, rules: null },
      pr,
      ruleSet: { rules, hash: "h", source: "t" },
      results: [file],
      notChecked: [],
      crossFile: [],
      intent: {
        compared: false,
        summary: "none",
        unmentioned: [],
        unsupported: []
      },
      modelCalls: 1,
      startedAt: 0,
      finishedAt: 1
    });
    expect(r.status).toBe("fail");
    expect(r.findings[0]).toMatchObject({
      kind: "blocking",
      rule: 2,
      by: "pattern",
      note: null,
      quote: "- uses: actions/checkout@main"
    });
    const md = renderReport(r, { json: false });
    expect(md).toContain(
      `### F1 · rule 2 · ${PATH}:7 · key ${r.findings[0].key} · checked by pattern\n`
    );
    expect(md).not.toContain("**Caveat:**");
    const m = machineReport(r) as { rules: Array<{ checked_by: string }> };
    expect(m.rules.map((x) => x.checked_by)).toEqual([
      "model",
      "pattern",
      "model"
    ]);
  });
});
