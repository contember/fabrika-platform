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

- [01](01-phase-1-platform-ports.md) — Phase 1: extract platform ports, CF impls only; retire the `DeployLock` Durable Object.
- [02](02-phase-2-node-bun-and-postgres.md) — Phase 2: Node/Bun entrypoints + Postgres; **port the test harness first**.
- [03](03-phase-3-deploy-driver.md) — Phase 3: introduce `DeployDriver`, move plan derivation into the CF driver, behaviour unchanged.
- [04](04-phase-4-zerops-driver.md) — Phase 4: the Zerops driver (pure HTTP, no runner).
- [05](05-phase-5-self-host-on-zerops.md) — Phase 5: self-host fabrika on Zerops.
- [06](06-can-zerops-secrets-be-read-back.md) — Open: can secret _values_ be read back from the Zerops API?
- [07](07-rename-env-var-prefixes.md) — Sweep `VOZKA_*` → `FABRIKA_*`; decide whether `PROPUSTKA_*` follows.
- [08](08-distribute-gate-config-to-proxy.md) — Open: distribute gate config to Caddy via admin API or redeploy (start with redeploy).
- [09](09-confirm-multi-domain-per-service.md) — Open: does Zerops allow multiple custom domains on one service?
- [10](10-app-scope-secrets-on-zerops.md) — Open: how the `app` secret scope is represented when environments are separate Zerops projects.
