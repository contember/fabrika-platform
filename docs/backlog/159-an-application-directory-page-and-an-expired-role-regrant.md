---
id: 159
title: A full directory page exceeds D1's bind limit, and an expired global role cannot be regranted
blocked-by: []
---

# 159 — A full directory page exceeds D1's bind limit, and an expired global role cannot be regranted

**Summary.** Two defects in an application's own people (ADR-0022 rule 6), found in the review of backlog 126 and 156.
A directory page of 99 or 100 people fails on D1, and a delegated grant of a role whose earlier grant expired reports
success but grants nothing. Severity: P2 each. Effort: S.

## Problem

- **The directory page binds one parameter per person.** `MembershipRepository.listAppMemberGrants`
  (`packages/iam/src/repositories/membership.ts:262`) binds `app`, the current time and one id per person in the
  page. A page of 99 or 100 people (`MAX_APP_MEMBERS_PAGE` is 100, and the console always asks for 100) binds 101 or
  102 parameters, more than [D1's limit of 100](https://developers.cloudflare.com/d1/platform/limits/). The
  application's `ctx.members.list()` and the console's people page then fail on Cloudflare once an application has
  that many people. The SQLite and Postgres tests do not enforce the limit, so nothing caught it.
- **An expired global role cannot be granted again.** `GrantRepository.createDelegatedRoleGrant`
  (`packages/iam/src/repositories/grants.ts:254`) inserts with `ON CONFLICT … DO NOTHING`, and the unique index
  (`idx_grants_uq_global`) includes expired grants. When a person's `staff` grant has expired, `appPeople.grant` of
  `staff` answers `granted: false`, which the console reads as "already held". The person has no access, no audit row
  is written, and when it was the person's only role of the application they no longer appear in its directory, so the
  administrator cannot find them there either.

## Approach / acceptance

- **Directory page.** Read the page's grants in chunks of at most 98 ids, or select them through a paged subquery
  over `grants` that binds no id per person. Witness: a 100-person application read page by page with a database
  stand-in that refuses a statement of more than 100 bound parameters, and the same pages as today.
- **Expired regrant.** Renew an expired grant atomically, as `RENEW_EXPIRED_MEMBERSHIP` does for a membership role
  (`ON CONFLICT … DO UPDATE … WHERE grants.expires_at <= now`), under the same `DelegatedAuthority` guard, and write the
  `iam.grant.create` record exactly when the row changed. An active grant stays a no-op. Witness: an expired `staff`
  grant, `appPeople.grant` of `staff` → `granted: true`, the person resolves `staff`'s actions, one record; the retry
  → `granted: false`, still one record.

## Touch points

- `packages/iam/src/repositories/membership.ts` (`listAppMemberGrants`), `packages/iam/src/membership.ts`
  (`appMemberPage`).
- `packages/iam/src/repositories/grants.ts` (`createDelegatedRoleGrant`), `packages/iam/src/admin/app-people.ts`.
- `packages/iam/src/__tests__/app-people.test.ts`, `app-people-postgres.test.ts`.

<!-- Origin: the review of batch J (backlog 126, 139, 141, 156), findings 3 and 4. -->
