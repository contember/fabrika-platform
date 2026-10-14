---
id: 146
title: A request handler has no abort signal
blocked-by: []
---

# 146 — A request handler has no abort signal

**Summary.** A job gets `ctx.signal`; a request handler gets none, and the generated tests boot without the
application's variables. So an outbound call in a handler cannot be bounded, and it fails the generated cases with 500.
Effort: S–M.

## Problem

- `RequestContext` is `{ principal, requestId }` (`packages/app/src/implement/types.ts:16`–`:19`). A handler that calls
  a provider cannot stop when the client leaves or the proxy times out.
- The endpoint access kit boots with only the challenge secrets set (`unusedVariables`,
  `packages/app/src/testing/endpoint-access.ts:204`). The skill says to read a variable where it is used
  (`references/tests.md`), so a handler that sends an e-mail synchronously throws on the missing variable, and the
  generated "held globally reaches it" case answers 500.
- An application built on the paved road moved a "send a test e-mail" button into an outbox row that its job sends,
  so the person waits up to a minute.

## Approach / acceptance

- `RequestContext` gains `signal`, aborted when the request is cancelled or exceeds its budget.
- Decide what the generated cases do with an outbound dependency: a declared test stand-in per dependency, or the
  rule that a handler never calls out and the skill's recipe says so.
- Witness: a handler that passes `ctx.signal` to `fetch` is aborted by a cancelled request in a kit test; the
  generated cases of an endpoint with an outbound call pass by the chosen rule.

## Touch points

`packages/app/src/implement/{types.ts,dispatch.ts,invocation.ts}`, `packages/app/src/testing/endpoint-access.ts`,
`packages/app/skill/references/{endpoint.md,tests.md}`.
