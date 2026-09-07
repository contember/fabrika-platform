---
id: app-deploy
kind: pattern
title: Direct app deploy — push-to-branch → oblaka → wrangler (Cloudflare)
slot: null
provides: [ci-deploy, cf-deploy, infra-provisioning]
requires: [cloudflare, oblaka, wrangler]
recommends: []
conflicts: [vozka-app-deploy]
status: stable
sources:
  - where: "opice — .github/workflows/deploy.yml (the canonical app-deploy workflow)"
    read: "The branch triggers, oblaka --remote provisioning, D1 migrate, and wrangler deploy steps."
  - where: "oblaka — README / CLAUDE.md (the `bunx oblaka <file> --remote --env=…` deploy story)"
    read: "How oblaka provisions bindings + emits wrangler.jsonc, idempotently, keyed by a state namespace."
---

# App deploy (Cloudflare)

## What it is

A Cloudflare app deploys via **GitHub Actions on a branch push**: `main` → **stage**,
`deploy/prod` (or `prod`) → **production**, plus `workflow_dispatch` for manual runs.
The job runs **`bunx oblaka oblaka.ts --remote --env=<stage|prod>`** to provision
bindings (D1/KV/R2/DO/AE) via the CF API and emit `wrangler.jsonc`, then
**`wrangler d1 migrations apply DB --remote`**, then **`wrangler deploy`**. Auth is
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets; the GitHub `environment` is
chosen from the branch, with a concurrency lock per environment.

This is the **direct per-repository alternative** for accounts/apps not managed by
Vozka. Do not scaffold it alongside `vozka-app-deploy`.

## When & why to use

- A Cloudflare app whose target account is **not** managed by Vozka — deploy is a
  git push to the env branch, with infra-as-code and no dashboard clicking.
- Prefer `vozka-app-deploy` when the target account already has Vozka + Propustka.

## When NOT to use

- Non-CF deploy targets (a Node/Postgres backend like `contember` deploys differently — container/VPS, not wrangler).

## Gotchas

- **oblaka is idempotent via a state namespace** — it tracks resource IDs across runs; don't hand-create the same resources or you'll drift.
- **Migrations run at deploy time** (`--remote`), not before — a failed migration fails the deploy; keep them idempotent.
- **Per-env from the branch** — `main`→stage, `deploy/prod`→prod; the GitHub `environment` gates secrets + serializes concurrent deploys.
- Never hand-edit the generated `wrangler.jsonc` — change `oblaka.ts`.
- Never run this workflow and Vozka against the same target during normal
  operation; their locks do not coordinate.

## Relationships — why

- **requires `cloudflare` + `oblaka` + `wrangler`** — it's exactly the oblaka→wrangler.jsonc→wrangler-deploy chain on CF. Pairs with `lib-publish` (the other half of CI) in a monorepo.
- **conflicts `vozka-app-deploy`** — one app/environment must have one deploy owner.
