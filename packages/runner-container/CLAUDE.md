# @fabrika/runner-container

The plain-Bun deploy container. One process accepts one provider-owned job, clones its repository, builds it in the
build sandbox (`bun install`, `fabrika-cloudflare-executor build`), copies the output into a tree of its own, and runs
`fabrika-cloudflare-executor deploy --bundle` on that copy (ADR-0086).

The Worker↔container transport types and paths come from `@fabrika/provider-cloudflare/runner`.
`CloudflareRunnerJob` remains owned and validated by `@fabrika/provider-cloudflare`.

## Commands

```bash
bun run serve
bun test
cpu-lease run -n 4 -- bun run docker:build
bun run docker:smoke    # the real build sandbox: the user switch, /proc, the network namespace, reap, a build
```

## Invariants

- **Every step that runs checkout code runs in the build sandbox** (`src/sandbox.ts`): as `FABRIKA_BUILD_UID` through
  `setpriv` (no groups, no capabilities, no new privileges), with exactly `PATH`, `HOME`, `TMPDIR` and
  `WRANGLER_SEND_METRICS` (`replaceEnv`), owning only the checkout and `<runId>.build`. Only the install and
  `build --fetch-tools` (run outside the checkout) have network; the build gets a network namespace when the container
  allows one, otherwise `FABRIKA_RUNNER_BUILD_NETWORK=auto` builds with network and `isolated` refuses every run. A
  runner that is not root, or cannot switch users, refuses every run. After each sandboxed step `reap` runs `kill -KILL -1` as
  the build user (one pass of the kernel, which a process that keeps forking cannot outrun), then kills what a walk of
  `/proc` still finds until none is left; tini (PID 1 of the image) collects them.
- **The build gets no secret.** It reads `<runId>.build/access.json` and `values.json` (`buildValuesOf`: vars and the
  managed values that are not credentials). The deploy's values and access files are written only after the build's
  processes are gone.
- **The build's output reaches the deploy only through `copyBuildOutput`** (`src/output.ts`): a fresh 0700 tree,
  directories and single-linked regular files with safe names, checked by `lstat` and on the open descriptor, within the
  limits; anything else fails the run with its one line. Never hand the deploy the directory the build wrote.
- **The deploy runs in `<runId>.deploy`**, empty and the runner's, with `TMPDIR` inside it: Bun reads `bunfig.toml`
  and `.env` from its working directory, and `/tmp` is shared with the build user. Source maps are uploaded from the
  copy, never from the checkout.

- Pass credentials and the state namespace through the executor's environment. Pass secrets, vars and managed values
  in `$FABRIKA_DEPLOY_VALUES_FILE` (`<workspace>/<runId>.values.json`, mode 0600, removed after the deploy step), never
  in any child's environment: their names are the application's, and a name such as a runtime's options variable or
  `CLOUDFLARE_API_TOKEN` would steer or re-credential the process that holds the account token.
- Never put secret values on argv or in logs.
- Redact a log line only after it is assembled across chunk boundaries — a pipe read cuts credentials in half.
- Put `--` before the positionals of every `git` invocation; job strings are attacker-controlled.
- Resolve `workerDir` and `configPath` inside the checkout before any spawn; refuse absolute paths and `..`.
- Keep Bun, wrangler and the executor outside `/root` (`/opt/bun`), where the build user can run them and cannot change them.
- The executor reports back through `$FABRIKA_RUNNER_OUTCOME_FILE`, beside the checkout and never inside it.
  Bounded, shape-checked, deleted after reading; a bad one fails the run and its contents never reach a log.
- Reject a second run while one is active.
- Keep `wrangler` available globally in the image.
- Copy every local workspace dependency into the slim Docker workspace.
