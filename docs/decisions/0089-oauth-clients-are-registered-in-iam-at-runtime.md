---
id: 0089
title: OAuth clients and external applications are registered in IAM at runtime
status: proposed
date: 2026-11-25
---

# 0089 — OAuth clients and external applications are registered in IAM at runtime

## Context

IAM's OAuth authorization server serves operator-registered clients only ([ADR-0049](0049-author-applications-through-mcp-in-control.md)
rule 2). The list was made for MCP authoring clients, so it is the deploy variable `FABRIKA_PLATFORM_MCP_CLIENTS_JSON`,
and an entry that is not identity-only turns MCP authoring on. [ADR-0084](0084-an-external-application-signs-people-in-through-iam.md)
reused the list for external applications: applications outside the installation that sign people in through IAM and
receive their roles there, bound to an identity resource of their own.

So every new external application, redirect URI or role is a change to a deploy variable followed by a platform
deploy. The deploy writes the list into IAM's boot configuration (`OAUTH_CONFIG`, at most 16 clients; on Cloudflare a
Worker variable of at most 5,120 bytes, a few clients) and reconciles the roles with the provisioning key. The person
who grants an external application's roles, an IAM administrator, cannot register it; the operator who can must deploy.
The name says MCP for something that is not.

An external application has no deploy target. Nothing of it is Delivery's: no repository, no environment, no run. What
it has is IAM's: an app id, a vocabulary of roles, a resource, and OAuth clients.

## Decision

1. **An external application is a record in IAM's database.** It holds the app id, its identity resource, whether a
   person needs one of its roles to sign in, and its display name (`app_presentation`, as for a contract application).
   Its roles are its vocabulary in IAM, each granting no action, written by the reconcile IAM already runs for a
   deploy's schema, in the same transaction as the record. Control keeps no row of it. ADR-0084's rules for the app id
   and the resource are checked when the record is written: a lowercase id without `@`, no platform audience, no app
   whose vocabulary IAM holds for another owner; an `https` resource on none of the installation's hosts and no
   registered resource.
2. **Every managed OAuth client is a row in IAM's database.** A row holds the client id (the URL of its Client ID
   Metadata Document), its label (`claude`, `chatgpt` or `external`, still a label only), its exact redirect URIs, an
   optional metadata URL, and the external application it is bound to. A client bound to an external application is
   served that application's identity resource alone, as ADR-0084 decides. A client bound to none is an MCP authoring
   client, served `/mcp` as ADR-0049 decides. An external application may have several clients and one list of roles.
   IAM reads the client at each authorization request, code exchange and refresh; nothing else about the flow changes.
3. **An installation administrator registers them at runtime.** IAM's `/admin/rpc` serves `externalApps.list | get |
   put | delete` and `oauthClients.list | put | delete`, each requiring `iam.admin`. `externalApps.put` replaces the
   whole application (record, roles, clients) in one transaction with its audit record. Removing a client, or the
   application, revokes its OAuth grants in that transaction. The console registers them on a page of its Access
   section, reached also from the Applications page; the `fabrika` CLI does it with the provisioning key
   (`fabrika control external-apps`), from a file, idempotently. A user administrator grants the roles, as before, and
   registers nothing.
4. **Whether MCP authoring is on is a deploy setting of its own.** It decides the proxy's `/mcp` row and Control's
   mount, so it is composition: `FABRIKA_PLATFORM_MCP_AUTHORING`. A registered authoring client on an installation
   with authoring off is served no resource.
5. **The deploy variable is read for one release, then refused.** In the release that introduces the registry, the
   deploy hands the variable to IAM's `oauthClients.importOnce`, which only the provisioning key may call. IAM writes
   every entry and an import mark in one transaction, adopting the roles earlier deploys reconciled under the same app
   ids, and answers every later call `already_imported` without writing. Until the mark exists IAM serves the clients
   of `OAUTH_CONFIG`; from then on the registry only. From the next release, a deploy that still sets the variable is
   refused before it deploys anything, and `OAUTH_CONFIG` carries resources only.

Per-application OAuth resources, tokens a deployed application accepts, are not part of this decision: they need
`oauth` rows on contract application entries in the proxy ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)),
a caller kind in the framework, and a protocol change an older framework release must tolerate
([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)), and which endpoints admit them is the
application's approved contract, not runtime data. A client allowed to call an application's API would be one more
kind of client row.

**Invariant:** IAM reads the OAuth clients it serves from its own database, and only an installation administrator or
the provisioning key writes them.

## Consequences

- An external application is registered, changed and removed without a deploy, by the IAM administrator, with no size
  cap. A change applies to the next authorization request, exchange or refresh; a removed client or a changed resource
  ends the existing sign-ins within one token lifetime (300 s).
- One external application with several clients has one list of roles; ADR-0084's "two clients of one app must declare
  the same roles" check goes away.
- IAM reads a database row per OAuth request instead of its configuration; those requests are rare.
- The roles reconcile of external applications leaves the deploys; the deploy reconciles only installation and
  application vocabularies.
- "MCP" names only what is MCP: `/mcp`, its authoring clients and the switch. The code's `McpClient`,
  `parseMcpClientsJson` and `reconcileIdentityApps` are removed with the variable.
- **Rollout.**
  - IAM's migrations add tables only; a release before this one ignores them.
  - In the release that introduces the registry the deploy still writes the variable's clients into `OAUTH_CONFIG`
    (`FABRIKA_IAM_OAUTH_CONFIG` on Zerops), so rolling IAM back keeps every client, and calls `importOnce` (on
    Cloudflare in the control-plane stage, where the roles reconcile ran). It warns while the variable is set. MCP
    authoring is on with the new setting, or, in that release only, with an authoring entry in the variable.
  - In the next release the deploy refuses a set variable and names both ways out: register the clients in the
    console, or upgrade through the previous release. `platform upgrade` regenerates Cloudflare's `platform.yml`
    without the variable's two lines. The operator deletes the GitHub Environment variable.
  - An installation without the variable has nothing to migrate. Grants of an external application's roles keep
    working: the import keeps the app id and the role keys.

## Alternatives considered

### A Control application of kind `external`

Rejected. Control's application row requires a repository, and every deploy, run, webhook and workspace path reads it,
so an application Delivery never touches would spread through Delivery. The record would live in two stores written
by one use case, and Control's `app.manage` would decide where IAM sends people's identity, a decision IAM's
administration owns.

### Keep the deploy variable, renamed

Rejected. Every change still needs a deploy by the operator, and the Worker variable's size still caps the list.

### Move the external applications only, keep authoring clients in the variable

Rejected. IAM would read clients from two sources for good, and the variable would stay. The authoring clients
cost one column and the explicit switch.

### Import the variable on every deploy

Rejected. After the import the registry is the source; a stale variable would undo an administrator's edit or delete.

### Open dynamic client registration (RFC 7591)

Rejected, as in ADR-0049: an administrator decides which applications receive people's identity.
