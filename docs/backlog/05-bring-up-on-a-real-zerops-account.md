---
id: 05
title: Bring the platform up on a real Zerops account
blocked-by: []
---

# 05 — Bring the platform up on a real Zerops account

Everything below the account line is built: the Postgres/Bun implementations, the
Zerops driver and control path, the static app manifest, the proxy, the topology
in [`deploy/zerops/`](../../deploy/zerops/), and an example app. All of it
validates against Zerops' **published JSON schemas** and the driver is proven in
dry-run.

**None of it has ever touched a real account.** Well-formed is not deployable. This
item is the gap, and it can only be closed by someone with credentials.

## The hand steps

1. **Import the two provisioning documents** (`deploy/zerops/generated/*.provision.*`)
   via `POST /client/{id}/project/import`. Use the `startWithoutCode` form first —
   that is the ADR-0004 bring-up order: import without code → write secrets through
   the env API → deploy.
   **`envIsolation` is settable at creation only.** A project created without it can
   never be corrected, and with `envIsolation: none` every service sees every other
   service's variables. Get this right on the first import or delete the project.
2. **Bind custom domains** to each project's L7 balancer, proxy service only. Not
   expressible in the import format, so it is manual by construction.
   `enableSubdomainAccess` is documented as "not suitable for production".
3. **Write every service-level variable and secret** through the env API. The lists
   are in `deploy/zerops/setups.ts` per setup: IAM's `ISSUER`, signing keys, OIDC
   coordinates and its two shared keys; the control plane's vault KEK, GitHub App,
   Cloudflare token and Zerops PAT; the proxy's `FABRIKA_IAM_URL` and
   `FABRIKA_IAM_KEY`. Never at project level.
4. **Connect the GitHub/GitLab integration per service.** `buildFromGit` is
   public-repo only, so the topology deliberately leaves it unset.
5. **Trigger the first build per service**, then re-apply the steady-state documents.
6. **Confirm the proxy build sees service-level variables.** The control plane
   writes `FABRIKA_PROXY_MANIFEST_JSON` to the proxy service and triggers its
   pipeline. Verify that the build container receives the value and that an empty
   manifest remains fail-closed.

## The four behaviours to verify while you are in there

Shapes are read off Zerops' live OpenAPI document, so they are not guesses. These
four are **semantics** the documentation does not state, and the first is the one
that matters:

1. **Is re-applying an unchanged import with `override: true` a no-op, or does it
   redeploy?** ADR-0003's entire idempotency claim rests on the former, and the
   documentation describes it in three words: "Override existing service."
2. `POST /service-stack/{id}/user-data` with an existing key — replace, or 409? The
   client lists-then-POST-or-PUT, so it is correct either way, but knowing costs a
   round trip today.
3. `GET /service-stack/{id}/app-version` list order. The client picks max `sequence`
   rather than trusting order; confirm `sequence` really is monotonic.
4. Does `OutDtoUserData.content` return a real value for a `SECRET` record, or a
   blurred placeholder? This is [`06`](./06-can-zerops-secrets-be-read-back.md)
   verbatim, and it decides whether the dashboard can show a secret at all.

Also unverified and worth a glance: that `${storage_*}` and `${db_connectionString}`
resolve under `envIsolation: service`, that a **build** container can see
service-level variables (the proxy manifest depends on it), and that
`alpine/go@latest` still builds Caddy 2.10.2.

## Acceptance

The platform project boots, IAM answers on its internal hostname, the proxy is
reachable on a custom domain and denies an unauthenticated request to a gated path,
and one deploy of the example app completes through the control plane with its logs
relayed into the run record. Then fold what you learned back into
[`../reference/zerops-platform.md`](../reference/zerops-platform.md) and delete this
file.
