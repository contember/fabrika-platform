---
id: 147
title: A handler and a page do not know the caller's own address
blocked-by: []
---

# 147 — A handler and a page do not know the caller's own address

**Summary.** `ctx.principal` carries an id and a label, and a page learns nothing about who is signed in. A "send it
to me" action has no trusted address, and a page cannot greet the person or hide what they may not do. Effort: S–M;
it needs a decision first.

## Problem

- A user principal is `{ kind, id, label }` (`packages/app/src/implement/principal.ts:6`–`:10`). IAM's label is "a
  user's spelling of its address" (`packages/auth-core/src/types.ts:98`), but the contract calls it a label, the skill
  describes it as a display string (`references/endpoint.md:50`), and a service principal's label is no address.
- A page reads only `<prefix>/__fabrika-config.json`, which holds the Operations DSN and the release (`BrowserConfig`,
  `packages/app/src/implement/dispatch.ts:207`–`:210`).
- An application built on the paved road wanted "send a test e-mail to myself". Taking the address as input let any
  staff user mail any address past every consent check, so the review turned the feature off. The page keeps a typed
  address for its own lifetime.

## Approach / acceptance

- Decide what a handler gets: a verified `email` on a user principal (from the token), or a documented promise that a
  user's `label` is its address.
- Decide what a page gets: the caller's label (and possibly its actions) in a framework-served document, or the
  documented recipe of a `{ member: true }` query that answers `ctx.principal`.
- Witness: the test e-mail of the public intake recipe goes to the caller's own address with no address in its input.

## Touch points

`packages/auth-core/src/{types.ts,token.ts}`, `packages/iam/src/tokens.ts`, `packages/app/src/implement/{principal.ts,dispatch.ts}`,
`packages/app/skill/references/endpoint.md`.
