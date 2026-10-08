import { limits } from "./limits";
import type { Pr, PrFile } from "./types";

export type PrRef = { owner: string; repo: string; number: number };

const PR_PATH =
  /^\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?\/pull\/(\d+)(?:\/.*)?$/;

// Accepts only a GitHub pull request link. Anything else returns null.
export function parsePrUrl(input: string): PrRef | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    return null;
  }
  const match = PR_PATH.exec(url.pathname);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: match[1], repo: match[2], number };
}

// The first GitHub pull request link anywhere in a message.
export function findPrUrl(text: string): string | null {
  for (const m of text.matchAll(
    /https?:\/\/(?:www\.)?github\.com\/[^\s)>\]]+/g
  )) {
    if (parsePrUrl(m[0])) return m[0];
  }
  return null;
}

export type GithubErrorKind = "not_found" | "rate_limited" | "error";

export class GithubError extends Error {
  constructor(
    public kind: GithubErrorKind,
    message: string,
    public resetAt: Date | null = null
  ) {
    super(message);
  }
}

export type GithubDeps = { fetch: typeof fetch; token?: string };

type PrJson = {
  title: string;
  body: string | null;
  html_url: string;
  head: { sha: string };
  base: { ref: string };
};

type FileJson = {
  filename: string;
  previous_filename?: string;
  status: string;
  sha: string;
  additions: number;
  deletions: number;
  patch?: string;
};

async function github<T>(deps: GithubDeps, path: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "cf-ai-pr-checker",
    "x-github-api-version": "2022-11-28"
  };
  if (deps.token) headers.authorization = `Bearer ${deps.token}`;
  const res = await deps.fetch(`https://api.github.com${path}`, { headers });
  if (res.ok) return (await res.json()) as T;
  if (res.status === 404) {
    throw new GithubError(
      "not_found",
      "That pull request is private or does not exist."
    );
  }
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const resetAt = reset ? new Date(reset * 1000) : null;
    const when = resetAt ? ` It resets at ${resetAt.toISOString()}.` : "";
    throw new GithubError(
      "rate_limited",
      `GitHub's rate limit is used up.${when} A GITHUB_TOKEN secret raises it.`,
      resetAt
    );
  }
  throw new GithubError("error", `GitHub answered ${res.status} for ${path}.`);
}

// Pull request metadata plus the changed files with their patches.
export async function fetchPr(ref: PrRef, deps: GithubDeps): Promise<Pr> {
  const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const pr = await github<PrJson>(deps, base);
  const files: PrFile[] = [];
  let fileListTruncated = false;
  for (let page = 1; page <= limits.fileListPagesMax; page++) {
    const batch = await github<FileJson[]>(
      deps,
      `${base}/files?per_page=100&page=${page}`
    );
    for (const f of batch) {
      files.push({
        path: f.filename,
        previousPath: f.previous_filename ?? null,
        status: f.status,
        sha: f.sha,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null
      });
    }
    if (batch.length < 100) break;
    if (page === limits.fileListPagesMax) fileListTruncated = true;
  }
  return {
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    url: pr.html_url,
    title: pr.title,
    body: pr.body ?? "",
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    files,
    fileListTruncated
  };
}
