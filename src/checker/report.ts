import type { CheckResult, Finding } from "./types";

const PROTOCOL = `How to use this report: work through Blocking, then Questions, then Warnings. Each item gives steps to run against your own code and the condition the next check verifies. After pushing, run the same check again. Keys stay the same across runs.`;

function where(f: Finding): string {
  return f.line === null ? f.path : `${f.path}:${f.line}`;
}

function heading(f: Finding): string {
  const rule = f.rule === null ? "" : ` · rule ${f.rule}`;
  return `### ${f.id}${rule} · ${where(f)} · key ${f.key}`;
}

function item(f: Finding): string {
  const out = [heading(f), ""];
  if (f.quote) out.push(`> \`${f.quote.trim()}\``, "");
  if (f.question) out.push(`**Question:** ${f.question}`, "");
  out.push(`**${f.kind === "warning" ? "Note" : "Reason"}:** ${f.summary}`, "");
  if (f.note) out.push(`**Caveat:** ${f.note}`, "");
  if (f.why) out.push(`**Why:** ${f.why}`, "");
  if (f.steps.length) {
    out.push("**Steps:**", "");
    f.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
    out.push("");
  }
  if (f.resolution) out.push(`**Resolved when:** ${f.resolution}`, "");
  return out.join("\n");
}

function section(title: string, items: Finding[]): string {
  const body = items.length ? items.map(item).join("\n") : "none\n";
  return `## ${title}\n\n${body}`;
}

function statusLine(r: CheckResult): string {
  const fails = r.ruleStatuses.filter((s) => s.status === "FAIL").length;
  const unsure = r.ruleStatuses.filter((s) => s.status === "UNSURE").length;
  const total = r.rules.length;
  if (r.status === "fail") {
    const rest = unsure
      ? ` ${unsure} need${unsure === 1 ? "s" : ""} an answer.`
      : "";
    return `**FAIL.** ${fails} of ${total} rules fail.${rest}`;
  }
  if (r.status === "unsure") {
    return `**UNSURE.** No rule fails, but ${unsure} of ${total} need${unsure === 1 ? "s" : ""} an answer or more coverage.`;
  }
  return `**PASS.** All ${total} rules pass on every checked file.`;
}

function ruleTable(r: CheckResult): string {
  const rows = r.ruleStatuses.map((s) => {
    const rule = r.rules.find((x) => x.id === s.rule);
    const text = (rule?.text ?? "").replace(/\|/g, "\\|");
    return `| ${s.rule} | ${text} | ${s.status} | ${s.detail} |`;
  });
  return [
    "| Rule | Text | Status | Detail |",
    "| --- | --- | --- | --- |",
    ...rows
  ].join("\n");
}

export function machineReport(r: CheckResult): Record<string, unknown> {
  return {
    schema_version: r.schemaVersion,
    check_id: r.id,
    status: r.status,
    pr: { url: r.pr.url, head_sha: r.pr.headSha },
    rules_hash: r.rulesHash,
    rules: r.ruleStatuses.map((s) => {
      const rule = r.rules.find((x) => x.id === s.rule);
      return {
        id: s.rule,
        text: rule?.text ?? "",
        polarity: rule?.polarity ?? "must",
        scope: rule?.scope ?? "file",
        applies_to: rule?.appliesTo ?? null,
        status: s.status,
        detail: s.detail
      };
    }),
    findings: r.findings,
    not_checked: r.notChecked,
    coverage_complete: r.coverageComplete,
    rerun: {
      api: {
        method: "POST",
        path: "/api/check",
        body: { prUrl: r.pr.url, workspace: r.workspace }
      }
    }
  };
}

// The same report every time: fixed sections in a fixed order, "none" when empty.
export function renderReport(r: CheckResult, opts: { json: boolean }): string {
  const checked = r.files.filter((f) => f.state === "checked").length;
  const total = r.files.length + r.notChecked.length;
  const coverage = `Checked ${checked} of ${total} changed files against ${r.rules.length} rules at \`${r.pr.headSha.slice(0, 7)}\`.`;
  const parts = [
    `# PR check · ${r.pr.owner}/${r.pr.repo}#${r.pr.number} · ${r.status.toUpperCase()}`,
    "",
    PROTOCOL,
    "",
    "## Status",
    "",
    statusLine(r),
    "",
    coverage,
    "",
    ruleTable(r),
    "",
    section(
      "Blocking",
      r.findings.filter((f) => f.kind === "blocking")
    ),
    section(
      "Questions",
      r.findings.filter((f) => f.kind === "question")
    ),
    section(
      "Warnings",
      r.findings.filter((f) => f.kind === "warning")
    ),
    "## Not checked",
    "",
    r.notChecked.length
      ? r.notChecked.map((n) => `- \`${n.path}\`: ${n.reason}`).join("\n") +
        "\n"
      : "none\n",
    "## Intent",
    "",
    "Not compared in this version.\n"
  ];
  if (opts.json) {
    parts.push(
      "## Machine-readable",
      "",
      "```json",
      JSON.stringify(machineReport(r), null, 2),
      "```",
      ""
    );
  }
  return parts.join("\n");
}
