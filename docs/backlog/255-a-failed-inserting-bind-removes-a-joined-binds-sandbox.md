---
id: 255
title: A failed inserting bind removes a joined bind's sandbox
blocked-by: []
---

# 255 — A failed inserting bind removes a joined bind's sandbox

**Summary.** The failed-create cleanup of `bind_dev` is fenced to the bind that inserted the `creating` row, so a bind
that joined the row and then failed leaves it alone. The other direction is open: when the inserter fails while a joined
bind is still creating, the inserter removes the joined bind's sandbox. Minor: nothing is orphaned and the next bind
succeeds.

## Problem

`ensureDevSandbox` (`packages/control/src/dev/service.ts`) passes the request's signal to `ensure`, so a client that
times out and retries aborts the first bind (A) after the retry (B) joined its row. A's cleanup marks the row through
`markRemovingIfUncreated` (`packages/control/src/db/dev-sandboxes.ts`): the row is still `creating`, holds no sandbox
and names A's `create_attempt`, so the mark succeeds. The removal deletes the sandbox under the workspace's name, which
is the one B created or adopted, revokes the keys and deletes the row. B's `markReady` then returns null and B answers
409 `DEV_SANDBOX_REMOVING`, or its wait for the sandbox fails.

## Approach / acceptance

On a conflict in `insertCreating`, clear `create_attempt` while the row is `creating` without a sandbox. A row two binds
share is then removed by neither; maintenance removes it after `DEV_SANDBOX_CREATING_SECONDS` if no create finishes.
A test aborts the inserting bind's `ensure` after a second bind joined the row, and the second bind ends ready with no
`remove` call.

## Touch points

`packages/control/src/db/dev-sandboxes.ts`, `packages/control/src/__tests__/dev-sandboxes.test.ts`,
`packages/control/src/__tests__/dev-sandboxes-repository.test.ts`.

<!-- Origin: review round 3 of the per-workspace dev sandboxes PR. -->
