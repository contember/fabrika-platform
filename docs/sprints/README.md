# sprints

Active thematic work-plans being executed **now**. One file per sprint:
`sprint-YYYY-MM-DD-<theme>.md` (copy [`_template.md`](_template.md)). Multiple may
be active at once.

A sprint is the unit of work. Running it unattended ("do everything autonomously")
is just a sprint with no human watching — same file, same rules.

Lifecycle (full detail in [`../CLAUDE.md`](../CLAUDE.md)):

1. **Create** — copy the template; re-verify load-bearing facts at HEAD before
   planning on them.
2. **Run** — work the WUs; append discoveries/blockers to `## Run log`; graduate
   entries to a `../decisions/` ADR or a `../backlog/` item.
3. **Close** — stamp the `OUTCOME` header, `git mv` to `../archive/`, delete/rescope
   consumed backlog items, refresh affected `../reference/`, update
   [`../INDEX.md`](../INDEX.md).

## Active

- [`sprint-2026-08-14-multiple-private-github-source-connections`](sprint-2026-08-14-multiple-private-github-source-connections.md)
  — extend the live Zerops source path from one installation-wide GitHub App to one private App per
  organization. The additive design keeps the existing Zerops v1 credential and generic webhook route,
  gives every new connection a create-only keyed v2 credential and scoped webhook, and binds app
  registry entries on the Zerops private-source path to connection plus installation. Cloudflare keeps
  its static-secret and installation-id webhook behavior. There is no explicit connection-count limit.
  Local compatibility gates and live Zerops restart plus second-organization deployment witnesses remain open
  ([ADR-0032](../decisions/0032-support-multiple-private-github-source-connections.md)).

- [`sprint-2026-08-11-fabrika-deploys-an-app-on-zerops`](sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md)
  — one gate: add a GitHub repository, **public or private**, and get it deployed into the Zerops
  account. Consumes [`47`](../backlog/47-give-the-zerops-path-a-private-git-source.md),
  [`69`](../backlog/69-a-zerops-runs-log-never-reaches-the-run-record.md) and
  [`70`](../backlog/70-a-failed-zerops-build-hangs-await-deploy-for-seventy-minutes.md). A live probe
  proved Zerops' GUI OAuth grant is unavailable to the control plane's integration token. The private
  half now uses an operator-owned GitHub App and a per-installation `source` service that uploads an
  exact repository snapshot for Zerops to build ([ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md)).
  Fresh installations now leave source anonymous. Normal organization-owned App creation, encrypted
  recovery, source activation, webhook configuration, legacy credential adoption and installation
  verification run behind the authenticated Control console
  ([ADR-0031](../decisions/0031-manage-zerops-github-source-from-control.md)); ADR-0030 remains the
  legacy CLI recovery record. The service, upload lifecycle, Control workflow, dashboard and narrow
  CLI repair path are locally implemented. The complete live browser flow, public and private live
  deploys, and WU5 remain open.
