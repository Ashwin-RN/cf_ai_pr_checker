import type { CheckResult, Finding, RuleStatus } from "./types";

const PROTOCOL = `How to use this report: work through Blocking, then Questions, then Warnings. Each item gives steps to run against your own code and the condition the next check verifies. After pushing, run the same check again: keys stay the same across runs, and each item says whether it is new or still open. A blocking item marked pre-existing sits on a line this pull request does not change; it is reported but does not fail the check unless strict.`;

function where(f: Finding): string {
  return f.line === null ? f.path : `${f.path}:${f.line}`;
}

function heading(f: Finding): string {
  const rule = f.rule === null ? "" : ` · rule ${f.rule}`;
  const tags = [
    f.origin === "pre-existing" ? "pre-existing" : null,
    f.change === "new" ? "new" : f.change === "open" ? "still open" : null
  ]
    .filter(Boolean)
    .map((t) => ` · ${t}`)
    .join("");
  return `### ${f.id}${rule} · ${where(f)} · key ${f.key}${tags}`;
}

function item(f: Finding): string {
  const out = [heading(f), ""];
  if (f.quote) out.push(`> \`${f.quote.trim()}\``, "");
  if (f.question) out.push(`**Question:** ${f.question}`, "");
  out.push(`**${f.kind === "warning" ? "Note" : "Reason"}:** ${f.summary}`, "");
  if (f.origin === "pre-existing") {
    out.push(
      "**Origin:** pre-existing. The line is not changed by this pull request.",
      ""
    );
  }
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function statusLine(r: CheckResult): string {
  const failing = r.ruleStatuses.filter((s) => s.status === "FAIL");
  const blocking = failing.filter((s) => s.blocking).length;
  const preExisting = failing.length - blocking;
  const unsure = r.ruleStatuses.filter((s) => s.status === "UNSURE").length;
  const total = r.rules.length;
  const onAdded = r.strict ? "" : " on lines this pull request adds";
  const notes: string[] = [];
  if (preExisting) {
    notes.push(
      `${plural(preExisting, "rule")} fail${preExisting === 1 ? "s" : ""} only on lines it does not change (see Blocking).`
    );
  }
  if (unsure && r.status !== "unsure") {
    notes.push(`${unsure} need${unsure === 1 ? "s" : ""} an answer.`);
  }
  const rest = notes.length ? ` ${notes.join(" ")}` : "";
  if (r.status === "fail") {
    return `**FAIL.** ${blocking} of ${total} rules fail${onAdded}.${rest}`;
  }
  if (r.status === "unsure") {
    return `**UNSURE.** No rule fails${onAdded}, but ${unsure} of ${total} need${unsure === 1 ? "s" : ""} an answer or more coverage.${rest}`;
  }
  return preExisting
    ? `**PASS.** No rule fails${onAdded}.${rest}`
    : `**PASS.** All ${total} rules pass on every checked file.`;
}

function previousLine(r: CheckResult): string | null {
  const p = r.previous;
  if (!p) return null;
  const resolved = p.resolved.length
    ? ` (${p.resolved.map((f) => `${f.id} \`${f.key}\` ${f.path}`).join(", ")})`
    : "";
  const rules = p.rulesChanged ? " The rules changed since then." : "";
  return `Since the last check at \`${p.headSha.slice(0, 7)}\`: ${p.new} new, ${p.open} still open, ${p.resolved.length} resolved${resolved}.${rules}`;
}

function statusCell(s: RuleStatus): string {
  return s.status === "FAIL" && !s.blocking ? "FAIL (pre-existing)" : s.status;
}

function ruleTable(r: CheckResult): string {
  const rows = r.ruleStatuses.map((s) => {
    const rule = r.rules.find((x) => x.id === s.rule);
    const text = (rule?.text ?? "").replace(/\|/g, "\\|");
    return `| ${s.rule} | ${text} | ${statusCell(s)} | ${s.detail} |`;
  });
  return [
    "| Rule | Text | Status | Detail |",
    "| --- | --- | --- | --- |",
    ...rows
  ].join("\n");
}

// Files left out, files the model could not check, and files checked in part.
function notCheckedSection(r: CheckResult): string {
  const lines = r.notChecked.map((n) => `- \`${n.path}\`: ${n.reason}`);
  for (const f of r.files) {
    if (f.state === "failed") {
      lines.push(`- \`${f.path}\`: not checked, ${f.reason}`);
    } else if (f.coverage === "partial") {
      lines.push(`- \`${f.path}\`: partially checked, ${f.reason}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "none\n";
}

function intentSection(r: CheckResult): string {
  const lines = [r.intent.summary];
  for (const u of r.intent.unmentioned) {
    lines.push(`- Not in the description: ${u.text}`);
  }
  for (const c of r.intent.unsupported) {
    lines.push(`- Described but not seen in the changed files: ${c}`);
  }
  return `${lines.join("\n")}\n`;
}

export function machineReport(r: CheckResult): Record<string, unknown> {
  return {
    schema_version: r.schemaVersion,
    check_id: r.id,
    status: r.status,
    strict: r.strict,
    pr: { url: r.pr.url, head_sha: r.pr.headSha, title: r.pr.title },
    rules_hash: r.rulesHash,
    rules_source: r.rulesSource,
    runner: r.runner,
    rules: r.ruleStatuses.map((s) => {
      const rule = r.rules.find((x) => x.id === s.rule);
      return {
        id: s.rule,
        text: rule?.text ?? "",
        polarity: rule?.polarity ?? "must",
        scope: rule?.scope ?? "file",
        applies_to: rule?.appliesTo ?? null,
        status: s.status,
        blocking: s.blocking,
        detail: s.detail
      };
    }),
    findings: r.findings,
    cross_file: r.crossFile.map((c) => ({
      rule: c.rule,
      verdict: c.verdict,
      facts: c.facts.map((f) => f.text),
      reason: c.reason,
      question: c.question
    })),
    intent: r.intent,
    previous: r.previous,
    not_checked: r.notChecked,
    coverage_complete: r.coverageComplete,
    model_calls: r.modelCalls,
    rerun: {
      api: {
        method: "POST",
        path: "/api/check",
        body: { prUrl: r.pr.url, workspace: r.workspace, strict: r.strict }
      }
    }
  };
}

// The same report every time: fixed sections in a fixed order, "none" when empty.
export function renderReport(r: CheckResult, opts: { json: boolean }): string {
  const checked = r.files.filter((f) => f.state === "checked").length;
  const total = r.files.length + r.notChecked.length;
  const coverage = `Checked ${checked} of ${total} changed files against ${plural(r.rules.length, "rule")} from ${r.rulesSource} (set \`${r.rulesHash}\`) at \`${r.pr.headSha.slice(0, 7)}\`.`;
  const since = previousLine(r);
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
    ...(since ? [since, ""] : []),
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
    notCheckedSection(r),
    "## Intent",
    "",
    intentSection(r)
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
