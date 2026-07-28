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
- [`decisions/`](decisions/README.md) — ADRs (the _why_), immutable.
- [`backlog/`](backlog/README.md) — decided work, not yet scheduled.
- [`sprints/`](sprints/README.md) — active thematic work-plans.
- [`archive/`](archive/README.md) — shipped sprints + reference-worthy records.

## Active sprints

<!-- list the sprint files currently in sprints/ ; empty between sprints -->

- _none active_

## What's hot

<!-- hand-maintained, keep short: the few things actually in motion + what's next.
     If everything is "hot", nothing is. -->

- **Phase 0 — the merge itself**: importing propustka + vozka into `packages/`,
  renaming everything to `@fabrika/*`, green build, no behaviour change
  ([ADR-0001](decisions/0001-merge-propustka-and-vozka.md)).
- The phase ladder (ports → Postgres/Bun → driver seam → Zerops driver) has since
  shipped; those backlog items were deleted on ship, per this folder's own rule.
- Next rung:
  [`backlog/05-bring-up-on-a-real-zerops-account.md`](backlog/05-bring-up-on-a-real-zerops-account.md)
  — everything below the account line is built and schema-valid, but **nothing has
  ever run against a real Zerops account**.
