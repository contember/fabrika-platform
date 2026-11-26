---
id: 0085
title: A grant holds a set of scope values, picked from the values the application lists
status: accepted
date: 2026-11-24
---

# 0085 — A grant holds a set of scope values, picked from the values the application lists

## Context

A scoped grant names one dimension and one value (`scope_type`, `scope_value`). A key that may act in four
organisations needs four grants, added one by one in the console, and each value is typed into a free text box. IAM
treats a value as opaque and never checks it ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md) rule 6), so a
typo surfaces only later, as data the key cannot see.

The application knows its values; IAM and the console do not. Some sets are fixed in the code (a region, a tenant
configured at build time), others are created at run time (an organisation a person creates).

What a grant gives is read in many places: permission resolution and the token, the membership operations, the
assigner and delegation checks, the unique indexes that refuse a duplicate role grant, the authority deadlines. Each
reads one `scope_value` per row, on two SQL engines.

## Decision

### 1. A grant holds a set of values of one dimension

A grant with a scope holds one or more values of one dimension. IAM stores it as one `grants` row per value. The rows
of a grant with more than one value share `scope_set`, the grant's id; a grant of one value keeps `scope_set` NULL,
which is every grant written before this decision, so those stay as they are.

Each row is an ordinary grant. Resolution gives one token entry per value, so the proxy and the application see what
they saw for separate grants: a request matches when its value is one of the set. Nothing that reads grants changes,
and the token, the manifest and the framework do not change either.

The administration API treats the set as one grant: `grants.create`, `grants.update` and `apiKeys.provision` take
`scopeValues`, `GrantDto` answers `scopeValues` (sorted) beside `scopeValue` (its first value, for older readers), and
one change of the set writes one audit record in its own transaction. A grant's id is the id of its set
(`COALESCE(scope_set, id)`), so an edit keeps it. A set holds at most `MAX_GRANT_SCOPE_VALUES` (100) values. Two role
grants of one principal still may not share a value: that is the duplicate the unique index refuses, answered 409.

Where an application's grants wait for a second administrator
([ADR-0083](0083-an-environment-chooses-what-waits-for-approval.md)), a change of a set is one request: it carries every value,
grants none of them while it waits, and its approval writes, replaces or revokes the whole set in the transaction that
claims it, or nothing.

### 2. The application lists a dimension's values in its contract

A dimension may declare `values: [{ value, label? }]` in the vocabulary, a static list. The artifact carries it only
when declared, so no existing digest changes; IAM's schema reconcile stores it per scope; the console reads it with the
application's schema. The approval diff shows a change of the list as a neutral line: the list decides nothing.

The list is information for the person who grants, not authorization. IAM does not refuse a value outside it: a value
may exist before the next deploy lists it, and a grant may outlive the value.

A dimension whose values are created at run time names a procedure of the application instead, or beside the list
(section 4).

### 3. The console offers the listed values as checkboxes

The grant form offers one checkbox per listed value, with its label. When the application lists no values, the form
falls back to free text, one value per line, under a visible warning that nothing checks the values. A value the grant
holds that the application no longer lists is shown checked and flagged; it goes only when the administrator unchecks
it, never silently.

### 4. The application answers a dimension's values to the administrator who grants

A dimension may name a procedure of its own contract, `valuesFrom: '<endpoint id>'`. The build refuses one that is not
a query, admits no person (`human`), does not require an action `over` that dimension, requires the dimension's
`members.manage` (a key carrying it would carry a membership delegation into a call that only reads), takes an input,
or answers anything but `{ values: [{ value, label? }] }` under the bounds of the static list. `schemaFromContract` hands IAM the
procedure's id, path and action (`AppScopeDef.valueSource`), and IAM stores them with the dimension.

When the console's grant form opens such a dimension, it asks IAM (`scopeValues.list` of `/admin/rpc`) and never the
application itself. IAM:

1. Admits only a person signed in to the console (`session` mark) whose administration covers the application
   (`requireManagedApp`: an installation administrator, or a user administrator of that application, never one of the
   installation's own applications). A `px_` key, presented or exchanged, is refused, as for every administration
   through the console's gateway.
2. Issues a self-bound `px_` key of that person: bound to the application id, expiring in 60 s, whose inline grants are
   exactly the person's entries of the procedure's action at the application (one global entry, or each scope the
   person holds it in). A person who holds the action nowhere gets no key and the answer `not_held`. Like every
   self-bound key, its grants only narrow the person's live permissions at each mint, so the key never carries more
   than the person holds then, and nothing at another application. The key and an `iam.scope_values.read` record
   naming it are written in one transaction.
3. POSTs `{}` to the procedure's path on the application's registered return origin, its public origin, so the call
   reaches the application's proxy like any other request. Only an environment with exactly one registered origin, on
   `https` (`http` only in a local IAM), gets the call; anything else is `no_origin`,
   so a dev environment with several sandboxes is not asked, and one with a single sandbox is asked through that
   sandbox's proxy. That origin is where the administrator's key goes, so on a protected environment only a person changes
   it (Control's `requirePersonToPointPublicOrigin`, beside the domain's guard). The proxy exchanges the key with
   `mintFromKey`, selects the row and checks its requirement: the proxy stays the only enforcement point, and nothing
   about it changes. The request carries the key as a bearer, follows no redirect, and is cut after 3 s and 256 KiB.
4. Parses the answer once, with the rule the build applied to the declared list, and answers the console
   `{ source: 'application', values }` or `{ source: 'unavailable', reason }`: no source, the action not held, no
   registered origin, refused (401, 403, 404), timeout, unreachable (any other status, a redirect, a network error) or
   malformed. IAM never answers an error for the application's failure.

The application answers what that person may see: the handler reads `ctx.within.values` as for any procedure `over`
the dimension, and labels them from the dimension's own table, which `ctx.db.within` lists under `over` that dimension. The console shows the application's values as checkboxes. When IAM answers `unavailable`, it shows the
declared list, or free text without one, under a warning naming the reason. A value the grant holds and the answer
does not list is flagged as in section 3, never dropped. The answer is information, like the static list: IAM still
grants a value neither lists.

## Consequences

- A key for several values is one grant, one form, one audit record, one revocation.
- Every reader of grants stays correct by construction: a membership revoke of one value, an assigner check in one
  value or an expired row renewed by an assignment acts on that value's row, and the set shrinks or changes with it.
  The console groups rows by `scope_set`; a row an assignment renewed may expire later than the rest of its set, and
  the console shows the set's latest expiry, so a set reads as expired only once none of its values grants anything.
- A set multiplies token entries like separate grants do; the token bounds of ADR-0022 rule 6 apply unchanged, and the
  cap keeps a set from being the one thing that outgrows them.
- A static list changes only with a deploy of the application. A dimension whose values are created at run time
  names a procedure, and the console lists what the application holds when the form opens.
- Opening such a form issues one short-lived key per dimension and asks the application once, as the administrator.
  The key is written to IAM's credential table and expires there after 60 s (its row stays, as every expired key's does); it is not revoked after the call,
  because a revocation would be a second write per form and the key's token cannot outlive the key. Its token
  carries no `session` mark, so it administers nothing at IAM, and the proxy refuses it at every other application.
  The application sees the administrator as an ordinary signed-in caller of one procedure: its own audit, if it keeps
  one, records that read.
- IAM makes an outbound request to an application's public origin, as any client does: on Cloudflare its Worker fetches
  the application's Custom Domain, on Zerops its process the application's public domain. An installation whose IAM
  cannot reach that origin gets `unreachable` and the declared list.
- **Rollout.** IAM's migration adds `grants.scope_set`, `app_scopes.value_list` and `grant_requests.scope_values`, all
  NULL on every existing row; an existing grant reads as a set of one and resolves exactly as before, and an open
  request reads as a request of its one value. `AppSchema.scopes[].values` is optional, so a schema an older framework
  reconciles parses as before and its dimensions fall back to free text; a framework that lists values reconciles them
  on its next deploy. No token, header or manifest row changes, so no application has to
  upgrade or redeploy (ADR-0062). The value source adds `app_scopes.value_source`, NULL on every existing row, and
  `AppSchema.scopes[].valueSource` and the artifact's `valuesFrom` are optional and absent unless declared, so no
  digest changes; a dimension gets a source when a framework that declares one deploys. Until then, and for an IAM
  older than the console, the form shows the declared list or free text: a console whose IAM lacks `scopeValues.list`
  reads the failed call as `unavailable`.

## Alternatives considered

- **A set column on the grant row** (a JSON array beside `scope_value`). Every reader above would need a set-aware
  rewrite on both engines, the membership and assigner queries included, and SQLite cannot change the
  both-or-neither `CHECK` on the scope columns without rebuilding the table. One row per value keeps those readers as
  they are.
- **Keep one grant per value and only add a multi-select to the form.** The console would write N grants that it then
  shows, edits and revokes one by one; an edit of "the key's organisations" would be N independent changes with N
  audit records and no single grant to point at.
- **The console, or Control, calls the application with a token IAM mints for the administrator at the application.**
  The token would travel through the browser or Control, which hold no credential of the person's at any application
  today, and the proxy would need a new way to accept a token it did not mint. IAM issuing a key that never leaves IAM,
  which the proxy exchanges as it exchanges any key, adds no credential form and no enforcement path.
- **IAM calls the application directly, past its proxy.** Applications are not publicly routed, and the call would
  need a second check of the procedure's requirement, which is the enforcement decision ADR-0022 keeps in the proxy.
- **The administrator's whole permission set in the key.** The application would see every action the person holds
  there for a call that needs one. The key carries only the procedure's action.
- **IAM refuses a value the application does not list.** A run-time value would be refused until the next deploy, and
  removing a value from the list would make existing grants unchangeable. The console's flag shows the drift instead.
- **Control projects the one origin the platform proxy serves for the environment**, derived from its person-guarded
  domain, and IAM calls only that. It would take the destination out of the browser return-origin registry entirely,
  but it adds a new fact Control hands IAM and a new reconcile step. IAM keeps reading the registry instead, trusting it
  only with one https origin, and Control guards the public origin as it guards the domain; a registry that holds the
  proxy's origin is the trust that remains.
