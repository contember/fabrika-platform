---
id: 26
title: Leftovers from the merge and the Zerops topology
blocked-by: []
---

# 26 — Leftovers from the merge and the Zerops topology

Small, individually trivial, collectively the kind of thing that rots. Grouped
deliberately rather than filed as six items.

- **Dangling provision script.** `examples/app`'s `provision-schema` npm script
  points at `../../scripts/provision-schemas.ts`, a root-level script that was never
  migrated. Two `README.md` links point at it too.
- **Orphaned per-package `zerops.yaml`.** `packages/iam/zerops.yaml` and
  `packages/proxy/zerops.yaml` are superseded — Zerops reads the file from the
  **repository root**, and their content now lives in `deploy/zerops/setups.ts`.
  They were left in place rather than deleted by an agent working outside its scope.
  Their two recorded schema deviations must survive the deletion: `protocol: TCP` is
  rejected by the published schema (whose enum is lowercase `tcp`/`udp` while its own
  description and every doc example say `TCP` — the schema contradicts itself), and
  `base: [go@1.23, bun@1.2]` matches no build base, because bases are OS-qualified.
- **`.dev.vars` drift.** In `packages/iam`, `.dev.vars.example` documents
  `PROPUSTKA_SIGNING_KEYS` + `OIDC_CLIENT_SECRET` while the actual `.dev.vars`
  contains `CF_API_TOKEN` + `CF_ACCOUNT_ID`. Following the example's own "copy this"
  instruction produces a different file than the one in the repo.
- **Correlation ids on Bun.** `iam/src/admin/router.ts` and `auth/routes.ts` read
  `cf-ray`, falling back to `crypto.randomUUID()`. Functional off Cloudflare, but the
  id correlates with nothing upstream. If the proxy is to propagate a request id,
  this is where it lands.
- **Partial backing-service config fails instead of skipping.** The skip guards key
  on a subset of the `FABRIKA_TEST_S3_*` variables, so an environment with some but
  not all of them set produces failures rather than skips. Misleading when it
  happens, which is exactly when you are least able to interpret it.
