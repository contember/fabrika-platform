---
id: 91
title: Add an organizational directory and group-based entitlements to IAM
blocked-by: []
---

# 91 — Add an organizational directory and group-based entitlements to IAM

**Summary.** Evolve the single-organization IAM into a source-aware directory with an organizational-unit tree, access groups, and group role assignments while preserving direct grants and flat app-owned scopes.

## Problem

IAM currently models only `user` and `service` principals. A user has one email and one unqualified OIDC `external_id`, and authorization resolves from grants attached directly to that principal plus the bootstrap role (`packages/iam/src/db.ts`, `packages/iam/src/resolve.ts`). The app-owned scope model is deliberately flat and opaque; an `organization` or `team` scope value is not an IAM-owned directory object and has no hierarchy (`packages/auth-core/src/types.ts`).

The initial schema contained login-time IdP group-to-role mappings, but migration `packages/iam/migrations/0007_drop_group_access.sql` removed them when native IAM sessions stopped carrying IdP groups. Some `group:${string}` permission-source and IAM UI wording remains, but there is no durable group, membership, lifecycle, provenance, or organizational model behind it.

This prevents IAM from representing joiner/mover/leaver state, departments and teams, reusable access groups, or externally synchronized directory data. Reintroducing transient IdP group claims directly into permission resolution would recreate the removed model without solving those lifecycle and provenance gaps.

## Approach / acceptance

Before implementation, record the authorization-model decision in an ADR and design the administration contract. Preserve these boundaries:

- One Fabrika installation represents one organization. Do not introduce tenant rows or a `tenant_id` dimension.
- A principal remains an actor that may authenticate. A group or organizational unit is not a principal and cannot own sessions, credentials, or audit actions.
- Organizational units form a strict tree and describe where a person belongs. Unit ancestry grants no authority and moving a person between units does not change permissions.
- A user has at most one active primary organizational placement, with placement history retained. Service principals remain outside the people directory.
- Users may hold any number of direct access-group memberships. V1 has no nested or dynamic groups.
- Effective permissions are the union of active direct grants, active group role assignments, and bootstrap permissions. Existing allow-only, wildcard, expiry, app, and flat-scope semantics remain unchanged.
- A group assignment names a role or custom policy; it does not carry inline permissions. It may retain the current app and optional `(scope_type, scope_value)` dimensions.
- App scope answers where an action applies. Group membership answers who receives the role. IAM must not equate an organizational unit or group with an app-owned scope value.
- Access tokens carry only the resolved permission snapshot, not the organizational tree or complete group roster. Group-derived entries use a stable group id as their provenance. Membership changes take effect within the existing access-token TTL.
- OIDC claims do not directly grant group authority. External group and organizational data must first become durable, auditable IAM state.

Use an additive first implementation rather than replacing `grants` with a polymorphic subject abstraction. Add source-aware directory capabilities such as:

- `directory_sources` with a built-in local source and stable external-source identities;
- `org_units` and historical `org_placements`;
- `groups` and direct `group_memberships`;
- `group_role_assignments`, parallel to existing direct grants but restricted to named roles.

Each imported object and membership has one owning source. Locally owned records are editable. Externally owned records are read-only; a local exception is a separate local membership or group rather than a mutation of imported state. A failed or incomplete synchronization never treats absent rows as deletions. Authentication-provider identity and provisioning-source identity stay separate; extracting the current `principals.external_id` into provider-qualified identity bindings is a later phase, not a prerequisite for the first directory slice.

Deliver the work in reversible vertical slices:

1. Manually managed groups, memberships, role assignments, permission resolution, audit, admin RPC, and console views.
2. Organizational units and primary placement history, with no authorization inheritance.
3. One concrete external provisioning integration after its source and reconciliation semantics are known.
4. Provider-qualified login identities only when multiple IdPs or account linking are required.

Acceptance:

- A user receives an app role through a group and loses it no later than the expiry of an already-minted access token after membership or assignment removal.
- Direct grants continue to resolve unchanged, including app, scope, expiry, custom policy, and cross-app built-in-role behavior.
- Moving a user between organizational units does not change effective permissions.
- Principal detail explains group-derived permissions by stable group identity, and the existing app people directory includes users authorized only through a group.
- Group, membership, placement, assignment, and sync-origin changes produce IAM audit events with the human or service actor and source provenance.
- Externally managed rows cannot be overwritten through local administration, and an incomplete sync cannot deactivate unseen members.
- New immutable D1 and Postgres migrations produce the same schema outcome; repository behavior tests pass against both backends.
- Authorization still runs through the existing IAM resolution and short-lived token path. No second gate evaluator or proxy state is introduced.

## Out of scope

- Multiple organizations or tenants in one IAM installation.
- Permission inheritance through the organizational tree.
- Nested groups, dynamic membership rules, deny policies, and delegated organizational administration.
- A generic SCIM connector before a concrete provider and deletion/reconciliation contract are selected.
- Arbitrary HR profile fields or placing directory data into every access token.

## Touch points

- `docs/decisions/`
- `packages/auth-core/src/types.ts`
- `packages/auth-core/src/token.ts`
- `packages/iam-contract/src/index.ts`
- `packages/iam/migrations/`
- `packages/iam/migrations-postgres/`
- `packages/iam/src/db.ts`
- `packages/iam/src/resolve.ts`
- `packages/iam/src/tokens.ts`
- `packages/iam/src/admin/`
- `packages/iam-ui/src/`

<!-- Origin: design discussion on extending Access into an IdM-like organizational directory. -->
