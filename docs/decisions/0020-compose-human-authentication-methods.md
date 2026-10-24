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

**One minimum password length per installation.** It is 15 code points unless an installation administrator
(`iam.admin`) sets another through IAM's `passwordPolicy.set`; the value is one row in IAM (`password_policy`), every
change is audited as `iam.password_policy.update`, and the console sets it under Settings → Passwords. It applies to
every principal alike, at the next enrollment, reset or invitation enrollment; a stored verifier is never judged again,
so raising it asks nobody to change a password and lowering it weakens none. The value may go down to a floor that
depends on how expensive a verifier is to crack: 4 where IAM hashes with OWASP's PBKDF2 cost (the Bun process), 15
where it hashes below it (a Cloudflare Worker, [backlog 201](../backlog/201-cloudflare-passwords-are-hashed-below-the-owasp-work-factor.md)).
Whatever the minimum, the whole-password blocklist refuses the 10 000 most common passwords (SecLists) and a few Czech
ones, so a short minimum does not admit `12345` or `heslo`. A row IAM cannot read, or one outside the runtime's range,
applies 15.

Principal activation becomes independent of OIDC linkage. Sessions record their authentication method. Replacing or disabling a password revokes password-origin sessions while preserving valid OIDC-origin sessions in a hybrid installation.

An external principal ([ADR-0051](0051-external-principals.md)), a person from outside the organization, authenticates by password only. OIDC never claims an external principal's row and never creates one: an IdP that presents its mailbox is refused with the fixed reason `oidc_external_principal`, and the human-admission allowlist's bypass for an already-known principal admits only an internal one. Only an installation administrator's audited promotion makes it internal, after which OIDC may claim it; the promotion ends every session and pending password action issued while it was external. Hybrid linking of an internal principal is unchanged.

An invitation may carry the first enrollment of the principal it creates. An application's invitation by e-mail to a
membership role declared external, for a mailbox no principal holds, creates nothing when it is sent. When the
mailbox's owner opens the link, IAM asks for a password instead of a sign-in, and that form's submission creates the
external principal, its enabled password account and verifier, and the membership grant, consumes the invitation and
writes their records in one transaction, then signs the browser in. This enrollment lives as long as the invitation,
7 days, instead of an action's one hour, because the invitation's own one-time token is the action token: it is mailed
to the mailbox and stored only as a hash, its page is scanner-safe, and only the submission consumes it. It exists only
for a principal the invitation creates. An invitation never sets, replaces or re-enables the password of an existing
principal, a disabled one or one whose password is disabled included; such a mailbox signs in and accepts. A browser already signed in on IAM, as anyone, is refused this enrollment and told
to sign out or use another browser profile, so the new account never replaces a session unnoticed. It needs
password authentication and e-mail to be enabled, and IAM never creates a mailbox the organization names (a bootstrap
admin, or one the human-admission allowlist names by address or domain; `*` names nobody) this way: the invitation is
refused when it is sent.

The existing bootstrap-admin email list grants authorization only after identity is proven, and never to an external principal. When mail is available, control of a configured bootstrap address may complete the first password enrollment. Without mail, the existing provisioning bearer authorizes the first explicit enrollment; there is no persistent bootstrap password.

**Invariant:** Enabling a human authentication method globally never provisions that credential for a principal, and disabling or resetting password authentication never revokes an independent OIDC session.

**Invariant:** An invitation sets a password only for the principal its acceptance creates, in the same transaction.

## Consequences

- A hybrid installation does not need a special mode implementation; it renders both enabled methods.
- Password-only installations no longer need placeholder OIDC configuration.
- The principal and session schemas gain durable auth-neutral state, and both D1 and Postgres need immutable migrations.
- Password enrollment and reset share one security path, which reduces special cases but makes action-token correctness and throttling load-bearing.
- Manual delivery remains operationally weaker than email delivery because the administrator must choose another secure channel, but it does not weaken token or password storage.
- Adding another human method extends the capability set rather than multiplying combined modes.
- An installation that lowers the minimum below 15, and especially below 8, accepts a weaker credential: IAM has no second
  factor, and NIST SP 800-63B asks for 15 when a password is the only one and never fewer than 8. The throttles bound
  online guessing per account, the blocklist removes the guesses that come first, and the console warns below 15 and
  more loudly below 8; nothing protects short verifiers in a leaked database. That is the installation's choice, recorded
  in its audit log. A client whose people sign in rarely (partners, candidates) asked for it, and the alternative was
  passwords written down.

## Alternatives considered

### Set the minimum through an environment variable

Rejected because it would record no actor and no time, need a redeploy (and on Cloudflare a change of the generated
workflow) to answer a client's request, and could not be shown or changed in the console. The installation's other
presentation of IAM, its logo ([ADR-0066](0066-the-installation-shows-its-clients-logo.md)), is kept the same way.

### A minimum per application or per kind of principal

Rejected because a password belongs to the principal, which spans applications: one person would meet different rules
for the same credential. A lower minimum for external principals only was considered and left out; the installation
asked for one rule for everybody.

### A hard floor of 8

Rejected for the same client: 8 is NIST's minimum only beside a second factor, which IAM does not have either, so it
draws no line the installation's own risk decision does not. The floor of 4 keeps a password from becoming a PIN.

### Use `authMode: 'oidc' | 'password' | 'hybrid'`

Rejected because hybrid is only the presence of both methods. An enum duplicates that fact and grows combinatorially when another method is added.

### Let administrators assign temporary passwords

Rejected because administrators would learn user credentials and IAM would need a second forced-change lifecycle. A one-time enrollment link gives the user sole knowledge of the password in both email and manual-delivery installations.

### Require email for password authentication

Rejected because some single-tenant installations intentionally have no mail service. Manual delivery can reuse the same one-time action securely; only self-service recovery is unavailable until a sender is configured.

### Store a password bootstrap secret in deployment configuration

Rejected because it creates a long-lived authentication bypass whose consumption and rotation require more durable state. The existing provisioning bearer already defines the machine bootstrap trust boundary.
