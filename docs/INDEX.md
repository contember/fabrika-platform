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

- [Auth boundary cleanup (2026-07-31)](sprints/sprint-2026-07-31-auth-boundary-cleanup.md) — retire the duplicate in-process auth front door and close schema-reconcile cancellation.

## What's hot

<!-- hand-maintained, keep short: the few things actually in motion + what's next.
     If everything is "hot", nothing is. -->

- **In motion:** retire duplicate in-process gate enforcement and close schema-reconcile cancellation in the
  [auth boundary cleanup sprint](sprints/sprint-2026-07-31-auth-boundary-cleanup.md).
- **Release activation:** run hosted CI, bootstrap the nineteen npm packages, and prove the tokenless release path in
  [`backlog/25-bootstrap-npm-trusted-publishing.md`](backlog/25-bootstrap-npm-trusted-publishing.md).
- **External next:** run the resulting composition against a real account in
  [`backlog/05-bring-up-on-a-real-zerops-account.md`](backlog/05-bring-up-on-a-real-zerops-account.md).
- **Operations follow-up:** complete
  [Zerops release artifact correlation](backlog/36-complete-zerops-release-artifact-correlation.md),
  settle [managed-environment activation](backlog/37-activate-zerops-managed-environment-transactionally.md),
  and add [DNS-safe Operations egress](backlog/38-add-dns-safe-operations-egress.md).
  The [broad target](ideas/operations-plane.md) and credentialed
  [Poplach cutover](backlog/34-retire-standalone-poplach.md) remain separate.
