---
id: 19
title: reconcileSchema cannot be cancelled
blocked-by: []
---

# 19 — `reconcileSchema` cannot be cancelled

[ADR-0009](../decisions/0009-per-driver-target-and-collaborators.md) added an
`AbortSignal` to the deploy run and the Cloudflare driver honours it — a step in
flight is abandoned, pending steps are skipped, and `CommandSpec.signal` kills the
child process.

## Problem

`reconcileSchema` lives in `@fabrika/auth` and takes no signal, so the one step both
drivers share is the one step that cannot be cancelled. A cancelled deploy can still
sit in an HTTP call to the IAM service until it times out.

It is a small change — thread an optional `AbortSignal` through to the underlying
`fetch` — but it crosses a package boundary that was out of scope when the seam
landed, which is why it is still here.

## Acceptance

Cancelling a deploy during `reconcile-schema` abandons the request promptly on both
drivers, and the step reports as cancelled rather than hanging to its timeout.
