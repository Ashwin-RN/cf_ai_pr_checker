# Pull request rules

The checker runs these rules on every pull request to this repository. Only the list items are rules.

- No `console.log` or `console.debug` calls in files under src/
- No secret values are hardcoded; references like `secrets.X`, `env.X` and `.dev.vars` are fine
- Every workflow under .github/workflows/ pins each action to a major version tag such as `@v4`
- No use of the `any` type in files under src/
- Every change to the code under src/checker/ comes with a change to a test under test/
