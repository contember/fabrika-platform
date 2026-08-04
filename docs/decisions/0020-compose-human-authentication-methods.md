---
id: 0020
title: Compose OIDC and password as independent human authentication methods
status: accepted
date: 2026-08-04
---

# 0020 — Compose OIDC and password as independent human authentication methods

## Context

IAM currently assumes every production human session starts at one OIDC provider. A user is considered invited while `external_id` is null and active after an OIDC subject is attached. Sessions require that upstream subject. These shortcuts cannot represent an active password-only user or distinguish which credential created a session.

Installations need three useful configurations: OIDC only, password only, and both. In the combined configuration, password eligibility is per person; enabling password globally must not give every OIDC user an implicit password credential. Password recovery also has to work when outbound email is configured and when an isolated installation has no mail service.

A single `authMode` enum would encode the current cross-product but make each future method add more combined enum values. Coupling password availability to email availability would also make an operational integration silently change the authentication policy.

## Decision

OIDC and password will be independent, explicitly enabled human-authentication capabilities. OIDC-only, password-only, and hybrid behavior are derived from the two switches. Enabling neither is invalid and fails configuration. Existing installations that predate the switches default to OIDC enabled and password disabled; new installations write both values explicitly.

OIDC configuration and secrets are required only when OIDC is enabled. Password configuration never enables itself because an email sender exists.

Each user has an explicit password state: disabled, pending enrollment, or enabled. Administrators may permit enrollment, issue a replacement enrollment, issue a reset, or disable password login. They never set or read the password. The user chooses it through the same short-lived, single-use action flow in every installation:

- with email, IAM sends the action URL;
- without email, IAM returns the URL once to an authorized administrator for delivery through another channel.

Only hashes of action tokens are stored. Fetching an action page does not consume its token because mail scanners may follow links; the state-changing form submission consumes it. Login and recovery responses do not disclose whether an email or password credential exists. Password attempts are rate-limited and password selection applies length and common/context password checks without composition rules.

Principal activation becomes independent of OIDC linkage. Sessions record their authentication method. Replacing or disabling a password revokes password-origin sessions while preserving valid OIDC-origin sessions in a hybrid installation.

The existing bootstrap-admin email list grants authorization only after identity is proven. When mail is available, control of a configured bootstrap address may complete the first password enrollment. Without mail, the existing provisioning bearer authorizes the first explicit enrollment; there is no persistent bootstrap password.

**Invariant:** Enabling a human authentication method globally never provisions that credential for a principal, and disabling or resetting password authentication never revokes an independent OIDC session.

## Consequences

- A hybrid installation does not need a special mode implementation; it renders both enabled methods.
- Password-only installations no longer need placeholder OIDC configuration.
- The principal and session schemas gain durable auth-neutral state, and both D1 and Postgres need immutable migrations.
- Password enrollment and reset share one security path, which reduces special cases but makes action-token correctness and throttling load-bearing.
- Manual delivery remains operationally weaker than email delivery because the administrator must choose another secure channel, but it does not weaken token or password storage.
- Adding another human method extends the capability set rather than multiplying combined modes.

## Alternatives considered

### Use `authMode: 'oidc' | 'password' | 'hybrid'`

Rejected because hybrid is only the presence of both methods. An enum duplicates that fact and grows combinatorially when another method is added.

### Let administrators assign temporary passwords

Rejected because administrators would learn user credentials and IAM would need a second forced-change lifecycle. A one-time enrollment link gives the user sole knowledge of the password in both email and manual-delivery installations.

### Require email for password authentication

Rejected because some single-tenant installations intentionally have no mail service. Manual delivery can reuse the same one-time action securely; only self-service recovery is unavailable until a sender is configured.

### Store a password bootstrap secret in deployment configuration

Rejected because it creates a long-lived authentication bypass whose consumption and rotation require more durable state. The existing provisioning bearer already defines the machine bootstrap trust boundary.
