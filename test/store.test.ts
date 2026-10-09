import { describe, expect, it } from "vitest";
import { renderReport } from "../src/checker/report";
import type { PreviousRun } from "../src/checker/types";
import { previousRunOf, readResult } from "../src/store";
import { file, result, verdict } from "./fixtures";

const lost: PreviousRun["findings"][number] = {
  id: "F1",
  key: "aaaa",
  kind: "blocking",
  rule: 1,
  path: "src/a.ts",
  line: 3,
  quote: "console.log(x)",
  summary: "s"
};

describe("readResult", () => {
  it("reopens a result stored before the diff listed what was not assessed", () => {
    const stored = result({
      files: [file("src/a.ts", [verdict(1, "PASS")])],
      previous: {
        checkId: "c0",
        headSha: "0123456789abcdef",
        rulesChanged: false,
        new: 0,
        open: 1,
        resolved: []
      } as never
    });
    // What an earlier build wrote: no attestations, no completeness, no
    // record of the lines a file reached.
    const json = JSON.stringify(stored, (key, value) =>
      ["attested", "complete", "attestation", "seen"].includes(key)
        ? undefined
        : value
    );
    expect(json).not.toContain("unassessed");
    const r = readResult(json);
    expect(r.previous?.unassessed).toEqual([]);
    expect(r.ruleStatuses[0]).toMatchObject({
      complete: true,
      attested: false
    });
    expect(r.files[0].seen).toEqual({});
    expect(renderReport(r, { json: true })).toContain(
      "Since the last check at `0123456`: 0 new, 1 still open, 0 resolved."
    );
  });

  it("leaves a current result as it is", () => {
    const current = result({ previous: null });
    expect(readResult(JSON.stringify(current))).toEqual(current);
  });
});

describe("previousRunOf", () => {
  it("carries a finding not assessed last run forward until a run looks at it", () => {
    const r = result({
      findings: [],
      previous: {
        checkId: "c0",
        headSha: "0",
        rulesChanged: false,
        new: 0,
        open: 0,
        resolved: [],
        unassessed: [lost]
      }
    });
    expect(previousRunOf(r)).toEqual({
      checkId: "check-1",
      headSha: "abcdef1234567890",
      rulesHash: "hash",
      findings: [lost]
    });
  });

  it("lists the current findings first and a key once", () => {
    const r = result({
      findings: [
        {
          id: "Q1",
          key: "aaaa",
          kind: "question",
          rule: 1,
          path: "src/a.ts",
          line: null,
          quote: null,
          origin: null,
          change: "open",
          summary: "asked",
          why: "",
          steps: [],
          resolution: null,
          question: "Still?",
          note: null,
          attestation: null
        }
      ],
      previous: {
        checkId: "c0",
        headSha: "0",
        rulesChanged: false,
        new: 0,
        open: 1,
        resolved: [],
        unassessed: [lost, { ...lost, id: "F2", key: "bbbb" }]
      }
    });
    expect(previousRunOf(r).findings.map((f) => [f.key, f.summary])).toEqual([
      ["aaaa", "asked"],
      ["bbbb", "s"]
    ]);
  });
});
