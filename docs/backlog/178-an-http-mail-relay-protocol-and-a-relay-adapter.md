---
id: 178
title: An HTTP mail relay protocol and a relay adapter
blocked-by: []
---

# 178 — An HTTP mail relay protocol and a relay adapter

**Summary.** Define a small HTTP protocol for sending mail through a relay, and build a `relay` provider into
`@fabrika/email`. An installation transport can then use any adapter, and a relay can make a non-idempotent provider
idempotent. Medium; decided, not scheduled.

## Problem

[ADR-0019](../decisions/0019-portable-outbound-email.md) lets an installation transport use only a built-in provider
(`builtinEmailProviders`: Resend, SmartEmailing). IAM and Control are built from this repository, so an adapter that
lives in another package cannot reach them without a new platform build. An application's own transport can use any
adapter; the installation's cannot.

Two more gaps follow from the same limit:

- **Non-idempotent providers.** SmartEmailing has no idempotency key. An `unknown` outcome over it is never retried
  automatically (`mayRetryDelivery`), so a lost answer leaves a message for a person to resolve.
- **The credential spreads.** Every application that declares `mailer: 'installation'` receives the provider's
  credential as a `FABRIKA_EMAIL_*` variable.

## Approach / acceptance

1. **The protocol.** One versioned HTTP request per message, authenticated with a bearer key, that carries the
   `EmailMessage` fields and the idempotency key. The answer maps one to one onto `EmailDeliveryErrorCode`, so the
   relay's `retryable` and `outcome` reach the caller unchanged. A capabilities request answers the relay's
   `idempotent`, `confirmation` and `maxBatch`. The protocol is public and documented in `docs/reference/`.
2. **The `relay` provider.** A built-in, env-selectable provider (for example `FABRIKA_EMAIL_PROVIDER=relay`,
   `FABRIKA_EMAIL_RELAY_URL`, the secret `FABRIKA_EMAIL_RELAY_KEY`). It reports the relay's capabilities.
3. **A reference relay.** A small server over any `EmailSender`. It records each key with its message fingerprint and
   result before it answers, so a repeated key answers the first result without sending again. Over a
   non-idempotent provider it then reports `idempotent: true`.
4. **Decide** where a relay runs (an installation service, or operated by the client) and whether Control can then
   write only the relay key into applications instead of the provider credential.

Witness: the `relay` adapter passes the conformance kit against the reference relay. The reference relay over a
`MemoryEmailSender` with `idempotent: false` delivers once after a lost answer and a retry under the same key.

## Touch points

`packages/email/src/` (a `relay.ts` adapter, `providers.ts`, the conformance kit), a new relay server package or
module, `docs/reference/outbound-email.md`, the installers' provider prompts
(`packages/provider-zerops/src/installation/`, `packages/provider-cloudflare/src/installation/`).

<!-- Origin: the application-mail work (ADR-0019, rejected alternative "IAM relays application email"). -->
