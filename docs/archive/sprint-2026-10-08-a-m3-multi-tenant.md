> **OUTCOME — shipped 2026-10-09.** Multi-tenant applications: IAM membership, invitations, delegation grants and
> share links (A12), and in the framework members, share links, forms, the anonymous caller kinds and GitHub webhooks
> (A13). Commit map: A12 → `925e5850`…`83f43c6c`, A13 → `82a7a89d`…`98289736`. Each had an independent review and
> one fix round. Verification: full `bun run test` with Postgres and S3 at the A13 merge (5720 pass, 38 skip — live
> Zerops only, 0 fail), `bun run local:reset && bun run local:smoke` passed (run
> `01a11e20-113d-7023-b181-038232188f07`). Deferred: on Zerops an application has no IAM membership transport yet —
> `boot` refuses membership there with a typed error; follow-up WU F3 of the orchestration. A removed member or a
> revoked link keeps access until its cached token expires, at most 300 s (D12).

# Sprint — A-M3: multi-tenant applications (2026-10-08)

**Goal.** Workspaces, members, share links, forms and GitHub webhooks: A12–A13 of the
implementation plan (deleted at close; see git history).

**Theme.** Membership as IAM operations with live checks. Run by the
orchestration (deleted at close; see git history).

## Refs re-verified at HEAD (2026-10-08)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU  | State  | Commits / note        |
| --- | ------ | --------------------- |
| A12 | landed | `925e5850`…`83f43c6c` |
| A13 | landed | `82a7a89d`…`98289736` |

## Out of scope (explicit)

Self-signup; Slack and Stripe webhooks.

## Decisions

- Delegation grants: IAM side in A12; the proxy obtains them in B2/B3.
- Invitations need a verified mailbox (OIDC `email_verified`, or an emailed one-time link); without an email service
  they are disabled. Membership is flat: "there" is the exact `(type, value)`.
- Built-in role keys (`admin`) are refused for membership roles and contract-application roles.
- `listPrincipals` is refused for application tokens; `members.list` replaces it.

## Sequencing

A12 → (A10) → A13.

## Run log

- 2026-10-08: A12 landed after one fix round: a token never carries more than its credential's ceiling; invitation
  acceptance, last-creator revoke and link issuance are race-safe on Postgres; expired membership grants renew.
- 2026-10-09: A13 landed after one fix round: invitation acceptance re-checks the inviter's role in the consuming
  write (`FOR SHARE` on Postgres); webhook replay protection is keyed on `sha256(bindingId ‖ body)`; webhook handlers
  are at-least-once and get `ctx.delivery.key`. Rejected: a per-request membership check (D12 accepts 300 s).
