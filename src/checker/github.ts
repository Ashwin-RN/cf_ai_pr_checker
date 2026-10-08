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
