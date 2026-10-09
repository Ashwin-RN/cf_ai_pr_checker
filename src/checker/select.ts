import { limits } from "./limits";
import type { PrFile, Skipped } from "./types";

const TEST_PATH = /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[a-z]+$/i;
const CONFIG_OR_DOCS =
  /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ini|cfg|lock)$|(^|\/)\.[^/]+$/i;

// Source first, tests second, config and docs last, so the cap drops docs before code.
export function priority(path: string): number {
  if (TEST_PATH.test(path)) return 1;
  if (CONFIG_OR_DOCS.test(path)) return 2;
  return 0;
}

// Stands in for the files past the page cap of the file list, which no
// rule's scope can be matched against.
export const MORE_FILES = "(more files)";

export type Selection = { checked: PrFile[]; skipped: Skipped[] };

export function selectFiles(files: PrFile[]): Selection {
  const skipped: Skipped[] = [];
  const candidates: PrFile[] = [];
  for (const file of files) {
    if (limits.skipPaths.some((re) => re.test(file.path))) {
      skipped.push({
        path: file.path,
        reason: "lockfile, generated, vendored or binary",
        coverage: false
      });
    } else if (file.status === "removed") {
      skipped.push({
        path: file.path,
        reason: "deleted by this pull request",
        coverage: false
      });
    } else if (!file.patch) {
      skipped.push({
        path: file.path,
        reason: "no diff available (binary or too large)",
        coverage: true
      });
    } else {
      candidates.push(file);
    }
  }
  const ordered = candidates
    .map((file, index) => ({ file, index, rank: priority(file.path) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.file);
  const checked = ordered.slice(0, limits.filesPerCheck);
  for (const file of ordered.slice(limits.filesPerCheck)) {
    skipped.push({
      path: file.path,
      reason: `over the cap of ${limits.filesPerCheck} files per check`,
      coverage: true
    });
  }
  return { checked, skipped };
}

// Keeps the selected files within a character budget, dropping from the end
// of the priority order. What is dropped is a coverage gap, named as such.
export function fitFiles(
  checked: PrFile[],
  maxChars: number
): { checked: PrFile[]; dropped: Skipped[] } {
  const kept: PrFile[] = [];
  let used = 0;
  for (const file of checked) {
    used += JSON.stringify(file).length;
    if (used > maxChars) break;
    kept.push(file);
  }
  return {
    checked: kept,
    dropped: checked.slice(kept.length).map((file) => ({
      path: file.path,
      reason: "over the size budget of one Workflow step",
      coverage: true
    }))
  };
}
