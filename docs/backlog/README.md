# backlog

Decided work items ("issues") not yet scheduled into a sprint. One self-contained
file per item: `NN-<slug>.md` (zero-padded, **folder-local** sequence — don't
renumber, gaps are fine). Copy [`_template.md`](_template.md).

**No `status:` field** — an item is alive because it lives here. It leaves by being
**deleted** on ship (default; git holds the record) or moved to `../archive/` if it
documents something a future reader needs. Dependencies go in frontmatter:
`blocked-by: [./NN-other.md]`.

Add scope sub-folders (`security/`, `perf/`, …) only once the flat list gets
unwieldy; numbers stay folder-local.

## The phase ladder

Items 01–05 are the portability ladder. **Each rung is independently shippable** —
that is the point of the sequencing, not an aspiration. They form a `blocked-by`
chain, so work them in order.

**Phase 0 — merge, rename, green build, no behaviour change
([ADR-0001](../decisions/0001-merge-propustka-and-vozka.md)) — is in flight and is
not filed here.**

> **Gap, flagged rather than invented:** the ladder covers the portability spine
> only. The work implied by
> [ADR-0005](../decisions/0005-compile-app-config-to-static-manifest.md) (the
> `fabrika build` → `fabrika.manifest.json` step) and by
> [ADR-0007](../decisions/0007-proxy-based-auth-enforcement.md) /
> [ADR-0008](../decisions/0008-caddy-forward-auth-proxy.md) (the auth proxy) has
> **no assigned rung**. Item 04 depends on the manifest existing, so at minimum the
> manifest work must land before phase 4. Someone needs to place both explicitly.

## Items

<!-- one line each: NN — short summary (link). Keep it short. -->

- [05](05-bring-up-on-a-real-zerops-account.md) — **Next.** Everything below the account line is built and schema-valid; nothing has run against a real Zerops account.
- [13](13-control-plane-cannot-target-zerops.md) — **Blocker.** The control plane builds no `zerops` target and `app_envs.zerops_project_id` does not exist — the driver has no caller.
- [14](14-wire-edit-time-secret-write-through.md) — `putServiceEnv` exists; nothing calls it, so ADR-0004's write-through has no route.
- [15](15-reconcile-in-flight-runs-at-startup.md) — ADR-0003's crash-safe requirement: poll `/app-version` on boot for runs left pending.
- [16](16-compile-app-config-to-a-manifest.md) — ADR-0005 is unbuilt; the Zerops target is still a function, so the control plane would execute app code.
- [17](17-one-gate-matcher-not-two.md) — The gate matcher is duplicated between the SDK and the proxy — the second implementation ADR-0008 rejected.
- [18](18-shrink-the-app-sdk.md) — Delete in-process enforcement from `@fabrika/auth` now the proxy does it. Keep `redeemKey`.
- [19](19-cancellation-gaps.md) — `reconcileSchema` takes no `AbortSignal`, so the one shared step is the one that cannot be cancelled.
- [20](20-iam-violates-the-config-source-of-truth-invariant.md) — `oblaka.ts` and `fabrika.config.ts` are duplicate graphs that have already drifted.
- [21](21-rate-limit-the-iam-mint-surface.md) — Deferred with reasons; the limit belongs at the proxy, which can identify a client.
- [22](22-unix-second-columns-overflow-in-2038.md) — int4 timestamps; `BIGINT` costs every reader a string. Decide before it is urgent.
- [23](23-cli-template-still-assumes-two-repos.md) — `fabrika init`'s template still checks out `vozka` and `propustka` separately.
- [24](24-runner-image-cannot-resolve-auth-packages.md) — The Docker image installs the auth packages from npm, where they no longer exist.
- [25](25-migrate-the-ci-workflows.md) — No CI at all. Restore deploy, release (OIDC trusted publishing) and the runner image build.
- [26](26-merge-leftovers.md) — Dangling script, orphaned per-package `zerops.yaml`, `.dev.vars` drift, `cf-ray`, partial-config skips.
- [27](27-unpin-the-toolchain.md) — The merge-time pins have served their purpose; both findings behind them are real.
- [06](06-can-zerops-secrets-be-read-back.md) — Open: can secret _values_ be read back from the Zerops API?
- [07](07-rename-env-var-prefixes.md) — Sweep `VOZKA_*` → `FABRIKA_*`; decide whether `PROPUSTKA_*` follows.
- [08](08-distribute-gate-config-to-proxy.md) — Open: how gate config reaches the running auth service (NOT Caddy — see ADR-0010).
- [09](09-confirm-multi-domain-per-service.md) — Open: does Zerops allow multiple custom domains on one service?
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented across separate Zerops projects.
- [11](11-oblaka-rewrites-do-migration-history.md) — oblaka rewrites Durable Object migration history when a class is removed.
- [12](12-ratify-the-proxy-manifest-path.md) — Ratify (or replace) how the proxy gets its manifest on Zerops.
