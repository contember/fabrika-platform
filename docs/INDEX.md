# fabrika-platform docs — index

The map of everything under `docs/`. Read [`CLAUDE.md`](CLAUDE.md) for the rules.
When sources disagree, precedence is: invariants/hard-rules → active sprint →
decisions → reference → archive.

**New here?** Start with [`reference/overview.md`](reference/overview.md) — what
fabrika-platform is and how the pieces fit — then skim
[`decisions/README.md`](decisions/README.md) for the _why_. For the current error
ingest, grouping, triage, and alert workflows, read
[`reference/operations-errors.md`](reference/operations-errors.md).

## Folders

- [`reference/`](reference/README.md) — how the system works now.
- [`ideas/`](ideas/README.md) — proposals, no commitment.
- [`decisions/`](decisions/README.md) — ADRs (the _why_), immutable.
- [`backlog/`](backlog/README.md) — decided work, not yet scheduled.
- [`sprints/`](sprints/README.md) — active thematic work-plans.
- [`archive/`](archive/README.md) — shipped sprints + reference-worthy records.

## Active sprints

No active sprint.

## What's hot

<!-- hand-maintained, keep short: the few things actually in motion + what's next.
     If everything is "hot", nothing is. -->

- **Auth follow-up:** implement the accepted
  [Cloudflare proxy enforcement path](backlog/47-implement-cloudflare-proxy-enforcement.md), then
  [shrink the app SDK](backlog/18-shrink-the-app-sdk.md).
- **Release activation:** run hosted CI, bootstrap the nineteen npm packages, and prove the tokenless release path in
  [`backlog/25-bootstrap-npm-trusted-publishing.md`](backlog/25-bootstrap-npm-trusted-publishing.md).
- **External next:** run the resulting composition against a real account in
  [`backlog/05-bring-up-on-a-real-zerops-account.md`](backlog/05-bring-up-on-a-real-zerops-account.md).
  Fix [`39`](backlog/39-settle-zerops-override-semantics.md) and
  [`41`](backlog/41-write-service-variables-without-a-pre-read.md) first — one decides
  whether re-apply reconciles or redeploys, the other blocks bring-up's secret-writing step.
- **Operations follow-up:** complete
  [Zerops release artifact correlation](backlog/36-complete-zerops-release-artifact-correlation.md),
  settle [managed-environment activation](backlog/37-activate-zerops-managed-environment-transactionally.md),
  add [DNS-safe Operations egress](backlog/38-add-dns-safe-operations-egress.md),
  and choose a [portable email transport](backlog/46-add-portable-email-alert-delivery.md).
  The [broad target](ideas/operations-plane.md) and credentialed
  [Poplach cutover](backlog/34-retire-standalone-poplach.md) remain separate.
