---
id: 224
title: Smaller gaps of terminals
blocked-by: []
---

# 224: Smaller gaps of terminals

**Summary.** Low-severity gaps the merge review of terminals (ADR-0067) left open.

## Problem

- **Sign-out needs `Sec-Fetch-Site`.** The proxy's sign-out (`signOut`, `packages/proxy-core/src/authorize.ts`) requires
  `Sec-Fetch-Site: same-origin`. A kiosk browser that does not send it (WebKit before Safari 16.4, some WebViews) gets
  403, and the person's session lasts until its lifetime ends (5 minutes by default).
- **Re-enrolling orphans the old terminal.** `enrol` (`packages/iam/src/auth/terminals.ts`) on a browser that already
  holds a terminal cookie creates a new terminal; the old row stays active with no browser holding its cookie.
- **Sign-out on a personal login signs straight back in.** On a browser that is not a terminal, the sign-out clears the
  application cookie but the person's IAM login survives, so the next request signs them in again.

## Approach / acceptance

- Document the browser requirement, or accept a request without `Sec-Fetch-Site` whose `Referer` is same-origin.
- Revoke the terminal of a valid cookie in the same batch that enrols the new one.
- Document the sign-out path as terminal-only, or also end the child session of a personal login.

## Touch points

`packages/proxy-core/src/authorize.ts`, `packages/iam/src/auth/terminals.ts`, `docs/reference/human-authentication.md`.

<!-- Origin: the merge review of PR #32. -->
