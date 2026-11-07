# @fabrika/runner-container

The plain-Bun deploy container. One process accepts one provider-owned job, clones its repository,
installs dependencies, and runs `fabrika-cloudflare-executor deploy`.

The Worker↔container transport types and paths come from `@fabrika/provider-cloudflare/runner`.
`CloudflareRunnerJob` remains owned and validated by `@fabrika/provider-cloudflare`.

## Commands

```bash
bun run serve
bun test
cpu-lease run -n 4 -- bun run docker:build
bun run docker:smoke
```

## Invariants

- Pass credentials and the state namespace through the executor's environment. Pass secrets, vars and managed values
  in `$FABRIKA_DEPLOY_VALUES_FILE` (`<workspace>/<runId>.values.json`, mode 0600, removed after the deploy step), never
  in any child's environment: their names are the application's, and a name such as a runtime's options variable or
  `CLOUDFLARE_API_TOKEN` would steer or re-credential the process that holds the account token.
- Never put secret values on argv or in logs.
- Redact a log line only after it is assembled across chunk boundaries — a pipe read cuts credentials in half.
- Put `--` before the positionals of every `git` invocation; job strings are attacker-controlled.
- Resolve `workerDir` and `configPath` inside the checkout before any spawn; refuse absolute paths and `..`.
- The executor reports back through `$FABRIKA_RUNNER_OUTCOME_FILE`, beside the checkout and never inside it.
  Bounded, shape-checked, deleted after reading; a bad one fails the run and its contents never reach a log.
- Reject a second run while one is active.
- Keep `wrangler` available globally in the image.
- Copy every local workspace dependency into the slim Docker workspace.
