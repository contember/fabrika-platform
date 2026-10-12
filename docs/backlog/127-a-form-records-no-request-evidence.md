---
id: 127
title: A form records no request evidence
blocked-by: []
---

# 127 — A form records no request evidence

**Summary.** A form writes its input fields and nothing else, so a consent given through a public form has no client
address or user agent as evidence. Effort: S–M, after one question to the human.

## Problem

A form runs no handler. It appends one row of its declared input fields to its inbox (`appendToInbox`, with the field
check of `inboxProblems`, `packages/db/src/store.ts:1230`–`:1243`). The time of the submission is available through an
inbox column with `DEFAULT now()` (a documentation gap, in
[121](121-the-skills-gaps-found-by-the-private-dogfood.md)). The client address and the user agent never reach the
application. The private dogfood's intake records a consent's purpose, text version, method and time. Evidence of
consent is often expected to include the client address or user agent as well, and the form cannot provide either.

## Approach / acceptance

- Ask first: does the application need this evidence, or are the time and the confirmed address enough? If they are
  enough, delete this item.
- Otherwise: an inbox may declare framework-filled columns (`received_at`, `user_agent`, `client_address`), which the
  form writes from the request it admitted. The contract declares them, so the approval shows that the form collects
  them (ADR-0050).
- The client address is trustworthy only where the edge forwards one the application may trust. On Zerops that is
  backlog [05](05-bring-up-on-a-real-zerops-account.md)'s open question. Until then the column is refused on that
  provider, never filled with a forgeable header.
- Witness: a dispatch test of a form whose inbox declares the columns. The row holds the admitted request's values,
  and a client-supplied forwarding header does not reach the row.

## Touch points

`packages/app/src/contract/{define.ts,build.ts}`, `packages/app/src/implement/{dispatch.ts,form-admission.ts}`,
`packages/db/src/store.ts`, `packages/app/skill/references/public-intake.md`.

<!-- Origin: the paved-road sprint, WU21 (the private dogfood). -->
