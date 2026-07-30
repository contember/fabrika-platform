# @fabrika/installation-cloudflare

The Cloudflare implementation of `@fabrika/installation-contract`.
`fabrika platform init --provider=cloudflare <account>` stands up a Cloudflare
account's Fabrika platform base. Init scaffolds a workflow that deploys IAM,
Operations, then the runner/control pair. The `plan` and `deploy` commands
themselves compose only that final runner/control pair. Assumes the root
CLAUDE.md.

The public executable and command routing live in `@fabrika/cli`. The deploy
engine lives in `@fabrika/engine`.

## Layout

- `installation.ts` — exported `installationCli`: init, plan, and deploy dispatch.
- `index.ts` — module surface consumed by `@fabrika/cli`.
- `init.ts` — the orchestrator: CF token → account/zones → smart-default prompts → vault key → provisioning
  key → GitHub App → scaffold repo → GitHub Environment → trigger.
- `scaffold.ts` — create/refresh `<org>/fabrika-platform` from `templates/` (`platform.yml`, `fabrika.ref`,
  `README.md`, `gitignore`), commit + push. Idempotent.
- `environment.ts` — create the GitHub Environment + write its secrets/vars (`gh secret/variable set --env`).
- `github-app.ts` — the GitHub App manifest flow (PUBLIC when installed cross-org; see below).
- `cloudflare.ts` / `gh.ts` — CF API + `gh` CLI helpers. `prompt.ts` / `log.ts` / `shell.ts` / `envfile.ts`
  / `narrow.ts` — TTY, formatting, child-process, `.env` resume, runtime JSON narrowing.

## Invariants

- **NEVER print a secret VALUE.** `log.ts` has no helper that takes one. The single intentional exception is
  the vault KEK, printed ONCE (the operator must capture it — unrecoverable if lost). Secret values flow only
  into `.env`, `gh` over stdin, and the GitHub Environment.
- **Idempotent + resumable.** Every captured value persists to `.env` (Bun auto-loads it next run); a re-run
  reuses external resources (GitHub App, vault key) instead of orphaning them.
- **App visibility is DERIVED:** public iff any install repo is in a different org than the App's owner org
  (GitHub forbids a private App installing cross-org). Same-org stays private.
- **The provisioning key is a SEEDED `px_` key:** the CLI generates one opaque `px_` bearer
  (`PROPUSTKA_PROVISIONING_KEY`); IAM admits a bearer matching it as a synthetic admin (`resolveCaller`),
  and fabrika reconciles its schema with it. No local IAM mint. Stage 1 deploys IAM from the shared
  `contember/fabrika-platform` checkout and needs its OIDC and signing config in the Environment.
- **Operations deploys between IAM and control.** Init records
  `OPERATIONS_HOSTNAME`, creates `OPERATIONS_SYNC_KEY`, and supplies the public
  IAM issuer. The Operations hostname exposes only ingest and source-map upload;
  control reaches catalog and operator surfaces through a private service
  binding.
- **`@fabrika/engine` owns plan execution.** `platform init` triggers the scaffolded GitHub Actions
  pipeline; it does not deploy from the laptop. `platform plan` and `platform deploy` execute the
  provider-owned runner and control configs and remain distinct from app deployment.
- **This package relaxes exactly `noUncheckedIndexedAccess` and
  `noPropertyAccessFromIndexSignature`** because it imports `oblaka-iac` through
  the Cloudflare provider. Never widen that relaxation or use casts to work
  around the dependency.
