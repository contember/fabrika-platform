---
id: 305
title: A deploy hands out workload keys under a `credentials` mode stricter than `deploy-request`
blocked-by: []
---

# 305 — A deploy hands out workload keys under a `credentials` mode stricter than `deploy-request`

**Summary.** Control issues a deploy's workload and connector keys with the provisioning key, which the `credentials`
gate exempts (ADR-0083 §8). So whoever may deploy gets those keys, whatever `credentials` says. Pre-existing, low
severity, about half an agent day.

## Problem

- **A job's key under `deploy-request: off`.** An environment may set `credentials` to `person` or `refuse` and
  `deploy-request` to `off`. A machine caller then declares a job (or a webhook) in a deploy and gets its key at that
  environment, holding the actions the job declares, with no person involved. Any other way to get a key there needs a
  person. `packages/control/src/workload-credentials.ts` issues the keys; `setEnvironmentProtectionUseCase` in
  `packages/control/src/approval/api.ts` accepts the two modes in any combination.
- **A connector key at a protected owner.** A deploy of a consumer environment issues one connector key per owner
  application it imports from (`declaredConnectors` in `workload-credentials.ts`). The key lands at the owner
  environment, which may be protected while the consumer is not. It holds no more than the export the owner approved
  for that consumer, so this widens nothing the owner did not approve, but no person at the owner sees the deploy.
- Found by the review of PR #442 (findings 4 and 5). ADR-0083 §8 states the exemption on purpose; nothing warns about
  the combination.

## Approach / acceptance

- Decide between a warning and a refusal when an environment's `credentials` mode is stricter than its
  `deploy-request` mode: the console's protection form warns at least, and `setEnvironmentProtectionUseCase` may refuse
  the combination (400, naming both categories). A test sets each combination and sees the warning or the refusal.
- For a connector key, decide whether the owner environment's `credentials` mode gates a consumer's deploy that issues
  its first key there, or whether the owner's approved export is enough. Record the decision in ADR-0083 §8, and test
  whichever rule is chosen with an unprotected consumer and a protected owner.

## Touch points

- `packages/control/src/approval/api.ts`
- `packages/control/src/workload-credentials.ts`
- `packages/control-contract/src/approval-policy.ts`
- the dashboard's protection form
- `docs/decisions/0083-an-environment-chooses-what-waits-for-approval.md` §8

<!-- Origin: the review of PR #442 (step 8 of ../ideas/agent-requested-approvals.md), round 1, findings 4 and 5. -->
