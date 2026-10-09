// Scores one evaluation case against the checker's answer. A false PASS is
// a rule expected to FAIL or be UNSURE that came back PASS or NA. A broken
// row is one the harness could not score: the checker answered with an
// error, a rule the case expects is missing from the answer, or the pull
// request's head is not the commit the case was written for.

export type Expected = "PASS" | "FAIL" | "UNSURE" | "NA";

export type Case = {
  name: string;
  prUrl: string;
  headSha: string;
  status: "pass" | "fail" | "unsure";
  rules: Record<string, Expected>;
  blocking?: Record<string, boolean>;
  strict?: boolean;
};

export type RuleOut = { id: number; status: Expected; blocking: boolean };
export type Out = {
  status: string;
  pr: { head_sha: string };
  rules: RuleOut[];
  model_calls: number;
  findings: Array<{ id: string; path: string; line: number | null }>;
  error?: string;
};

export type Row = {
  name: string;
  status: string;
  expected: string;
  wrong: string[];
  broken: string[];
  falsePass: number;
  falseFail: number;
  missed: number;
  unsure: number;
  calls: number;
  seconds: number;
};

export function same(got: Expected, want: Expected): boolean {
  if (got === want) return true;
  // PASS and NA both mean "nothing wrong", so one for the other is not a miss.
  return (got === "PASS" || got === "NA") && (want === "PASS" || want === "NA");
}

export function score(
  c: Case,
  http: { ok: boolean; status: number },
  out: Out | null,
  seconds: number
): Row {
  const row: Row = {
    name: c.name,
    status: "",
    expected: c.status,
    wrong: [],
    broken: [],
    falsePass: 0,
    falseFail: 0,
    missed: 0,
    unsure: 0,
    calls: 0,
    seconds
  };
  if (!http.ok || !out) {
    row.status = `error ${http.status}`;
    row.broken.push(
      `the checker answered ${http.status}${out?.error ? `: ${out.error}` : ""}`
    );
    return row;
  }
  row.status = out.status;
  row.unsure = out.rules.filter((r) => r.status === "UNSURE").length;
  row.calls = out.model_calls;
  if (out.pr.head_sha !== c.headSha) {
    row.broken.push(
      `head is ${out.pr.head_sha.slice(0, 7)}, the case expects ${c.headSha.slice(0, 7)}`
    );
  }
  for (const [id, want] of Object.entries(c.rules)) {
    const got = out.rules.find((r) => r.id === Number(id));
    if (!got) {
      row.broken.push(`rule ${id} is missing from the answer`);
      continue;
    }
    const blockingWant = c.blocking?.[id];
    const blockingOk =
      blockingWant === undefined || got.blocking === blockingWant;
    if (same(got.status, want)) {
      if (blockingOk) continue;
      // The verdict is right and the policy is not. A rule that should
      // block and does not lets the pull request through.
      row.wrong.push(
        `${id}: ${blockingWant ? "does not block but should" : "blocks but should not"}`
      );
      if (blockingWant) row.falsePass++;
      else row.falseFail++;
      continue;
    }
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
  // The status is what CI reads, so it is scored in its own right: a check
  // that should fail or stay unsure but passes is a false PASS whatever the
  // rules said. One cause counts once.
  if (out.status === "pass" && c.status !== "pass") {
    row.wrong.push(`status: pass not ${c.status}`);
    if (row.falsePass === 0) row.falsePass++;
  } else if (out.status === "fail" && c.status === "pass") {
    row.wrong.push("status: fail not pass");
    if (row.falseFail === 0) row.falseFail++;
  }
  return row;
}

export function summarise(rows: Row[]): string {
  const sum = (k: "falsePass" | "falseFail" | "missed" | "unsure" | "calls") =>
    rows.reduce((n, r) => n + r[k], 0);
  const broken = rows.filter((r) => r.broken.length).length;
  const statusWrong = rows.filter((r) => r.status !== r.expected).length;
  const seconds = rows.reduce((n, r) => n + r.seconds, 0);
  return `${rows.length} cases, ${statusWrong} with the wrong status, ${broken} broken. False PASS ${sum("falsePass")}, false FAIL ${sum("falseFail")}, missed ${sum("missed")}, UNSURE rules ${sum("unsure")}, model calls ${sum("calls")}, ${seconds.toFixed(1)}s.`;
}

// The run fails on a false PASS, and on any row the harness could not score:
// a green run must mean every case was checked and none passed wrongly.
export function failed(rows: Row[]): boolean {
  return rows.some((r) => r.falsePass > 0 || r.broken.length > 0);
}
