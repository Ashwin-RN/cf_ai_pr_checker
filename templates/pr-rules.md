# Pull request rules

Copy this file to the root of your repository as `pr-rules.md`. The checker reads only the list items; headings and prose around them are ignored. Write each rule as one sentence that says what must or must not be true, and name the directory it applies to when it has one.

- No `console.log` or `console.debug` calls in files under src/
- No secret values are hardcoded; references like `secrets.X` and `process.env.X` are fine
- No `TODO` or `FIXME` comment without a link to an issue
- Every workflow under .github/workflows/ pins each action to a major version tag such as `@v4`
- Every new exported function under src/ has a test under test/
- Every new HTTP route has a test that calls it
- No new dependency is added to package.json without a one-line reason in the pull request description
- Errors shown to users do not include stack traces or internal paths
