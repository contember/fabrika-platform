---
id: 276
title: IAM keeps serving sign-in on an invalid mail transport
blocked-by: []
---

# 276 — IAM keeps serving sign-in on an invalid mail transport

**Summary.** An invalid `FABRIKA_EMAIL_*` set makes IAM degrade as Control does: it serves sign-in, refuses only the
actions that send mail, and logs the problem. Decided: degrade, not fail closed. Medium.

## Problem

A production installation lost sign-in for about 90 minutes. An operator set `FABRIKA_EMAIL_PROVIDER` to a provider
the running release did not accept yet and restarted IAM, which then failed every start:

- the Bun runtime builds the sender at boot as a readiness check (`emailSenderFromEnv` in
  `packages/iam/src/node/runtime.ts`), and `readEmailTransportConfig` (`packages/email/src/config.ts`) throws
  `invalid_configuration` for an unknown provider or a missing variable, so the process exits 1;
- `buildServices` builds the sender again per request (`buildEmailSender` in `packages/iam/src/services.ts`), so the
  same set would fail each request even past the boot check.

Control reads the same set and keeps serving (`readInstallationMail` in `packages/control/src/mail-transport.ts`, the
`control: the installation's mail transport is invalid, …` line in `packages/control/src/bun/runtime.ts`); only the
deploys that need the transport are refused. One mail variable should not take sign-in down with it.

## Approach / acceptance

1. IAM reads the set once, as Control does: `none`, a valid transport, or `invalid` with the reason, which names
   variables and never a value. An `invalid` set logs one line at boot (`iam: the installation's mail transport is
   invalid, …`) and IAM starts.
2. With an `invalid` set, every action that sends mail (a password reset, a membership invitation, relayed mail) is
   refused with its own fixed code. An operator can then tell it apart from an installation that has no transport.
   Sign-in by OIDC and by password, token minting and `/admin/*` keep working.
3. The local-only guard stays as it is: a composition `EMAIL_SENDER` outside `ENVIRONMENT=local`, or beside a
   `FABRIKA_EMAIL_PROVIDER` other than `none`, still stops the boot. That one is a composition mistake, not an
   operator's variable.
4. The Cloudflare runtime behaves the same. Its per-request `buildServices` must not throw on an `invalid` set.
5. `docs/reference/outbound-email.md` and the guide's mail step state that IAM degrades. The guide's order (Control
   first, then IAM) stays, because Control's log line is the check.

Witness: an IAM test boots the Bun runtime with `FABRIKA_EMAIL_PROVIDER=unknown`. It sees one log line, a password
sign-in that succeeds, and a password reset refused with the new code. The same holds per request on the Worker
entry.

## Touch points

`packages/iam/src/node/runtime.ts`, `packages/iam/src/services.ts`, `packages/iam/src/index.ts`, the senders' callers
(`password-service.ts`, `membership.ts`, `relay-mail.ts`), `packages/email/src/config.ts` (a reader that answers
`invalid` instead of throwing, if Control's is not reused), `docs/reference/outbound-email.md`,
`packages/provider-zerops/src/installation/guide.md`.

<!-- Origin: an IAM outage after a hand-set mail provider on a production Zerops installation (2026-10). -->
