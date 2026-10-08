import type { CheckResult, FileCheck, Rule } from "./checker/types";

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
      hash TEXT PRIMARY KEY, rules_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL)`;
    this
      .sql`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY, pr_url TEXT NOT NULL, rules_hash TEXT NOT NULL, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, finished_at INTEGER, result_json TEXT, error TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS file_results (
      check_id TEXT NOT NULL, path TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT NOT NULL,
      raw_model_output TEXT, PRIMARY KEY (check_id, path))`;
  }

  saveRules(rules: Rule[], hash: string, source: string): void {
    this
      .sql`INSERT OR REPLACE INTO rule_sets (hash, rules_json, source, created_at)
      VALUES (${hash}, ${JSON.stringify(rules)}, ${source}, ${Date.now()})`;
    this.sql`INSERT INTO settings (key, value) VALUES ('rules_hash', ${hash})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  currentRules(): { rules: Rule[]; hash: string } | null {
    const row = this.sql<{ hash: string; rules_json: string }>`
      SELECT r.hash, r.rules_json FROM settings s JOIN rule_sets r ON r.hash = s.value
      WHERE s.key = 'rules_hash'`[0];
    return row
      ? { rules: JSON.parse(row.rules_json) as Rule[], hash: row.hash }
      : null;
  }

  startCheck(id: string, prUrl: string, rulesHash: string): void {
    this.sql`INSERT INTO checks (id, pr_url, rules_hash, status, started_at)
      VALUES (${id}, ${prUrl}, ${rulesHash}, 'running', ${Date.now()})`;
  }

  finishCheck(result: CheckResult): void {
    this
      .sql`UPDATE checks SET status = ${result.status}, finished_at = ${result.finishedAt},
      result_json = ${JSON.stringify(result)} WHERE id = ${result.id}`;
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

  getCheck(id: string): CheckResult | null {
    const row = this.sql<{ result_json: string | null }>`
      SELECT result_json FROM checks WHERE id = ${id}`[0];
    return row?.result_json
      ? (JSON.parse(row.result_json) as CheckResult)
      : null;
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
