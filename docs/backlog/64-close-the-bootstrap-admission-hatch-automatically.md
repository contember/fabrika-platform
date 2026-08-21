---
id: 64
title: Close the bootstrap admission hatch automatically
blocked-by: []
---

# 64 — Close the bootstrap admission hatch automatically

**Summary.** A Cloudflare installation comes up with a standing admission list that grants admin to
anyone whose email is in it, and closing it is an instruction printed to a human. Make the hatch close
itself, or stop needing one. Effort M.

## Problem

`fabrika platform init --provider=cloudflare` writes two admission lists into the operator's GitHub
Environment — `FABRIKA_IAM_BOOTSTRAP_ADMINS` and `FABRIKA_CONTROL_BOOTSTRAP_ADMINS`
(`packages/installation-cloudflare/src/init.ts:161`, `:176`) — and then prints how to close them
(`:522-524`):

> `1. gh variable set FABRIKA_CONTROL_BOOTSTRAP_ADMINS … --body '[]'`
> `2. gh workflow run platform.yml …`

While the list is set, IAM treats a matching email as an admin unconditionally: `isBootstrapAdmin`
short-circuits role resolution (`packages/iam/src/resolve.ts:20`, `packages/iam/src/services.ts:121`).
It does not expire, it is not scoped, it leaves no grant row, and **nothing reports that it is open** —
not a test, not a deploy, not the console.

That is the same failure class as the `ENVIRONMENT=local` drift (backlog 59, closed), which was
found by reading a live account rather than by any check the repository runs, and which
`sprint-2026-08-06-zerops-platform-deploy` named in advance: _"an escape hatch that is documented but
never closed is 59 all over again — prefer a mechanism that closes itself."_

**The Zerops path already avoids it, by not having one.** `platform deploy --provider=zerops` writes no
credential and no admission list, so `init` has nothing to seed and the operator has nothing to reset;
a test asserts no Environment key contains `BOOTSTRAP`. What that path does NOT do is explain how the
first administrator gets in on a fresh account — today the answer is the hand bring-up.

## Approach / acceptance

Pick a mechanism that cannot be left open. Candidates, none decided:

- **Consume on first use.** The first successful resolution through the hatch writes a real grant row
  for that principal and marks the hatch spent, so the list stops applying even if the variable stays.
  Closest to "closes itself"; needs a durable spent-marker per installation.
- **Bind it to a deploy.** The list applies only to the installation version that introduced it, so the
  next `platform deploy` closes it whether or not anyone remembers.
- **Remove it entirely,** as Zerops did, and seed one real grant at install time instead. Requires
  answering how a fresh installation gets its first administrator without one.

Whichever is chosen, the acceptance is the same and has two halves:

1. An installation that has completed init and had one administrator sign in **cannot** still be
   admitting on the list, without a human having done anything.
2. **A witness exists.** Something in the repository fails, or the console reports, when an
   installation is admitting on a bootstrap list — the gap in 58, 59 and this item is identical:
   the state was wrong for weeks and nothing said so.

## Touch points

`packages/iam/src/{services,resolve,tokens}.ts`, `packages/control/` (its own list),
`packages/installation-cloudflare/src/{init,templates}/`, and whatever surfaces the witness.

<!-- Origin: sprint-2026-08-06-zerops-platform-deploy run log, WU4. Raised in 62 and left unanswered
     for Cloudflare when WU4 answered it for Zerops by removing the hatch. -->
