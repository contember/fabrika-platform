# specs

Pre-build designs for features big enough to design before building. One file per feature, `kebab-case.md`.

A spec states the problem, the design grounded in the current code, the contract and API changes, the security and
permission impact, how an existing installation converges, the test plan, the slicing into pull requests and the open
questions. It is frozen once accepted: a later change of mind rewrites it before implementation starts, or becomes an ADR
once the feature ships. When its sprint ships, the spec is deleted (default) or moved to `../archive/` if it records
something a future reader needs; the durable _why_ goes to `../decisions/` and the behaviour to `../reference/`.

## Specs

- [Operations tools in the authoring MCP](operations-tools-in-the-authoring-mcp.md) — the authoring agent lists and
  reads issues and health over MCP and resolves an issue in a release.
- [Access diff as a GitHub check](access-diff-as-a-github-check.md) — a pull request shows, as a check run, whether it
  widens an application's approved access.
- [Release watch window and rollback](release-watch-window-and-rollback.md) — each release is scored for a window after
  it ships, and the approval snapshots say whether rolling back is safe.
- [Access simulator](access-simulator.md) — what a principal can reach in an application and why a request was refused,
  from the proxy's own decision code.
- [Review widget on stage and dev](review-widget-on-stage-and-dev.md) — the proxy injects a review widget on stage and
  dev hosts; comments carry the reviewer's identity and the commit, and the agent reads them over MCP.
- [Fleet overview](fleet-overview.md) — owner, last use, framework lag and idle sandboxes per application; a retire
  action comes later.
- [Agent task keys](agent-task-keys.md) — short-lived, budgeted delegation marked as an agent acting for a person.

The order they are built in: [sprint — platform feedback loops](../sprints/sprint-2026-11-02-platform-feedback-loops.md).
