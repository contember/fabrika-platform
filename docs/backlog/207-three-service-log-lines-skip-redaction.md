---
id: 207
title: Three service log lines skip redaction
blocked-by: []
---

# 207 — Three service log lines skip redaction

**Summary.** Three `console.error` calls print an error's text, or the error object, without the redaction the
surrounding code applies elsewhere. The root `CLAUDE.md` forbids both. P3, size S each.

## Problem

1. **A failed run's reason.** `packages/control/src/run-lifecycle.ts:753` prints `deploy run … failed: ${reason}`.
   `failureReason` (`:773-776`) applies only the pattern redaction of `redactNamespaceErrorText` (URL credentials,
   `px_` keys, JWTs, GitHub tokens, `NAME=value`). The next line writes the same reason to the run log, whose writer
   also replaces every known secret of the run (`redactKnownSecrets`, `:167`, fed at `:668`). A provider error that
   echoes a resolved secret value in another shape reaches the service log in the clear.
2. **A failed provider preparation.** `preparationFailure` (`packages/control/src/api/registry/registration.ts:229-233`)
   prints the first 300 characters of `cause.message` with no redaction. A provider error that carries a clone URL
   with an embedded token or a request URL with a query reaches the service log.
3. **A runner container error.** `RunnerContainer.onError` (`packages/runner-cloudflare/src/RunnerContainer.ts:121-123`)
   prints the whole error object. An error from the container start or a fetch can carry a URL, headers or a cause
   chain.

## Approach / acceptance

1. Build the reason once with the run's known secrets as well, and use it for both lines (or print only the error
   class to the service log and keep the detail in the run log).
2. Pass `cause.message` through `redactNamespaceErrorText` before printing it.
3. Print a short fixed message and the error's name, never the object.

Witness for each: a test that a thrown error holding a secret value (for 1), a `https://x:token@host` URL (for 2) and
an object with a URL (for 3) prints no part of it, by capturing `console.error`.

## Touch points

`packages/control/src/run-lifecycle.ts`, `packages/control/src/api/registry/registration.ts`,
`packages/runner-cloudflare/src/RunnerContainer.ts`.

<!-- Origin: a platform review. -->
