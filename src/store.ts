import type {
  CheckResult,
  FileCheck,
  PreviousRun,
  Rule,
  RuleSet
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
      result: row.result_json
        ? (JSON.parse(row.result_json) as CheckResult)
        : null
    };
  }

  getCheck(id: string): CheckResult | null {
    const row = this.sql<{ result_json: string | null }>`
      SELECT result_json FROM checks WHERE id = ${id}`[0];
    return row?.result_json
      ? (JSON.parse(row.result_json) as CheckResult)
      : null;
  }

  // The last finished check of the same pull request, for the run-to-run diff.
  previousCheck(prUrl: string): PreviousRun | null {
    const row = this.sql<{ result_json: string | null }>`
      SELECT result_json FROM checks WHERE pr_url = ${prUrl} AND result_json IS NOT NULL
      ORDER BY started_at DESC LIMIT 1`[0];
    if (!row?.result_json) return null;
    const r = JSON.parse(row.result_json) as CheckResult;
    return {
      checkId: r.id,
      headSha: r.pr.headSha,
      rulesHash: r.rulesHash,
      findings: r.findings.map((f) => ({
        id: f.id,
        key: f.key,
        kind: f.kind,
        path: f.path,
        summary: f.summary
      }))
    };
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
