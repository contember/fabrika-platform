---
id: 05
title: Bring the platform up on a real Zerops account
blocked-by: []
---

# 05 — Bring the platform up on a real Zerops account

Everything below the account line is built: the Postgres/Bun implementations, the
Zerops driver and control path, the static app manifest, the proxy, the topology
in [`packages/installation-zerops/zerops/`](../../packages/installation-zerops/zerops/),
and an example app. All of it
validates against Zerops' **published JSON schemas** and the driver is proven in
dry-run.

**None of it has ever touched a real account.** Well-formed is not deployable. This
item is the gap, and it can only be closed by someone with credentials.

## The hand steps

1. **Import the two provisioning documents**
   (`packages/installation-zerops/zerops/generated/*.provision.*`)
   via `POST /client/{id}/project/import`. Use the `startWithoutCode` form first —
   that is the ADR-0004 bring-up order: import without code → write secrets through
   the env API → deploy.
   **`envIsolation` is settable at creation only.** A project created without it can
   never be corrected, and with `envIsolation: none` every service sees every other
   service's variables. Get this right on the first import or delete the project.
2. **Bind custom domains** to each project's L7 balancer, proxy service only. Not
   expressible in the import format, so it is manual by construction.
   `enableSubdomainAccess` is documented as "not suitable for production".
3. **Write every service-level variable and secret** through the env API. The
   authoritative lists are in
   `packages/installation-zerops/zerops/setups.ts` per setup. In particular:
   - IAM receives its public issuer, signing keys, OIDC coordinates, provisioning
     key, RPC key, and proxy key.
   - Operations receives `FABRIKA_OPERATIONS_PUBLIC_HOST`, the public
     `FABRIKA_IAM_URL`, `OPERATIONS_SYNC_KEY`, and `FABRIKA_IAM_RPC_KEY`.
   - Control receives its public origins, including
     `OPERATIONS_ARTIFACT_ORIGIN`, plus the vault KEK, GitHub App credentials,
     provider credentials, `OPERATIONS_SYNC_KEY`, and `FABRIKA_IAM_RPC_KEY`.
   - The proxy receives `FABRIKA_IAM_URL`, `FABRIKA_IAM_KEY`, and a manifest that
     exposes only the configured Operations ingest and source-map routes for the
     Operations hostname.
     Never write these at project level.
     Use only the canonical `FABRIKA_*` names when provisioning a new account.
     Runtime readers retain canonical-first compatibility for the deprecated
     `PROPUSTKA_*` and `VOZKA_*` names under
     [ADR-0018](../decisions/0018-canonical-fabrika-environment-names.md), but that
     fallback is for adopting existing configuration and is not an authoring
     surface.
4. **Connect the GitHub/GitLab integration per service.** `buildFromGit` is
   public-repo only, so the topology deliberately leaves it unset.
5. **Trigger the first build per service**, then re-apply the steady-state documents.
6. **Confirm the proxy build sees service-level variables.** The control plane
   writes `FABRIKA_PROXY_MANIFEST_JSON` to the proxy service and triggers its
   pipeline. Verify that the build container receives the value and that an empty
   manifest remains fail-closed.
7. **Verify the Operations boundary on the bound domain.** The public hostname
   must accept only source-bound envelope ingest and authenticated source-map
   upload. `/api/*`, `/private/*`, and `/healthz` must remain unreachable through
   the proxy. Control must reach the private operator API and catalog/release
   sync endpoint over `http://operations:3000`.

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

The platform project boots; IAM and Operations answer on their internal
hostnames; the proxy is reachable on custom IAM, control, and Operations
domains; public Operations routing exposes only its data-plane paths; and one
deploy of the example app completes through the control plane with its logs
relayed into the run record. The deployed app receives
`FABRIKA_OPERATIONS_DSN` and `FABRIKA_RELEASE`, and an ingested exception reaches
the private operator API without exposing it publicly. Then fold what you learned back into
[`../reference/zerops-platform.md`](../reference/zerops-platform.md) and delete this
file.
