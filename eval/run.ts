// Runs every case under eval/cases against a running checker and prints a
// table. A false PASS is a rule expected to FAIL or be UNSURE that came back
// PASS or NA; the run exits non-zero if there is one.
//
//   CHECKER_URL=http://localhost:5173 API_TOKEN=dev-token npm run eval
//   npm run eval -- --only secret
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Expected = "PASS" | "FAIL" | "UNSURE" | "NA";

type Case = {
  name: string;
  prUrl: string;
  headSha: string;
  status: "pass" | "fail" | "unsure";
  rules: Record<string, Expected>;
  blocking?: Record<string, boolean>;
  strict?: boolean;
};

type RuleOut = { id: number; status: Expected; blocking: boolean };
type Out = {
  status: string;
  pr: { head_sha: string };
  rules: RuleOut[];
  model_calls: number;
  findings: Array<{ id: string; path: string; line: number | null }>;
  error?: string;
};

const url = process.env.CHECKER_URL ?? "http://localhost:5173";
const token = process.env.API_TOKEN ?? "dev-token";
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];

const dir = join(import.meta.dirname, "cases");
const cases: Case[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Case)
  .filter((c) => !only || c.name.includes(only));

type Row = {
  name: string;
  status: string;
  expected: string;
  wrong: string[];
  falsePass: number;
  falseFail: number;
  missed: number;
  unsure: number;
  calls: number;
  seconds: number;
};

function same(got: Expected, want: Expected): boolean {
  if (got === want) return true;
  // PASS and NA both mean "nothing wrong", so one for the other is not a miss.
  return (got === "PASS" || got === "NA") && (want === "PASS" || want === "NA");
}

async function runCase(c: Case): Promise<Row> {
  const started = Date.now();
  const res = await fetch(`${url}/api/check`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      prUrl: c.prUrl,
      workspace: "eval",
      strict: c.strict ?? false
    })
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const out = (await res.json()) as Out;
  if (!res.ok) {
    return {
      name: c.name,
      status: `error ${res.status}: ${out.error ?? ""}`,
      expected: c.status,
      wrong: [],
      falsePass: 0,
      falseFail: 0,
      missed: 0,
      unsure: 0,
      calls: 0,
      seconds
    };
  }
  if (out.pr.head_sha !== c.headSha) {
    console.error(
      `${c.name}: head is ${out.pr.head_sha.slice(0, 7)}, the case expects ${c.headSha.slice(0, 7)}`
    );
  }
  const row: Row = {
    name: c.name,
    status: out.status,
    expected: c.status,
    wrong: [],
    falsePass: 0,
    falseFail: 0,
    missed: 0,
    unsure: out.rules.filter((r) => r.status === "UNSURE").length,
    calls: out.model_calls,
    seconds
  };
  for (const [id, want] of Object.entries(c.rules)) {
    const got = out.rules.find((r) => r.id === Number(id));
    if (!got) continue;
    const blockingWant = c.blocking?.[id];
    const blockingOk =
      blockingWant === undefined || got.blocking === blockingWant;
    if (same(got.status, want) && blockingOk) continue;
    row.wrong.push(
      `${id}: ${got.status}${got.blocking ? "" : got.status === "FAIL" ? " (pre-existing)" : ""} not ${want}`
    );
    if (
      (want === "FAIL" || want === "UNSURE") &&
      (got.status === "PASS" || got.status === "NA")
    ) {
      row.falsePass++;
    } else if ((want === "PASS" || want === "NA") && got.status === "FAIL") {
      row.falseFail++;
    } else if (want === "FAIL" && got.status === "UNSURE") {
      row.missed++;
    }
  }
  return row;
}

const rows: Row[] = [];
for (const c of cases) {
  process.stderr.write(`${c.name}... `);
  const row = await runCase(c);
  process.stderr.write(`${row.status} in ${row.seconds}s\n`);
  rows.push(row);
}

const header = [
  "| Case | Status | Expected | Rules off | False PASS | False FAIL | Missed | UNSURE | Calls | Time |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
];
const body = rows.map(
  (r) =>
    `| ${r.name} | ${r.status} | ${r.expected} | ${r.wrong.join("; ") || "none"} | ${r.falsePass} | ${r.falseFail} | ${r.missed} | ${r.unsure} | ${r.calls} | ${r.seconds}s |`
);
const sum = (k: keyof Row) => rows.reduce((n, r) => n + Number(r[k]), 0);
const statusWrong = rows.filter((r) => r.status !== r.expected).length;
console.log([...header, ...body].join("\n"));
console.log(
  `\n${rows.length} cases, ${statusWrong} with the wrong status. False PASS ${sum("falsePass")}, false FAIL ${sum("falseFail")}, missed ${sum("missed")}, UNSURE rules ${sum("unsure")}, model calls ${sum("calls")}, ${sum("seconds").toFixed(1)}s.`
);
if (sum("falsePass") > 0) process.exit(1);
