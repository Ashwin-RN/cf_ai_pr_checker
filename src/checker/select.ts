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

export type Selection = {
  checked: PrFile[];
  skipped: Skipped[];
  coverageComplete: boolean;
};

export function selectFiles(files: PrFile[]): Selection {
  const skipped: Skipped[] = [];
  let coverageComplete = true;
  const candidates: PrFile[] = [];
  for (const file of files) {
    if (limits.skipPaths.some((re) => re.test(file.path))) {
      skipped.push({
        path: file.path,
        reason: "lockfile, generated, vendored or binary"
      });
    } else if (!file.patch) {
      skipped.push({
        path: file.path,
        reason: "no diff available (binary or too large)"
      });
      coverageComplete = false;
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
      reason: `over the cap of ${limits.filesPerCheck} files per check`
    });
    coverageComplete = false;
  }
  return { checked, skipped, coverageComplete };
}
