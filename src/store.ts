import type {
  Attestation,
  CheckResult,
  FileCheck,
  PreviousRun,
  Rule,
  RuleSet,
  Waiver
} from "./checker/types";

type Value = string | number | boolean | null;
export type Sql = <T = Record<string, Value>>(
  strings: TemplateStringsArray,
  ...values: Value[]
) => T[];

export type CheckRow = {
  id: string;
  prUrl: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
};

// A stored result from an earlier build of the checker lacks the fields
// added since. They are filled in on read so every stored report renders
// and compares; nothing is rewritten.
export function readResult(json: string): CheckResult {
  const r = JSON.parse(json) as CheckResult;
  r.ruleStatuses = r.ruleStatuses.map((s) => ({
    ...s,
    complete: s.complete ?? r.coverageComplete ?? true,
    attested: s.attested ?? false,
    waived: s.waived ?? false
  }));
  r.findings = r.findings.map((f) => ({
    ...f,
    attestation: f.attestation ?? null,
    waiver: f.waiver ?? null,
    evidence: f.evidence ?? null
  }));
  r.files = (r.files ?? []).map((f) => ({
    ...f,
    seen: f.seen ?? {},
    verdicts: (f.verdicts ?? []).map((v) => ({
      ...v,
      mechanical: v.mechanical ?? false
    }))
  }));
  r.crossFile = (r.crossFile ?? []).map((c) => ({
    ...c,
    evidencePath: c.evidencePath ?? null
  }));
  r.notChecked ??= [];
  r.evidence ??= [];
  r.waivers ??= [];
  if (r.previous) {
    r.previous.resolved ??= [];
    r.previous.unassessed ??= [];
  }
  return r;
}

// What the next check of the same pull request compares against: the
// findings of this one, and the earlier findings it could not assess, so an
// item stays known until a run looks at where it came from.
export function previousRunOf(r: CheckResult): PreviousRun {
  const seen = new Set<string>();
  const findings: PreviousRun["findings"] = [];
  for (const f of [...r.findings, ...(r.previous?.unassessed ?? [])]) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    findings.push({
      id: f.id,
      key: f.key,
      kind: f.kind,
      rule: f.rule,
      path: f.path,
      line: f.line ?? null,
      quote: f.quote ?? null,
      summary: f.summary,
      evidence: f.evidence ?? null
    });
  }
  return {
    checkId: r.id,
    headSha: r.pr.headSha,
    rulesHash: r.rulesHash,
    findings
  };
}

// Rules, checks and per-file results live in the Durable Object's SQLite.
export class Store {
  constructor(private sql: Sql) {}

  init(): void {
    this.sql`CREATE TABLE IF NOT EXISTS rule_sets (
      hash TEXT PRIMARY KEY, rules_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL,
      interpreted INTEGER NOT NULL DEFAULT 1)`;
    try {
      this
        .sql`ALTER TABLE rule_sets ADD COLUMN interpreted INTEGER NOT NULL DEFAULT 1`;
    } catch {
      // The column is already there.
    }
    this
      .sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY, pr_url TEXT NOT NULL, rules_hash TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, result_json TEXT, error TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS file_results (
      check_id TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT NOT NULL,
      raw_model_output TEXT, PRIMARY KEY (check_id, path))`;
    this.sql`CREATE TABLE IF NOT EXISTS attestations (
      pr_url TEXT NOT NULL, key TEXT NOT NULL, rule INTEGER, path TEXT NOT NULL,
      question TEXT NOT NULL, answer TEXT NOT NULL, check_id TEXT NOT NULL, head_sha TEXT NOT NULL,
      rules_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (pr_url, key))`;
    // A waiver is never deleted. Revoking sets revoked_at; waiving the rule
    // again adds a row, so the history of a rule on a pull request is whole.
    this.sql`CREATE TABLE IF NOT EXISTS waivers (
      pr_url TEXT NOT NULL, rule INTEGER NOT NULL, reason TEXT NOT NULL, check_id TEXT,
      head_sha TEXT NOT NULL, rules_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      revoked_at INTEGER, PRIMARY KEY (pr_url, rule, created_at))`;
  }

  // A normalised rule set, keyed by the hash of its text. Saving the same
  // text again replaces the interpretation. A set the model could not
  // interpret is kept for use but read back only as the workspace's rules,
  // so the next save tries the model again.
  putRuleSet(set: RuleSet, interpreted = true): void {
    this
      .sql`INSERT OR REPLACE INTO rule_sets (hash, rules_json, source, created_at, interpreted)
      VALUES (${set.hash}, ${JSON.stringify(set.rules)}, ${set.source}, ${Date.now()}, ${interpreted ? 1 : 0})`;
  }

  getRuleSet(hash: string): RuleSet | null {
    const row = this.sql<{ rules_json: string; source: string }>`
      SELECT rules_json, source FROM rule_sets WHERE hash = ${hash} AND interpreted = 1`[0];
    return row
      ? {
          rules: JSON.parse(row.rules_json) as Rule[],
          hash,
          source: row.source
        }
      : null;
  }

  // The workspace's own rules: saved from the chat or the API, used when the
  // checked repository has no rules file.
  saveRules(set: RuleSet, interpreted: boolean): void {
    this.putRuleSet(set, interpreted);
    const hash = set.hash;
    this.sql`INSERT INTO settings (key, value) VALUES ('rules_hash', ${hash})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  currentRules(): RuleSet | null {
    const row = this.sql<{ hash: string; rules_json: string; source: string }>`
      SELECT r.hash, r.rules_json, r.source FROM settings s JOIN rule_sets r ON r.hash = s.value
      WHERE s.key = 'rules_hash'`[0];
    return row
      ? {
          rules: JSON.parse(row.rules_json) as Rule[],
          hash: row.hash,
          source: row.source
        }
      : null;
  }

  startCheck(id: string, prUrl: string): void {
    this.sql`INSERT INTO checks (id, pr_url, rules_hash, status, started_at)
      VALUES (${id}, ${prUrl}, '', 'running', ${Date.now()})`;
  }

  finishCheck(result: CheckResult): void {
    this
      .sql`UPDATE checks SET status = ${result.status}, finished_at = ${result.finishedAt},
      rules_hash = ${result.rulesHash}, result_json = ${JSON.stringify(result)}
      WHERE id = ${result.id}`;
  }

  failCheck(id: string, error: string): void {
    this
      .sql`UPDATE checks SET status = 'error', finished_at = ${Date.now()}, error = ${error}
      WHERE id = ${id}`;
  }

  saveFileResult(checkId: string, file: FileCheck): void {
    const { raw, ...rest } = file;
    this
      .sql`INSERT OR REPLACE INTO file_results (check_id, path, state, result_json, raw_model_output)
      VALUES (${checkId}, ${file.path}, ${file.state}, ${JSON.stringify(rest)}, ${raw})`;
  }

  // Where a check stands: running, finished with a result, or failed.
  checkState(id: string): {
    status: string;
    error: string | null;
    result: CheckResult | null;
  } | null {
    const row = this.sql<{
      status: string;
      error: string | null;
      result_json: string | null;
    }>`SELECT status, error, result_json FROM checks WHERE id = ${id}`[0];
    if (!row) return null;
    return {
      status: row.status,
      error: row.error,
      result: row.result_json ? readResult(row.result_json) : null
    };
  }

  getCheck(id: string): CheckResult | null {
    const row = this.sql<{ result_json: string | null }>`
      SELECT result_json FROM checks WHERE id = ${id}`[0];
    return row?.result_json ? readResult(row.result_json) : null;
  }

  // The id a caller gave, or the one check it is a prefix of. The chat shows
  // eight characters of an id, which is enough to name it. Ids are letters,
  // digits and dashes, so the LIKE below has no wildcard to meet.
  findCheckId(idOrPrefix: string): string | null {
    const given = idOrPrefix.trim();
    if (!/^[0-9a-z-]{4,}$/i.test(given)) return null;
    const rows = this.sql<{ id: string }>`
      SELECT id FROM checks WHERE id = ${given} OR id LIKE ${`${given}%`} LIMIT 2`;
    if (rows.some((r) => r.id === given)) return given;
    return rows.length === 1 ? rows[0].id : null;
  }

  // The most recent check that has a result.
  latestCheckId(): string | null {
    const row = this.sql<{ id: string }>`
      SELECT id FROM checks WHERE result_json IS NOT NULL ORDER BY started_at DESC LIMIT 1`[0];
    return row?.id ?? null;
  }

  // The last finished check of the same pull request, for the run-to-run diff.
  previousCheck(prUrl: string): PreviousRun | null {
    const row = this.sql<{ result_json: string | null }>`
      SELECT result_json FROM checks WHERE pr_url = ${prUrl} AND result_json IS NOT NULL
      ORDER BY started_at DESC LIMIT 1`[0];
    return row?.result_json ? previousRunOf(readResult(row.result_json)) : null;
  }

  // An answer to a question, kept per pull request and finding key. A new
  // answer to the same question replaces the old one.
  putAttestation(prUrl: string, a: Attestation): void {
    this
      .sql`INSERT OR REPLACE INTO attestations (pr_url, key, rule, path, question, answer, check_id, head_sha, rules_hash, created_at)
      VALUES (${prUrl}, ${a.key}, ${a.rule}, ${a.path}, ${a.question}, ${a.answer}, ${a.checkId}, ${a.headSha}, ${a.rulesHash}, ${a.createdAt})`;
  }

  attestationsFor(prUrl: string): Attestation[] {
    return this.sql<{
      key: string;
      rule: number | null;
      path: string;
      question: string;
      answer: string;
      check_id: string;
      head_sha: string;
      rules_hash: string;
      created_at: number;
    }>`SELECT key, rule, path, question, answer, check_id, head_sha, rules_hash, created_at
      FROM attestations WHERE pr_url = ${prUrl} ORDER BY created_at`.map(
      (r) => ({
        key: r.key,
        rule: r.rule,
        path: r.path,
        question: r.question,
        answer: r.answer,
        checkId: r.check_id,
        headSha: r.head_sha,
        rulesHash: r.rules_hash,
        createdAt: r.created_at
      })
    );
  }

  // Waives a rule on a pull request. An active waiver on the same rule is
  // revoked first, so one rule has at most one active waiver.
  putWaiver(prUrl: string, w: Waiver): void {
    this.revokeWaiver(prUrl, w.rule, w.createdAt);
    this
      .sql`INSERT OR REPLACE INTO waivers (pr_url, rule, reason, check_id, head_sha, rules_hash, created_at, revoked_at)
      VALUES (${prUrl}, ${w.rule}, ${w.reason}, ${w.checkId}, ${w.headSha}, ${w.rulesHash}, ${w.createdAt}, ${w.revokedAt})`;
  }

  // Ends the active waiver on a rule, if there is one. True when there was.
  revokeWaiver(prUrl: string, rule: number, at: number): boolean {
    const active = this.sql<{ created_at: number }>`
      SELECT created_at FROM waivers WHERE pr_url = ${prUrl} AND rule = ${rule} AND revoked_at IS NULL`;
    if (!active.length) return false;
    this.sql`UPDATE waivers SET revoked_at = ${at}
      WHERE pr_url = ${prUrl} AND rule = ${rule} AND revoked_at IS NULL`;
    return true;
  }

  // Every waiver on a pull request, oldest first, revoked ones included.
  waiversFor(prUrl: string): Waiver[] {
    return this.sql<{
      rule: number;
      reason: string;
      check_id: string | null;
      head_sha: string;
      rules_hash: string;
      created_at: number;
      revoked_at: number | null;
    }>`SELECT rule, reason, check_id, head_sha, rules_hash, created_at, revoked_at
      FROM waivers WHERE pr_url = ${prUrl} ORDER BY created_at`.map((r) => ({
      rule: r.rule,
      reason: r.reason,
      checkId: r.check_id,
      headSha: r.head_sha,
      rulesHash: r.rules_hash,
      createdAt: r.created_at,
      revokedAt: r.revoked_at
    }));
  }

  // Every finished check, newest first, for the rule statistics.
  finishedResults(limit: number): CheckResult[] {
    return this.sql<{ result_json: string }>`
      SELECT result_json FROM checks WHERE result_json IS NOT NULL
      ORDER BY started_at DESC LIMIT ${limit}`.map((r) =>
      readResult(r.result_json)
    );
  }

  // The pull request a check was started on, finished or not.
  prUrlOf(checkId: string): string | null {
    const row = this.sql<{ pr_url: string }>`
      SELECT pr_url FROM checks WHERE id = ${checkId}`[0];
    return row?.pr_url ?? null;
  }

  // The last finished check of a pull request, whole.
  latestResultFor(prUrl: string): CheckResult | null {
    const row = this.sql<{ result_json: string | null }>`
      SELECT result_json FROM checks WHERE pr_url = ${prUrl} AND result_json IS NOT NULL
      ORDER BY started_at DESC LIMIT 1`[0];
    return row?.result_json ? readResult(row.result_json) : null;
  }

  listChecks(limit = 20): CheckRow[] {
    return this.sql<{
      id: string;
      pr_url: string;
      status: string;
      started_at: number;
      finished_at: number | null;
    }>`SELECT id, pr_url, status, started_at, finished_at FROM checks
      ORDER BY started_at DESC LIMIT ${limit}`.map((r) => ({
      id: r.id,
      prUrl: r.pr_url,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at
    }));
  }
}
