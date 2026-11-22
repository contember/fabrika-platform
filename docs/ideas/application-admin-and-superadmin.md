# Granting an application's Admin, and an installation-level application administrator

**TLDR.** IAM refuses the built-in `admin` role (`*`) at a contract application on purpose: a wildcard would hold
actions the approved contract never declared. Part 1 keeps that guarantee and still makes `admin` grantable: at a
contract application `admin` resolves to exactly the actions its approved contract declares, for a person only. It is
safe and small; it is implemented on the same branch and waits for this card before merging. Part 2, an
installation-level superadmin, is a real widening of ADR-0022 rule 6; the recommendation is the cheaper "Grant me
Admin here" console button on top of Part 1 first, and an `iam.apps.admin` action on IAM's own vocabulary only if
per-application grants prove to be real friction. The user decides the questions at the end.

## Where the refusal is and why it exists

The refusal is `contractGrantProblem` in `packages/iam/src/contract-rules.ts`, called by every IAM grant write path
(`grants.create`/`update`, `apiKeys.provision`, membership assignment and scope creation, `appPeople.grant`). It
refuses, at a **contract application** (one whose IAM schema carries `contract: true`), any wildcard in a grant:
inline, through a declared or custom role, or through the built-in `admin` (`BUILTIN_ROLES.admin = ['*']`,
`packages/iam/src/roles.ts`).

The rule is ADR-0022 rule 6, "Exact actions on every write path": _"IAM refuses a wildcard action on every write
path, and resolves none … so no grant tracks the catalog beyond the approved revision."_ Resolution is the second
lock: `computeAuthority` (`packages/iam/src/resolve.ts`) drops every entry containing `*` at a contract application
(`exactActions`), so an `admin` grant there would resolve to nothing even if it were written. Migration
`0027_application_exact_actions.sql` was the preflight that refused while such a row existed.

What `*` would mean in an application token, and the risks it guards:

1. **Undeclared actions.** The application checks `permits(perms, action)` in its own code (`.require`, `can()`). A
   token carrying `*` satisfies any action string the code checks, also one the approved contract never declared:
   code deployed ahead of its approval, a `can('x')` inside a handler, a typo. With exact actions the token
   carries only what the approved snapshot (ADR-0050) declares.
2. **Public procedures.** The schema parser refuses a contract where a role grants an action held by a public
   procedure (`packages/auth/src/app-schema.ts`): _"a public action is held by no role"_, so a role change cannot
   widen what anyone may cause through an unauthenticated endpoint. `*` would match those actions.
3. **Keys that grow.** A key lists exact actions of its app's catalog so it "never grows when the app declares
   more" (IAM `CLAUDE.md`). A service principal holding `*` would grow with every release.

## Part 1 — the Admin role of a contract application

### Proposal

At a contract application, the built-in `admin` resolves to **the actions the application's approved schema declares
(`app_actions`), minus the actions of its public procedures (`app_workloads` of kind `public`)**, at the grant's scope.
It applies only to a **user** principal (an internal one: an external principal already holds no built-in role,
ADR-0051). Everything else keeps the refusal:

| Grant at a contract application                      | Today   | Proposed                                  |
| ---------------------------------------------------- | ------- | ----------------------------------------- |
| built-in `admin` to a person                         | refused | allowed; resolves to the declared actions |
| built-in `admin` to a service principal (an API key) | refused | refused (a key never grows)               |
| inline `*` / `prefix.*`                              | refused | refused                                   |
| a declared or custom role listing a wildcard         | refused | refused                                   |
| `admin` through `appPeople` or a membership write    | refused | refused (built-ins are never delegated)   |
| `admin` to an external principal                     | refused | refused (ADR-0051)                        |

### Why it is safe

- **Risk 1 is closed:** the token carries named actions of the approved catalog, never a pattern; `permits` sees no
  `*`. `app_actions` is written only by the schema reconcile from the approved snapshot.
- **Risk 2 is closed:** public-procedure actions are left out, the same rule the parser applies to declared roles.
- **Risk 3 is closed:** only a person holds it; `apiKeys.provision` and `grants.create` on a service principal keep
  the refusal. A user's own `px_` key is narrowed by its own exact inline grants, as today.
- **What remains, and is the definition of an admin:** an `admin` grant gains a newly approved action without a grant
  change. Today the same person would hold it only once a role listing it is granted. A plain widening publishes
  without a human approval (ADR-0050), so a new action reaches admins unreviewed; it is still an action of the
  approved contract, which the reviewer of the approval diff sees.
- **Delegation follows.** An admin holding the app's `members.manage` globally may use `appPeople` to grant declared
  roles whose actions it holds; that is the existing rule, now satisfiable by the admin.
- **No protocol change.** The token carries ordinary entries with source `grant`; no new claim, no framework change.

### Rollout and rollback

No migration, no environment variable, no generated file. An existing installation converges when IAM is deployed.
Rollback: an older IAM resolves such a grant to nothing (fail-closed); migration 0027 has already run and is not
re-applied, so a rollback does not stop on these rows.

### Token size

Each action is one entry, `{"action":"<action>","scope":null,"source":"grant"}`: 42 bytes plus the action name. The contract-application bound
is 24 KiB (`MAX_APPLICATION_TOKEN_BYTES`); measured on this branch, see the PR. An application with several hundred
actions would answer `token_too_large` (403) for an admin, as it would for a person holding every role.

### Cheaper alternative

Do not change IAM: the console's grant dialog stops offering `admin` at a contract application (backlog 231, trap 4),
and an administrator grants each declared role. Cost: several grants per person per environment, and a role the
contract adds later is not held until granted. It does not give "the Admin role as is".

## Part 2 — an administrator of every application

### What exists today

- `IAM_BOOTSTRAP_ADMINS` (environment) and cross-app grants (`app` NULL) give `admin` only at **platform
  audiences** (IAM, the console, Operations, admin gateways), never at an application: ADR-0022 rule 6, _"An
  application token carries only grants of that application id"_. `iam.admin` administers IAM, which lets its holder
  grant themselves anything, but holds no application action.
- So today an installation administrator can always reach an application, in two steps: grant, then sign in.

### Options

| Option                                                                             | Who holds it, how                                                                                                                                                                                                                                                                   | Apps and audit see                                                                                                                                                                                                                              | Cost                             | Verdict                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E. "Grant me Admin here" button** (cheapest)                                     | An installation administrator (or a user administrator for an app in scope) presses it on an application environment in the console; it issues a normal `admin` grant to themselves through `grants.create`, with an optional expiry (none / 8 h / 7 days). Revoked like any grant. | A normal grant: listed with the application's people, `iam.grant.create` in the audit.                                                                                                                                                          | ~2 h after Part 1                | **Recommended now**                                                                                                                                                                                                   |
| **A. `iam.apps.admin` on IAM's vocabulary**                                        | A new action and role ("Application administrator") in `IAM_APP_SCHEMA`, granted at `propustka` globally (every application) or in `app` values (`opice@prod`), like `iam.users.manage`. Granted and revoked only by `iam.admin`, through the existing grants UI, with expiry.      | Resolution at an application adds Part 1's admin set for a holder; each mint that carried it writes an `audit_events` row under the application before the token is returned (503 if it cannot). Tokens carry ordinary entries, source `grant`. | ~4–6 h, plus an ADR-0022 rewrite | If E proves too much friction                                                                                                                                                                                         |
| B. Bootstrap admins reach applications                                             | The `IAM_BOOTSTRAP_ADMINS` list.                                                                                                                                                                                                                                                    | Source `bootstrap`; no grant row anywhere.                                                                                                                                                                                                      | ~1 h                             | Rejected: configuration only, no console revoke, no expiry, invisible per application                                                                                                                                 |
| C. A cross-app (`app` NULL) `admin` grant reaches applications                     | Any installation administrator writes one.                                                                                                                                                                                                                                          | Nothing per application.                                                                                                                                                                                                                        | ~2 h                             | Rejected: reopens rule 6 for every cross-app grant shape; a NULL grant written for platform audiences silently gains every application                                                                                |
| D. A bypass in authorization (a `superadmin` claim the proxy or framework honours) | —                                                                                                                                                                                                                                                                                   | A new claim.                                                                                                                                                                                                                                    | —                                | Rejected: a second enforcement decision (ADR-0022) and a protocol change; an older framework's token parser refuses an unknown `src` value (`parseSource`, `packages/auth-core/src/token.ts`), which ADR-0062 forbids |

### What option A must never do

- reach an external principal, a service principal, a workload, a `px_` key, a share link, or an OAuth/MCP resource
  token: only a token minted from a signed-in session (`mintToken`), as `appPeople` and user administration already
  require;
- carry an action the application does not declare, or a public procedure's action (Part 1's set, nothing more);
- be granted or revoked by a user administrator, by `appPeople`, by a membership write or by an application;
- be a second enforcement point: the proxy and the framework see ordinary exact actions;
- reach a platform audience beyond what `iam.admin` already reaches there;
- go unrecorded: without its audit row the mint fails.

Option A's per-use audit row is the one thing E cannot give (E records the grant, not each sign-in; IAM's `auth_log`
records each login and mint either way). A holder of A is not listed with an application's people; the console would
show "application administrators of the installation" beside them.

## Questions for the user

```form
type: choice
id: part1
label: Part 1 — at a contract application, the built-in Admin resolves to every action its approved contract declares (minus public-procedure actions), for a person only. Approve?
required: true
options:
  - {value: approve, label: Approve, description: merge the implementation on this branch}
  - {value: dialog-only, label: Hide Admin instead, description: the cheaper alternative; Admin stays refused and the dialog stops offering it}
```

```form
type: choice
id: part2
label: Part 2 — an administrator of every application
required: true
options:
  - {value: button, label: "E: Grant me Admin here button (recommended)", description: a normal per-app grant with an optional expiry; no new IAM authority}
  - {value: iam-apps-admin, label: "A: iam.apps.admin on IAM's vocabulary", description: one grant reaches every application or chosen ones; each use audited; ADR-0022 rule 6 rewritten}
  - {value: both, label: Both, description: E now, A as a follow-up}
  - {value: none, label: Neither, description: Part 1 alone; grant Admin per application in the existing dialog}
```

```form
type: choice
id: expiry
label: Default expiry of a self-granted Admin (option E) or an iam.apps.admin grant (option A)
options: [none, 8 hours, 7 days]
```
