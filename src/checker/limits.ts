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
  warningsPerFile: 3,
  warningsPerReport: 5,
  // A quote matches a whole line, or a substring once it is long enough not
  // to match by accident.
  quoteMinChars: 4,
  quoteSubstringMinChars: 20,
  rulesMax: 30,
  ruleChars: 300,
  descriptionChars: 4_000,
  intentItems: 3,
  fileBytesMax: 1_000_000,
  fileListPagesMax: 3,
  skipPaths: [
    /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$/,
    /\.min\.(js|css)$/,
    /(^|\/)(dist|build|vendor|node_modules)\//,
    /\.(png|jpe?g|gif|webp|svg|ico|pdf|woff2?|ttf|eot|zip|gz|mp4|mp3)$/i
  ]
} as const;
