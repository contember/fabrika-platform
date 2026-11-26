---
id: 0091
title: The organization's identity provider provisions users over SCIM
status: accepted
date: 2026-11-26
---

# 0091 — The organization's identity provider provisions users over SCIM

## Context

An installation that signs people in through an organization's OIDC provider (Microsoft Entra ID first) learns about a
person only when they sign in. A person the organization blocks in its directory keeps their IAM login until the OIDC
session cap ends it (12 hours by default), and an administrator has to disable them in the console by hand. The
organization's directory is the authority on who works there, so it should be able to create, update and remove
people at IAM itself. SCIM 2.0 (RFC 7643, RFC 7644) is the protocol identity providers speak for that.

Backlog 91 keeps a generic SCIM connector out of scope until a concrete provider and a deletion contract are known.
Entra ID is that provider; this decision is the Users part. Groups and their mapping to roles stay out (backlog 91).

## Decision

1. **IAM is a SCIM 2.0 service provider for Users at `<issuer>/scim/v2`.** Create, get, list (filter
   `userName eq "…"` or `externalId eq "…"`, paged by `startIndex` and `count`), replace (PUT), PATCH and DELETE, and the
   discovery documents (`ServiceProviderConfig`, `ResourceTypes`, `Schemas`). No Groups, no Bulk, no sorting, no ETags.
   The surface reads what Entra sends: attribute names and ops in any case, `active` as a boolean or the string
   `"True"`/`"False"`, a PATCH operation without a path whose value is an object, `emails[type eq "work"].value`. An
   attribute IAM does not store is accepted and ignored, because a provider that gets an error for a mapped attribute
   fails the whole user.
2. **A SCIM user is an internal `user` principal, and its SCIM id is the principal's id.** SCIM reaches every internal
   user principal but the bootstrap administrator (§6), by id or by its mailbox; an external principal is never found,
   created, linked or written, because an organization's identity provider claims no external person (ADR-0051). The
   list shows only the users the provider provisioned or took over. The mailbox is the primary email (else
   the work one, else the first, else `userName` when it is an address) and lives where every mailbox lives,
   `principals.email` (the one mailbox rule). A new user is internal and not yet activated, so its first OIDC login
   claims it like an invited one, and the allowlist's known-principal bypass admits it: being provisioned is being
   known. What the provider sent besides (`userName`, `externalId`, `displayName`, `name`) is kept in `scim_users`, which
   nothing reads for authorization. `externalId` never touches `principals.external_id`, which is the OIDC subject.
   A write that moves the mailbox also revokes the person's sessions, spends their password actions and switches
   password login off, in the same transaction: the provider vouches for the new address, not for whoever reads it,
   so a password reset sent there must not open the account. Single sign-on matches the person by subject first.
3. **The provider takes over a person who signed in before provisioning started.** A filter on a `userName` that no
   provisioned user has answers the unprovisioned user whose mailbox it is, and a POST of a mailbox an unprovisioned
   user holds links that principal instead of answering 409. A POST of a mailbox a provisioned user holds is 409.
4. **Deprovisioning is immediate at IAM.** `active=false` and DELETE disable the principal and, in the same transaction,
   revoke every session (an application session with its parent, and by its own row), every `px_` key bound to the
   person, every OAuth grant, and spend every pending password action. The next mint, key exchange, refresh or
   `/admin` call is refused. Re-enabling restores none of it: the person signs in again. The enabling revokes the
   same set again, so nothing a login racing the deprovisioning wrote survives it, and meets the `credentials` mode
   for the keys the person issued for others (ADR-0083 §8), as a machine caller. A write changes `active` only when
   it differs from what the write read, so a concurrent write of other attributes never enables a person again.
5. **DELETE keeps the principal.** It deprovisions as above and marks the link deleted, so SCIM no longer finds the
   user; the principal, its grants and its audit history stay. A later POST of the same mailbox links the same principal
   again, active, with its grants.
6. **The installation's bootstrap administrator is out of SCIM's reach.** A mailbox in `IAM_BOOTSTRAP_ADMINS` is never
   found, created, linked or written, whether or not its principal exists yet: the break-glass account survives a
   provider that deprovisions everyone.
7. **One bearer token per installation, kept by IAM.** `scim_tokens` holds one row or none, the SHA-256 of the secret
   only, compared by digest like every IAM credential. An installation administrator in a signed-in session creates,
   rotates and removes it (`scim.*` of `/admin/rpc`, the console's Settings → Provisioning); the secret is shown once,
   rotation ends the old one in the same write, and no token refuses every SCIM request. A key cannot manage it, and no
   approval request may name it: the token deprovisions every person, so the person who hands it out is on the record.
   Every SCIM change is audited under the token (`principal_label` `scim`, the token's id in the metadata).

## Consequences

- An organization blocks a person in its directory and IAM refuses that person's next mint as soon as the provider sends
  the change. The provider's own cycle dominates that delay: Entra's incremental cycle runs about every 40 minutes
  unless an administrator provisions the person on demand (`docs/reference/scim-provisioning.md`).
- A token a proxy already cached stays valid until it expires, at most `DEFAULT_TOKEN_TTL_SECONDS` (300 s) after its
  mint (ADR-0022, "Revocation takes effect within the token lifetime"). Closing that window is the proxy's work, not
  IAM's, and a separate change.
- The surface is an installation service row of IAM's contract (`scim-root`, `scim`, both `protocol`): the proxy reads
  no credential and passes `Authorization` on. **Rollout:** migration `0044_scim_provisioning` is additive and runs on
  every IAM start; the Zerops platform proxy publishes the new rows from its generated manifest at the next
  `fabrika platform upgrade` (until then `/scim/v2` answers the proxy's 403); IAM's Cloudflare Worker serves them at its
  next deploy. No variable changes, and nothing is provisioned until an administrator creates a token.
- An administrator who disables a provisioned person in the console can be overridden by the provider's next
  `active=true` for that person. The provider is the authority on whether a person is active.

## Alternatives considered

- **The token as a deploy variable (its hash beside IAM's other secrets).** Rotation would be a platform deploy, by the
  operator rather than the installation's administrator, and IAM already keeps hashed credentials it issues itself
  (`membership_transport_keys`, `credentials`).
- **A `credentials` row of a service principal (a `px_` key with an `iam.scim` action).** A `credentials` row is what
  the proxy exchanges for an application token; a SCIM token must reach nothing but `/scim/v2`, so it is no key and no
  `px_` path finds it, the membership transport key's rule.
- **Hard-deleting the principal on DELETE.** It would cascade grants and orphan audit rows; re-provisioning would make a
  stranger of the same person. Disabling keeps every rule that already holds for a disabled principal.
- **SCIM `externalId` as the login identity.** IAM matches an OIDC login by its subject, then its mailbox; Entra's
  `externalId` is whatever the mapping says (mailNickname by default), not the token's `sub`. Keeping it apart leaves
  login identity unchanged.
