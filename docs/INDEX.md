# fabrika-platform docs — index

The map of everything under `docs/`. Read [`CLAUDE.md`](CLAUDE.md) for the rules.
When sources disagree, precedence is: invariants/hard-rules → active sprint →
decisions → reference → archive.

**New here?** Start with [`reference/overview.md`](reference/overview.md) — what
fabrika-platform is and how the pieces fit — then skim
[`decisions/README.md`](decisions/README.md) for the _why_.

## Folders

- [`reference/`](reference/README.md) — how the system works now.
- [`ideas/`](ideas/README.md) — proposals, no commitment.
- [`decisions/`](decisions/README.md) — ADRs (the _why_), living until 1.0.
- [`backlog/`](backlog/README.md) — decided work, not yet scheduled.
- [`sprints/`](sprints/README.md) — active thematic work-plans.
- [`archive/`](archive/README.md) — shipped sprints + reference-worthy records.

## Active sprints

- [Second simplification pass](sprints/sprint-2026-10-08-second-simplification-pass.md) — fixes
  vault-only secrets, the builder's unchecked PID signal, Operations telemetry health and phantom
  builder skills, then removes dead API, duplicate models and single-consumer packages, and squashes
  migrations.

## What's hot

<!-- hand-maintained, keep short: the few things actually in motion + what's next.
     If everything is "hot", nothing is. -->

- **Auth has one enforcement point.** The proxy runs the only gate evaluator
  ([ADR-0022](decisions/0022-the-proxy-is-the-only-enforcement-point.md)); a browser gets an app
  session only through the one-time handoff
  ([ADR-0023](decisions/0023-one-session-per-host.md),
  [`reference/cross-host-sso.md`](reference/cross-host-sso.md)).
- **Zerops builds only uploaded, pinned sources.** Control streams an application's exact commit
  through the operator's GitHub App ([ADR-0029](decisions/0029-github-app-sources.md)); installation
  commands upload one `--source-dir` snapshot, and each namespace pins its proxy commit
  ([ADR-0045](decisions/0045-upload-immutable-platform-and-namespace-proxy-sources.md)). How it works:
  [`reference/installing-on-zerops.md`](reference/installing-on-zerops.md) and
  [`reference/provider-bundles.md`](reference/provider-bundles.md).
- **A production Zerops release still needs three items:** automatic build source maps
  ([36](backlog/36-complete-zerops-release-artifact-correlation.md)), DNS-safe Operations egress for
  webhooks ([38](backlog/38-add-dns-safe-operations-egress.md)), and the production topology plus a
  full release rehearsal ([05](backlog/05-bring-up-on-a-real-zerops-account.md)).
- **Releases are tokenless.** `release.yml` publishes every public `@fabrika` package through npm
  trusted publishing with provenance ([`reference/release-process.md`](reference/release-process.md)).
- **Domain audit delivery is best-effort.** `IamRpc.audit` returns before the IAM write is durable;
  durable delivery is [71](backlog/71-deliver-domain-audit-events-durably.md).
