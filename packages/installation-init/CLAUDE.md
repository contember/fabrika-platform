# @fabrika/installation-init

The operator-side mechanics a provider's platform commands need, in one place: TTY
prompts, console formatting, child processes, the `gh` CLI, the GitHub Environment
write, the sidecar-repository scaffold, and the first-administrator sequence over
IAM's admin RPC.

It holds **no provider knowledge**. Which files a sidecar repository carries, what
its Environment holds, and in which order an operator is asked — all of that is
`@fabrika/installation-{cloudflare,zerops}`'s answer, and the two are deliberately
not mirror images
([ADR-0027](../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)).

Public because both installation packages are, and
`scripts/release.ts validate` forbids a public package depending on a private one.

## Layout

- `prompt.ts` — `text` / `required` / `secret` / `secretOrEnv` / `confirm` / `select` / `retry`. A TTY
  gets a fresh readline per question; a PIPED stdin gets ONE queued reader for the whole command,
  because closing a readline discards what it has already buffered.
- `log.ts` — the presentation layer. `step` / `info` / `detail` / `ok` / `warn` / `fail` / `action` / `url`.
- `shell.ts` — `run` / `capture` / `probe` over `Bun.spawn`; argv verbatim, never a shell.
- `gh.ts` — `hasGhCli` / `ghRepoExists`.
- `github-app-manifest.ts` — the loopback-only GitHub App manifest handshake and strict conversion decoder.
- `environment.ts` — create the GitHub Environment, write its secrets over `gh` stdin and its variables.
- `scaffold.ts` — create or refresh a sidecar repository around a provider-supplied `materialize`.
- `admin.ts` — the first administrator: a typed `/admin/rpc` client over the provisioning key, and
  `ensureFirstAdministrator` — list-or-invite the mailbox, ensure the CROSS-APP `admin` grant, issue one
  enrollment. It returns the URL and never prints it.

## Invariants

- **NEVER print a secret VALUE.** `log.ts` deliberately has no helper that accepts
  one, so a careless caller cannot route a token through formatting. Secret values
  flow only into `gh` over stdin, a child's env, and whatever file the calling
  package chooses. `admin.ts` obeys the same rule from the other side: the enrollment
  URL is a credential in transit, so it is RETURNED to the caller and never logged,
  and no failure message quotes the provisioning key. A provider package that needs
  an exception (the Cloudflare vault KEK is printed once because losing it is
  unrecoverable) states it in its own CLAUDE.md.
- **A thrown error names the command and its exit code, never the child env and
  never the raw error object** — a clone URL can carry an embedded token.
- **Scaffold commits skip CI** (`[skip ci]`), so a push cannot deploy before the
  GitHub Environment exists. `init` dispatches the workflow explicitly, afterwards.
- **A provider-neutral SEQUENCE over a published contract may live here; anything
  naming a provider's own coordinates may not.** `ensureFirstAdministrator` is a
  sequence — which `IamAdminRpcContract` procedures, in which order, and what makes a
  re-run change nothing — and every installation needs the same one, so duplicating it
  per provider would mean two places to get the cross-app grant wrong. What it does NOT
  know is where that IAM answers, which credential reaches it, or how an operator names
  either: `installation-zerops`'s `admin.ts` supplies all three. The line is the
  coordinates, not the call count — a helper that branches on which provider is calling
  it belongs in that provider's package whatever its size.
