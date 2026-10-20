---
id: 178
title: An installation transport through a relay outside the repository
blocked-by: []
---

# 178 — An installation transport through a relay outside the repository

**Summary.** Let Control's own transport be a relay that a client operates, over the platform mail wire, so the
installation can send through an adapter that is not built into the platform. Medium; decided, not scheduled.

## Problem

Control's mail relay ([ADR-0019](../decisions/0019-portable-outbound-email.md) §8) dispatches with Control's own
`FABRIKA_EMAIL_*`, and that transport can use only a built-in provider (`builtinEmailProviders`: Resend,
SmartEmailing). IAM and Control are built from this repository, so an adapter that lives in another package cannot
reach them without a new platform build. An application's own transport (`mailer: 'own'`) can use any adapter; the
installation's cannot.

The wire exists: `@fabrika/email/platform` defines the request, the one parser, the answers and
`PlatformEmailSender`. Only Control's relay serves it, and only an application's `ctx.mail` selects the sender.

## Approach / acceptance

1. **A registry provider over the wire.** A built-in, env-selectable provider for Control's own transport (for
   example `FABRIKA_EMAIL_PROVIDER=relay`, `FABRIKA_EMAIL_RELAY_URL`, the secret `FABRIKA_EMAIL_RELAY_KEY`) that builds
   a `PlatformEmailSender`. It must not collide with `FABRIKA_EMAIL_PROVIDER=platform`, which `ctx.mail` reads.
2. **A reference relay.** A small server over any `EmailSender` that serves the wire: it records each key with its
   message fingerprint and result before it answers, so a repeated key answers the first result without sending again.
   A client runs it with its own adapter.
3. **Document** the wire in `docs/reference/outbound-email.md` as a public protocol, with the compatibility rule of
   [ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md).

Witness: Control's relay dispatches through the `relay` provider to the reference relay over a `MemoryEmailSender`
with `idempotent: false`, and a lost answer followed by a retry delivers once.

## Touch points

`packages/email/src/` (`providers.ts`, `platform.ts`, the conformance kit), a new reference relay module,
`docs/reference/outbound-email.md`, the installers' provider prompts (`packages/provider-zerops/src/installation/`).

<!-- Origin: the application-mail work (ADR-0019); the relay protocol part shipped in the platform transport sprint (ADR-0064). -->
