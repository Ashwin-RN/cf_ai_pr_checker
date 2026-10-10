// Every cap the checker applies, in one place.
export const limits = {
  // Workers Free allows 50 external subrequests per invocation.
  // One check spends 2 on the pull request, 1 on the rules file and 1 per file.
  filesPerCheck: 20,
  // Fits the 24k-token window of Llama 3.3 with rules, one file and output.
  charsPerModelCall: 40_000,
  maxOutputTokens: 3_000,
  // A file over the size cap is split around its changes. Past this many
  // chunks it is partially checked.
  chunksPerFile: 6,
  hunkContextLines: 80,
  parallelModelCalls: 5,
  modelRetries: 1,
  stepsPerFinding: 4,
  factsPerFile: 5,
  factsPerSettle: 150,
  // Files outside the pull request that a check reads because the last
  // check asked for them, one model call each, and the facts kept per file.
  evidenceFilesPerCheck: 3,
  evidenceFacts: 8,
  evidencePathChars: 200,
  warningsPerFile: 3,
  warningsPerReport: 5,
  // A quote matches a whole line, or a substring once it is long enough not
  // to match by accident.
  quoteMinChars: 4,
  quoteSubstringMinChars: 12,
  rulesMax: 30,
  ruleChars: 300,
  descriptionChars: 4_000,
  intentItems: 3,
  fileBytesMax: 1_000_000,
  fileListPagesMax: 3,
  // A Workflow step's output is capped at 1 MiB. The file list travels
  // without its diffs and the selected diffs are trimmed to fit under this.
  stepOutputChars: 800_000,
  // Retries for a Workflow step that fails outright. A model error is a
  // result, not a retry.
  stepRetries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
  stepTimeout: "10 minutes",
  // How long the agent waits for a check, and how often it looks at the
  // stored row while waiting.
  checkWaitMs: 15 * 60_000,
  checkPollMs: 2_000,
  // An answer to a question is stored as given, up to this length, and
  // shown in the rule table cut to the preview length.
  answerChars: 1_000,
  answerPreviewChars: 80,
  skipPaths: [
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$/,
    /\.min\.(js|css)$/,
    /(^|\/)(dist|build|vendor|node_modules)\//,
    /\.(png|jpe?g|gif|webp|svg|ico|pdf|woff2?|ttf|eot|zip|gz|mp4|mp3)$/i
  ]
} as const;
