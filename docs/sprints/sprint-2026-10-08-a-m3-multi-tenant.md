# Sprint — A-M3: multi-tenant applications (2026-10-08)

**Goal.** Workspaces, members, share links, forms and GitHub webhooks: A12–A13 of the
[implementation plan](../ideas/app-framework-implementation-plan.md).

**Theme.** Membership as IAM operations with live checks. Run by the
[orchestration](../ideas/app-framework-orchestration.md).

## Refs re-verified at HEAD (2026-10-08)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

| WU  | State              | Commits / note        |
| --- | ------------------ | --------------------- |
| A12 | landed             | `925e5850`…`83f43c6c` |
| A13 | queued (after A10) |                       |

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
