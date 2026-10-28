---
id: 0004
title: App secret values live in the target platform, or in the vault where it has none
status: accepted
date: 2026-07-28
---

# 0004 — App secret values live in the target platform, or in the vault where it has none

## Context

Today fabrika has a `SecretResolver`: given a reference, fetch the value, so the
deploy can **push** it to the target. That is a _read_ seam, and its whole purpose
is transport — get the value from wherever it lives to wherever the app will read
it.

On Zerops the value is **already at the target**. Environment variables — project
level, service level, and secret variants — are a first-class platform feature, and
secret and project variables can change **without a redeploy**
([import reference](https://docs.zerops.io/references/import),
[env variables](https://docs.zerops.io/nodejs/how-to/env-variables)). There is
nothing to transport. The `sync-secrets` step simply has no work to do there.

Cloudflare has no equivalent the client edits by hand: a Worker secret is written
by `wrangler secret put` at deploy time, so there the value has to come from
somewhere fabrika controls.

The decisive fact is operational, not architectural: **the client has Zerops GUI
access.** They can and will edit a secret there. Any copy fabrika keeps drifts by
construction. The question is not "can we detect drift" but "can we avoid having
something to drift".

## Decision

On Zerops we treat the **platform** as the system of record for secret values, and
store only **references** in fabrika. The Zerops adapter is a thin wrapper over the Zerops
environment-variable API, with **no local copy**.

On Cloudflare the built-in vault holds app secret values: the only app-secret
reference fabrika stores there is a `vault:` ref, minted when a value is written,
and the deploy resolves it into the Worker's secrets.

Either way an app secret enters fabrika as a **value** — no API accepts a
reference — and the installation's provider decides where it lands:
provider-managed storage on Zerops, the vault otherwise. A `dev` environment on Zerops counts as "otherwise": it runs
in Box sandboxes, which have no service variables, so its values are kept in the vault and handed to a sandbox at deploy
([ADR-0049](0049-author-applications-through-mcp-in-control.md) rule 10).

**Invariant: fabrika never writes an app secret to project-level env on Zerops.**
Project-level variables are injected into _every_ service in the project
([import reference](https://docs.zerops.io/references/import)), and one project
holds many apps — a project-level write would hand app A's credentials to app B.
**Service-level only.** No exceptions, no "just this one shared value".

## Consequences

Benefits:

- **Drift becomes impossible rather than merely detectable.** There is no second
  copy to disagree with the first.
- **No KEK to lose.** The vault's own documentation says key loss is unrecoverable
  by design; not being on that path is worth something.
- Secrets stay out of the control plane's database dump — though that was already
  true with the vault, so it is a secondary argument, not the reason.

Costs, stated plainly:

- **No secret can be set before the Zerops service exists.** The env API is
  addressed by service. Registration must therefore _provision_ — "register the app,
  set its secrets, then deploy" stops being a valid order.
- **GUI edits fall outside fabrika's audit log.** A client changing a secret in the
  Zerops GUI leaves no trace in fabrika. For an IAM-and-audit product, that is a
  real hole, consciously accepted.
- **The `app` / `app-env` scope model does not map 1:1 onto project/service level.**
  An `app`-scoped secret (shared across environments) has no natural home when the
  invariant above forbids project level — see
  [`../backlog/10-app-scope-secrets-on-zerops.md`](../backlog/10-app-scope-secrets-on-zerops.md).
  Current thinking: replicate it per service regardless of topology.
- **No rotation history.** The platform stores a current value, not a timeline.
- **On Cloudflare the vault's costs remain** — a KEK whose loss is unrecoverable,
  and a copy of every app secret in the control plane's database (encrypted).
- Whether values can be **read back** from the Zerops API is unknown and changes
  the dashboard UX. _(Answered 2026-08-03: yes — a write-capable token reads the
  plaintext back in `content`. See
  [`../reference/zerops-platform.md`](../reference/zerops-platform.md#verified-live-2026-08-03-account-prg1);
  the consequence for the dashboard UX is still open.)_

## Alternatives considered

- **Keep the vault as the system of record and push values to Zerops on deploy.**
  Rejected: the client has GUI access, so fabrika's copy and the platform's copy
  diverge the first time anyone touches the GUI — and fabrika would then
  "correct" the client's change on the next deploy, silently. Worse, this
  reintroduces a KEK whose loss is unrecoverable, to protect values the platform is
  already storing.
- **Vault as system of record, GUI edits treated as drift and reported.** Rejected:
  it keeps all the costs (KEK, transport, two copies) and buys only _detection_ of
  a problem that the chosen design does not have.
- **Platform of record, plus a cached copy in fabrika for display.** Rejected: a
  cache of a secret is a copy of a secret. It re-creates the drift surface and the
  exfiltration surface to improve a dashboard.
- **Do nothing platform-specific — keep pushing env vars from the vault on
  Cloudflare and mirror that on Zerops.** Rejected for Zerops by the drift argument
  above; kept for Cloudflare, where nobody edits the value outside fabrika.
- **Cloudflare Secrets Store as the Cloudflare system of record.** Rejected: it
  changes every app's code (`env.X` becomes `await env.X.get()`), and fabrika never
  wired a binding for it, so the vault already covers the case.
- **Accept caller-supplied references (`env:`, `literal:`).** Rejected: an `env:`
  ref names a control-plane variable that is never set for an app, so it cannot
  deploy, and a `literal:` ref stores the plaintext in the registry row.
