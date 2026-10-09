// Runs every case under eval/cases against a running checker and prints a
// table. The run exits non-zero on a false PASS, a rule expected to FAIL or
// be UNSURE that came back PASS or NA, and on any case it could not score.
//
//   CHECKER_URL=http://localhost:5173 API_TOKEN=dev-token npm run eval
//   npm run eval -- --only secret --out eval/out
//
// EVAL_WORKSPACE names the workspace (default "eval"); --out writes each
// response as JSON into a directory.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Case,
  type Out,
  type Row,
  failed,
  score,
  summarise
} from "./score.ts";

const url = process.env.CHECKER_URL ?? "http://localhost:5173";
const token = process.env.API_TOKEN ?? "dev-token";
const workspace = process.env.EVAL_WORKSPACE ?? "eval";
const arg = (name: string): string | null => {
  const at = process.argv.indexOf(name);
  return at === -1 ? null : (process.argv[at + 1] ?? null);
};
const only = arg("--only");
const outDir = arg("--out");
if (outDir) mkdirSync(outDir, { recursive: true });

const dir = join(import.meta.dirname, "cases");
const cases: Case[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Case)
  .filter((c) => !only || c.name.includes(only));
if (cases.length === 0) {
  console.error(only ? `No case matches --only ${only}.` : "No cases found.");
  process.exit(1);
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
      workspace,
      strict: c.strict ?? false
    })
  });
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const out = (await res.json().catch(() => null)) as Out | null;
  if (outDir && out) {
    writeFileSync(join(outDir, `${c.name}.json`), JSON.stringify(out, null, 2));
  }
  return score(c, { ok: res.ok, status: res.status }, out, seconds);
}

const rows: Row[] = [];
for (const c of cases) {
  process.stderr.write(`${c.name}... `);
  const row = await runCase(c);
  process.stderr.write(`${row.status} in ${row.seconds}s\n`);
  rows.push(row);
}

const header = [
  "| Case | Status | Expected | Rules off | Broken | False PASS | False FAIL | Missed | UNSURE | Calls | Time |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
];
const body = rows.map(
  (r) =>
    `| ${r.name} | ${r.status} | ${r.expected} | ${r.wrong.join("; ") || "none"} | ${r.broken.join("; ") || "none"} | ${r.falsePass} | ${r.falseFail} | ${r.missed} | ${r.unsure} | ${r.calls} | ${r.seconds}s |`
);
console.log([...header, ...body].join("\n"));
console.log(`\n${summarise(rows)}`);
if (failed(rows)) process.exit(1);
