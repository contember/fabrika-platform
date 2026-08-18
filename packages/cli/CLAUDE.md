# @fabrika/cli

The single public `fabrika` executable. It parses the top-level `platform`,
`app`, `namespace`, and `control` command areas, resolves one provider where a
command has one, then delegates to an installation or provider package. It
contains no provider implementation.

## The `control` area

`src/control.ts` is the operator's non-browser client for the Delivery control
plane ([ADR-0033](../../docs/decisions/0033-operate-the-control-plane-from-the-cli.md)).
It is the ONE area that resolves no provider and loads no installation package,
because the control API is provider-neutral. `--provider` reaches it only to
label the envelope a registration carries.

- It adds no server surface: every verb is one procedure of `ControlRpcContract`,
  called through the same `createRpcClient` the console uses. A procedure is
  reachable from both clients or neither.
- Output contract, as in `zops`: stdout carries DATA ONLY, progress and errors go
  to stderr, `--json` prints the result verbatim.
- Credentials come from the ENVIRONMENT ONLY and have no flag, so they cannot
  reach a CI log or a process listing. The origin is not a credential and takes both.
- `control key issue` is the bootstrap: a fresh installation's provisioning key is
  held in env and never in the DB, so the proxy — which resolves bearers through
  IAM's `mintFromKey` — cannot admit it. The command mints a DB-backed key instead.
- **Do not add source-connection verbs.** Creating a GitHub App connection needs a
  human principal (ADR-0031); the console owns it.

## Provider selection

- App commands first use `--provider`, then inspect the default-exported
  provider-authored `fabrika.config.ts`.
- `authoredAppProvider()` reads the provider identity attached by that
  provider's `defineApp()`.
- Platform commands use the same resolver. Pass `--provider` when the working
  directory has no provider-authored app config.
- `cloudflare` and `zerops` are built-in installation aliases. Any other value is
  loaded as a package specifier implementing `@fabrika/installation-contract`.

## Invariants

- Keep `fabrika` as the only public operator executable.
- Do not add provider-specific public executables.
- `fabrika-cloudflare-executor` is internal to the runner container.
- Keep command routing thin. Provider behavior belongs in the provider or
  installation package.
- **How WIDE a platform command is, is the provider's answer, not this package's**
  ([ADR-0027](../../docs/decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)).
  Zerops' `platform deploy` owns a whole ordered sequence; Cloudflare's composes
  one runner/control pair and the scaffolded workflow keeps the order. `--help` on
  a platform command therefore prints the INSTALLATION's usage — that text is the
  provider's real surface, and on Zerops it is what an operator's workflow is
  generated from.
- Do not add a closed provider union to a shared contract.
