# fabrika-platform docs — index

The map of everything under `docs/`. Read [`CLAUDE.md`](CLAUDE.md) for the rules.
When sources disagree, precedence is: invariants/hard-rules → active sprint →
decisions → reference → archive.

**New here?** Start with [`reference/overview.md`](reference/overview.md) — what
fabrika-platform is and how the pieces fit — then skim
[`decisions/README.md`](decisions/README.md) for the _why_.

For editing an application from Claude or ChatGPT through MCP, see [MCP authoring](reference/mcp-authoring.md).

## Folders

- [`reference/`](reference/README.md) — how the system works now.
- [`ideas/`](ideas/README.md) — proposals, no commitment.
- [`decisions/`](decisions/README.md) — ADRs (the _why_), living until 1.0.
- [`backlog/`](backlog/README.md) — decided work, not yet scheduled.
- [`sprints/`](sprints/README.md) — active thematic work-plans.
- [`archive/`](archive/README.md) — shipped sprints + reference-worthy records.

## Active sprints

[MCP application authoring](sprints/sprint-2026-10-07-mcp-authoring.md) is active: MCP in Control, IAM OAuth for Claude/ChatGPT, Git workspaces, stage deploys and pull requests on Zerops ([ADR-0049](decisions/0049-author-applications-through-mcp-in-control.md)).

The application framework plan shipped and its idea documents were deleted; the contract is
[ADR-0012](decisions/0012-fabrika-app-runtime.md) and [`reference/application-runtime.md`](reference/application-runtime.md). Its sprints: [M0](archive/sprint-2026-10-08-m0-current-holes.md) (shipped), [A-M1](archive/sprint-2026-10-08-a-m1-framework-core.md) (shipped), [A-M2](archive/sprint-2026-10-08-a-m2-data.md) (shipped), [A-M3](archive/sprint-2026-10-08-a-m3-multi-tenant.md) (shipped), [B-M1](archive/sprint-2026-10-08-b-m1-binding-contract.md) (shipped), [B-M2](archive/sprint-2026-10-09-b-m2-locked-providers.md) (shipped), [A-M4](archive/sprint-2026-10-09-a-m4-companions.md) (shipped), [B-M3](archive/sprint-2026-10-09-b-m3-workloads-and-platform.md) (shipped).

The [local-hardening port](archive/sprint-2026-10-08-local-hardening-port.md) shipped on 2026-10-08.
The [second simplification pass](archive/sprint-2026-10-08-second-simplification-pass.md)
shipped on 2026-10-08.

## What's hot

<!-- hand-maintained, keep short: the few things actually in motion + what's next.
     If everything is "hot", nothing is. -->

- **Live test installations must be reinstalled.** Migrations are squashed to one initial file per
  bundle ([ADR-0017](decisions/0017-service-owned-postgres-migrations.md)) and both clouds use
  vault-backed GitHub connections ([ADR-0029](decisions/0029-github-app-sources.md)).
- **Auth has one enforcement point.** The proxy makes the only enforcement decision, from an endpoint table
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
