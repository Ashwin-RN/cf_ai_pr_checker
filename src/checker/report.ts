import { mechanicalKind } from "./mechanical";
import { ACROSS_FILES } from "./merge";
import type { CheckResult, EvidenceFile, Finding, RuleStatus } from "./types";

const PROTOCOL = `How to use this report: work through Blocking, then Questions, then Warnings. Each item gives steps to run against your own code and the condition the next check verifies. After pushing, run the same check again: keys stay the same across runs, and each item says whether it is new or still open. A blocking item marked pre-existing sits on a line this pull request does not change; it is reported but does not fail the check unless strict. A question can be answered when the rule is met in a way the check cannot see; an item marked answered is settled by that answer and counts as a pass unless strict. An item marked waived is on a rule excused for this pull request with a recorded reason; its evidence stands, and the rule neither blocks nor leaves the check unsure, unless strict.`;

function where(f: Finding): string {
  return f.line === null ? f.path : `${f.path}:${f.line}`;
}

// Whether a claim on the item, an answer or a waiver, settles it this run.
function settled(f: Finding): boolean {
  return Boolean(f.attestation?.counted || f.waiver?.counted);
}

function heading(f: Finding): string {
  const rule = f.rule === null ? "" : ` · rule ${f.rule}`;
  const tags = [
    f.origin === "pre-existing" ? "pre-existing" : null,
    f.change === "new" ? "new" : f.change === "open" ? "still open" : null,
    f.attestation ? "answered" : null,
    f.waiver ? "waived" : null,
    f.by === "pattern" ? "checked by pattern" : null
  ]
    .filter(Boolean)
    .map((t) => ` · ${t}`)
    .join("");
  return `### ${f.id}${rule} · ${where(f)} · key ${f.key}${tags}`;
}

// What a requested file gave this run, in one line.
function evidenceLine(e: EvidenceFile, headSha: string): string {
  if (e.state === "read") {
    const facts = e.facts.length
      ? `: ${e.facts.join("; ")}`
      : ", and it reported nothing that bears on the rule";
    const cut = e.reason ? ` (${e.reason})` : "";
    return `\`${e.path}\` was read this run${cut}${facts}`;
  }
  if (e.state === "missing") {
    return `\`${e.path}\` does not exist at \`${headSha.slice(0, 7)}\``;
  }
  return `\`${e.path}\` could not be read this run (${e.reason ?? "unknown reason"})`;
}

function item(f: Finding, r: CheckResult): string {
  const out = [heading(f), ""];
  if (f.quote) out.push(`> \`${f.quote.trim()}\``, "");
  if (f.question) out.push(`**Question:** ${f.question}`, "");
  // Files the last check asked for on this rule, and the one this check asks for.
  if (f.path === ACROSS_FILES && f.rule !== null) {
    for (const e of r.evidence.filter((e) => e.rule === f.rule)) {
      out.push(`**Evidence read:** ${evidenceLine(e, r.pr.headSha)}.`, "");
    }
  }
  if (f.evidence) {
    out.push(
      `**Evidence requested:** \`${f.evidence}\`. The next check of this pull request reads it and settles the rule from what it holds, or from its absence.`,
      ""
    );
  }
  const a = f.attestation;
  if (a) {
    const stands = a.counted
      ? "counts as a pass by attestation"
      : (a.note ?? "not counted");
    out.push(
      `**Answer:** ${a.answer} (given at \`${a.headSha.slice(0, 7)}\`; ${stands})`,
      ""
    );
  }
  const w = f.waiver;
  if (w) {
    const stands = w.counted
      ? ["the rule does not block", w.note].filter(Boolean).join("; ")
      : (w.note ?? "not counted");
    out.push(
      `**Waived:** ${w.reason} (given at \`${w.headSha.slice(0, 7)}\`; ${stands})`,
      ""
    );
  }
  out.push(`**${f.kind === "warning" ? "Note" : "Reason"}:** ${f.summary}`, "");
  if (f.origin === "pre-existing") {
    out.push(
      "**Origin:** pre-existing. The line is not changed by this pull request.",
      ""
    );
  }
  if (f.note) out.push(`**Caveat:** ${f.note}`, "");
  // A claim that counts settles the item; its steps are for the unsettled.
  if (settled(f)) return out.join("\n");
  if (f.why) out.push(`**Why:** ${f.why}`, "");
  if (f.steps.length) {
    out.push("**Steps:**", "");
    f.steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
    out.push("");
  }
  if (f.resolution) out.push(`**Resolved when:** ${f.resolution}`, "");
  return out.join("\n");
}

// Open items first; answered and waived ones follow, so the reader meets
// what still needs work before what is settled.
function section(title: string, items: Finding[], r: CheckResult): string {
  const ordered = [
    ...items.filter((f) => !settled(f)),
    ...items.filter((f) => settled(f))
  ];
  const body = ordered.length
    ? ordered.map((f) => item(f, r)).join("\n")
    : "none\n";
  return `## ${title}\n\n${body}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Rules whose blocking items all sit on lines the pull request does not
// change. Counted from the items, since such a rule may read UNSURE when
// another file leaves it open.
function unchangedOnly(r: CheckResult): number {
  const rules = new Set<number>();
  for (const f of r.findings) {
    if (f.kind === "blocking" && f.rule !== null && f.origin === "pre-existing")
      rules.add(f.rule);
  }
  for (const f of r.findings) {
    if (f.kind === "blocking" && f.rule !== null && f.origin !== "pre-existing")
      rules.delete(f.rule);
  }
  return rules.size;
}

function statusLine(r: CheckResult): string {
  const blocking = r.ruleStatuses.filter((s) => s.blocking).length;
  const preExisting = unchangedOnly(r);
  const unsure = r.ruleStatuses.filter(
    (s) => !s.waived && (s.status === "UNSURE" || !s.complete)
  ).length;
  const attested = r.ruleStatuses.filter((s) => s.attested).length;
  const waived = r.ruleStatuses.filter((s) => s.waived).length;
  const total = r.rules.length;
  const onAdded = r.strict ? "" : " on lines this pull request adds";
  const notes: string[] = [];
  if (preExisting) {
    notes.push(
      `${plural(preExisting, "rule")} fail${preExisting === 1 ? "s" : ""} only on lines it does not change (see Blocking).`
    );
  }
  if (unsure && r.status !== "unsure") {
    notes.push(
      `${unsure} need${unsure === 1 ? "s" : ""} an answer or more coverage.`
    );
  }
  if (attested) {
    notes.push(
      `${attested} pass${attested === 1 ? "es" : ""} by attestation (see Questions).`
    );
  }
  if (waived) {
    notes.push(
      `${waived} ${waived === 1 ? "is" : "are"} waived for this pull request (see the rule table).`
    );
  }
  const rest = notes.length ? ` ${notes.join(" ")}` : "";
  if (r.status === "fail") {
    return `**FAIL.** ${blocking} of ${total} rules fail${onAdded}.${rest}`;
  }
  if (r.status === "unsure") {
    return `**UNSURE.** No rule fails${onAdded}, but ${unsure} of ${total} need${unsure === 1 ? "s" : ""} an answer or more coverage.${rest}`;
  }
  if (waived) return `**PASS.** No rule blocks.${rest}`;
  return preExisting
    ? `**PASS.** No rule fails${onAdded}.${rest}`
    : `**PASS.** All ${total} rules pass on every checked file.${rest}`;
}

function previousLine(r: CheckResult): string | null {
  const p = r.previous;
  if (!p) return null;
  const list = (fs: typeof p.resolved) =>
    fs.map((f) => `${f.id} \`${f.key}\` ${f.path}`).join(", ");
  const resolved = p.resolved.length ? ` (${list(p.resolved)})` : "";
  const unassessed = p.unassessed.length
    ? `, ${p.unassessed.length} not assessed (${list(p.unassessed)}; not checked again this run)`
    : "";
  const rules = p.rulesChanged ? " The rules changed since then." : "";
  return `Since the last check at \`${p.headSha.slice(0, 7)}\`: ${p.new} new, ${p.open} still open, ${p.resolved.length} resolved${resolved}${unassessed}.${rules}`;
}

function statusCell(s: RuleStatus): string {
  if (s.waived) return `${s.status} (waived)`;
  if (s.attested) return "PASS (attested)";
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

// Files left out, files the model could not check, files checked in part,
// and files checked around their changes only.
function notCheckedSection(r: CheckResult): string {
  const lines = r.notChecked.map((n) => `- \`${n.path}\`: ${n.reason}`);
  for (const f of r.files) {
    if (f.state === "failed") {
      lines.push(`- \`${f.path}\`: not checked, ${f.reason}`);
    } else if (f.coverage === "partial") {
      lines.push(`- \`${f.path}\`: partially checked, ${f.reason}`);
    } else if (f.coverage === "changes") {
      lines.push(
        `- \`${f.path}\`: checked around its changes in ${plural(f.chunks, "part")}; the rest of the file was not shown`
      );
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
        // "pattern" when code decides the rule with no model call.
        checked_by:
          rule && mechanicalKind(rule.text) !== null ? "pattern" : "model",
        status: s.status,
        blocking: s.blocking,
        complete: s.complete,
        attested: s.attested,
        waived: s.waived,
        detail: s.detail
      };
    }),
    findings: r.findings,
    // Every waiver on the pull request, active and revoked: the history of
    // what was excused, when, and why.
    waivers: r.waivers.map((w) => ({
      rule: w.rule,
      reason: w.reason,
      check_id: w.checkId,
      head_sha: w.headSha,
      rules_hash: w.rulesHash,
      created_at: w.createdAt,
      revoked_at: w.revokedAt
    })),
    cross_file: r.crossFile.map((c) => ({
      rule: c.rule,
      verdict: c.verdict,
      facts: c.facts.map((f) => f.text),
      reason: c.reason,
      question: c.question,
      evidence_path: c.evidencePath
    })),
    // Files outside the pull request read this run because the last check
    // asked for them, with what each gave.
    evidence: r.evidence,
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
      },
      mcp: {
        tool: "check_pr",
        arguments: { pr_url: r.pr.url, strict: r.strict }
      }
    },
    // How to answer a question: by the item's id from this run, or its key.
    answer: {
      api: {
        method: "POST",
        path: "/api/answer",
        body: {
          checkId: r.id,
          workspace: r.workspace,
          question: "<id or key>",
          answer: "<how the rule is met>"
        }
      },
      mcp: {
        tool: "answer_question",
        arguments: {
          check_id: r.id,
          question: "<id or key>",
          answer: "<how the rule is met>"
        }
      }
    },
    // How to excuse a rule for this pull request, with a reason that is kept.
    waive: {
      api: {
        method: "POST",
        path: "/api/waive",
        body: {
          checkId: r.id,
          workspace: r.workspace,
          rule: "<rule number>",
          reason: "<why the rule does not apply here>"
        }
      },
      mcp: {
        tool: "waive_rule",
        arguments: {
          check_id: r.id,
          rule: "<rule number>",
          reason: "<why the rule does not apply here>"
        }
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
      r.findings.filter((f) => f.kind === "blocking"),
      r
    ),
    section(
      "Questions",
      r.findings.filter((f) => f.kind === "question"),
      r
    ),
    section(
      "Warnings",
      r.findings.filter((f) => f.kind === "warning"),
      r
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
