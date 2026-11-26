# SCIM provisioning

The organization's identity provider creates, updates and removes the installation's people at IAM over SCIM 2.0
([ADR-0091](../decisions/0091-the-identity-provider-provisions-users-over-scim.md)). Users only; groups are not
provisioned. This page is the operator's: how to connect Microsoft Entra ID, and what each SCIM operation does in IAM.

## Connect Microsoft Entra ID

1. In the console, open **Settings → Provisioning** (an installation administrator, signed in) and **Create token**.
   Copy the token; it is shown once. The page also shows the **tenant URL**, `<IAM issuer>/scim/v2`.
2. In Entra ID, open the enterprise application the installation signs in with (the OIDC one), then
   **Provisioning → Get started**, mode **Automatic**. Enter the tenant URL and the token as **Secret Token**, and
   **Test Connection**. The test asks for a user that does not exist and expects an empty list.
3. **Mappings:** keep **Provision Microsoft Entra ID Users**; turn **Provision Microsoft Entra ID Groups** off (IAM
   answers 404 to `/Groups`). In the user mapping, `emails[type eq "work"].value` must carry the address people sign in
   with: IAM matches an OIDC login by that mailbox. The default (`mail`) is right when the OIDC `email` claim is `mail`.
   `userName` (default `userPrincipalName`) is the matching attribute; `externalId`, `displayName`, `name.givenName` and
   `name.familyName` are stored; every other attribute is accepted and ignored.
4. **Scope:** "Sync only assigned users and groups" provisions the people assigned to the enterprise application.
   Turn provisioning **On**.

### How long a change takes

IAM acts on a SCIM request at once, but Entra sends changes on its own cycle: the incremental cycle runs about every
40 minutes, and the first cycle can take longer. To push one person now (a leaver), open the enterprise application's
**Provisioning → Provision on demand**, pick the user and **Provision**. Blocking a person in Entra (`accountEnabled`
false) reaches IAM as `active=false`; removing their assignment or deleting them reaches IAM as `active=false` and then,
after Entra's soft-delete period, as DELETE.

### Rotating or removing the token

**Rotate token** ends the old token at once; provisioning fails until the new one is entered in Entra. **Remove token**
refuses every SCIM request; people already provisioned stay as they are.

## What IAM does

- **`POST /Users`** creates an internal user, not yet activated; its first OIDC login claims it. A mailbox an
  unprovisioned user holds links that user instead; a mailbox a provisioned user holds is 409 `uniqueness`.
- **`GET /Users?filter=…`** takes `userName eq "…"` (case-insensitive; it falls back to an unprovisioned user with that
  mailbox) or `externalId eq "…"`. Without a filter it lists the provisioned users. Pages by `startIndex` and `count`
  (at most 100).
- **`PATCH` and `PUT /Users/{id}`** update the stored attributes. A changed email moves the person's mailbox and, in
  the same step, signs them out everywhere and switches their password login off; single sign-on keeps working. A PUT
  without `active` keeps it.
- **`active=false`** disables the person and, in the same transaction, revokes every session, `px_` key and OAuth grant
  and spends pending password links. The next request with any of them is refused.
- **`active=true`** enables the person. Nothing revoked comes back; they sign in again.
- **`DELETE /Users/{id}`** does what `active=false` does, and SCIM no longer finds the user. The principal, its grants
  and its history stay; a later `POST` of the same mailbox links it again.

SCIM reaches every internal user of the installation by id or mailbox, and lists those it provisioned or took over.
External people (invited guests) and the installation's bootstrap administrators (`IAM_BOOTSTRAP_ADMINS`) are never
found, created or changed over SCIM: a POST of such a mailbox is 409.
Every change is in the Access audit log, recorded under `scim` with the token's id.

A proxy that cached the person's application token stops serving it within 5 seconds, when it next reads IAM's
revocation feed; the request after that asks IAM, which refuses it
([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md), "Revocation reaches a cached token").
A proxy of a release before the feed serves a cached token until it expires, at most 300 seconds after it was minted.
