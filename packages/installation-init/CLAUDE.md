# @fabrika/installation-init

The operator-side mechanics every provider's `fabrika platform init` needs, in one
place: TTY prompts, console formatting, child processes, the `gh` CLI, the GitHub
Environment write, and the sidecar-repository scaffold.

It holds **no provider knowledge and no flow**. Which files a sidecar repository
carries, what its Environment holds, and in which order an operator is asked — all
of that is `@fabrika/installation-{cloudflare,zerops}`'s answer, and the two are
deliberately not mirror images
([ADR-0027](../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)).

Public because both installation packages are, and
`scripts/release.ts validate` forbids a public package depending on a private one.

## Layout

- `prompt.ts` — `text` / `required` / `secret` / `secretOrEnv` / `confirm` / `select` / `retry` on the real TTY.
- `log.ts` — the presentation layer. `step` / `info` / `detail` / `ok` / `warn` / `fail` / `action` / `url`.
- `shell.ts` — `run` / `capture` / `probe` over `Bun.spawn`; argv verbatim, never a shell.
- `gh.ts` — `hasGhCli` / `ghRepoExists`.
- `environment.ts` — create the GitHub Environment, write its secrets over `gh` stdin and its variables.
- `scaffold.ts` — create or refresh a sidecar repository around a provider-supplied `materialize`.

## Invariants

- **NEVER print a secret VALUE.** `log.ts` deliberately has no helper that accepts
  one, so a careless caller cannot route a token through formatting. Secret values
  flow only into `gh` over stdin, a child's env, and whatever file the calling
  package chooses. A provider package that needs an exception (the Cloudflare vault
  KEK is printed once because losing it is unrecoverable) states it in its own
  CLAUDE.md.
- **A thrown error names the command and its exit code, never the child env and
  never the raw error object** — a clone URL can carry an embedded token.
- **Scaffold commits skip CI** (`[skip ci]`), so a push cannot deploy before the
  GitHub Environment exists. `init` dispatches the workflow explicitly, afterwards.
- Keep this package flow-free. A helper that knows which provider is calling it
  belongs in that provider's installation package.
