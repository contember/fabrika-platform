# Sprint — M0: close the current holes (2026-10-08)

**Goal.** Part 0 of the [implementation plan](../ideas/app-framework-implementation-plan.md): canonical paths, IAM key issuing, a narrow IAM entrypoint on
Cloudflare, provider exposure refusals.

**Theme.** Holes in today's code, independent of parts A and B. Run by the [orchestration](../ideas/app-framework-orchestration.md): one work unit per
branch and worktree, independent review, integrator gate, fast-forward to `main`.

## Refs re-verified at HEAD (2026-10-08)

The plan's "Facts at HEAD" were surveyed at `3a4e76b8`; each work unit re-verified its own facts first.

## Work units

The work units are P0.1–P0.4 in the plan; their text is not copied here.

| WU   | State   | Commits / note                   |
| ---- | ------- | -------------------------------- |
| P0.1 | landed  | `dde43cf5`…`ac45a302`            |
| P0.2 | landed  | `f3f3262a`, `54817850` (rebased) |
| P0.3 | running |                                  |
| P0.4 | landed  | `63d0e3c7`…`7338db3a` (rebased)  |

## Out of scope (explicit)

Everything in parts A and B.

## Decisions

- P0.1: a trailing `/` is significant and matched literally (Sentry SDKs send `/api/<project>/envelope/`); a non-root
  wildcard needs the slash before it, so `/x/*` no longer matches `/x` in the router. ADR-0022 step 1 updated.
- P0.1: a missing forwarded method is denied; a literal `\` is non-canonical; the query is not checked.
- P0.2: a key lifetime is at most 30 days (`MAX_KEY_LIFETIME_SECONDS`); a key lists exact catalog actions, no
  wildcards; `audit` verifies the forwarded credential with a 1-hour expiry grace (audit only).
- P0.4: the Zerops refusal sits at the application manifest boundary; an omitted bucket policy is written as
  `private`; Cloudflare `preview_urls` must be literally `false`; only the provider's own proxy Worker is exempt.

## Sequencing

P0.1, P0.2, P0.4 in parallel; P0.3 after P0.2 and P0.4.

## Run log

- 2026-10-08: P0.1 needed two review rounds; the second found that `/x/*path` matched `/x` in the router but not
  in the gate matcher (pre-existing) — fixed, with a proxy-to-router test. Control gained an explicit `/webhooks`
  404 route.
- 2026-10-08: P0.2 found that IAM has no caller identity on the binding; `audit` now takes the forwarded credential
  like `issueKey`. Not covered: the audit actor fields are still the caller's word; admin `apiKeys.provision` has
  no expiry rule.
