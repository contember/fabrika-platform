---
id: 0089
title: OAuth clients and external applications are registered in IAM at runtime
status: accepted
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

1. **An external application is a record in IAM's database.** It holds the app id, its identity resource and its
   display name (`app_presentation`, as for a contract application). Its roles are its vocabulary in IAM, each granting
   no action, written by the reconcile IAM already runs for a deploy's schema, in the same transaction as the record.
   An application with roles requires one of them to sign in (ADR-0084 rule 4); one without roles has no vocabulary,
   and every active user signs in. Control keeps no row of it.
   - The app id is lowercase, has no `@` and is no platform audience. Registering an id under which IAM already holds a
     vocabulary adopts it only when it has the shape an earlier deploy's reconcile of an external application wrote:
     roles alone, each granting no action, no scope and no action declared, and no registered return origin. Any other vocabulary refuses the id.
   - The resource is `https`, is no registered resource, and is on none of the installation's hosts. The deploy writes
     those hosts into `OAUTH_CONFIG` (`hosts`), the list its own check reads today, so IAM checks a write against
     the same list.
2. **Every managed OAuth client is a row in IAM's database.** A row holds the client id (the URL of its Client ID
   Metadata Document), its label (`claude`, `chatgpt` or `external`, still a label only), its exact redirect URIs, an
   optional metadata URL, and the external application it is bound to. A client bound to an external application is
   served that application's identity resource alone, as ADR-0084 decides. A client bound to none is an MCP authoring
   client, served `/mcp` as ADR-0049 decides. An external application may have several clients and one list of roles.
   IAM reads the client at each authorization request, client authentication, code exchange and refresh; nothing else
   about the flow changes.
3. **An installation administrator registers external applications at runtime; the operator registers authoring
   clients.** IAM's `/admin/rpc` serves `externalApps.list | get | put | delete`, each requiring `iam.admin`.
   `externalApps.put` replaces the whole application (record, roles, bound clients) in one transaction with its audit
   record, and is the only writer of a bound client. Removing a client, or the application, revokes its OAuth grants in
   that transaction. `oauthClients.put | delete` writes an authoring client and accepts only the provisioning key. Each
   writer refuses a client id the other one owns, so neither takes over the other's row. Authoring clients stay the
   operator's because an authoring client's tokens reach `/mcp`, which only the operator may hand out today. The console
   registers external applications on a page of its Access section, reached also from the Applications page, and lists
   authoring clients read-only. The `fabrika` CLI does both with the provisioning key (`fabrika control external-apps`,
   `fabrika control oauth-clients`), from a file, idempotently; an installation administrator registers external
   applications with it through a one-hour `admin` device grant instead
   ([ADR-0049](0049-author-applications-through-mcp-in-control.md) rule 2). A user administrator grants the roles, as before, and
   registers nothing.
4. **Whether MCP authoring is on is a deploy setting of its own.** It decides the proxy's `/mcp` row and Control's
   mount, so it is composition: `FABRIKA_PLATFORM_MCP_AUTHORING`. A registered authoring client on an installation
   with authoring off is served no resource.
5. **The deploy variable is imported once, then refused.**
   - In the release that introduces the registry (N), every deploy calls IAM's `oauthClients.importOnce` with the
     variable's entries, or with none when it is unset, and fails when the call fails. Only the provisioning key may
     call it. The first call writes every entry, the vocabularies they declare and an import mark in one transaction;
     every later call answers `already_imported` and writes nothing. Release N's deploy no longer reconciles external
     applications' roles: the import replaces that step.
   - In release N only, until the mark exists, IAM serves the clients of `OAUTH_CONFIG`, as before, and refuses
     `externalApps.put` and `oauthClients.put`; from then on it serves the registry only.
   - From release N+1 a deploy that still sets the variable is refused before it deploys anything. The generated
     workflows keep passing the variable to the deploy through N+1, so the refusal sees it, and drop it in N+2.
   - Release N+1 removes the import, the reads of the mark and the `OAUTH_CONFIG` client path: IAM serves the registry
     only and accepts registry writes whether or not an import ever ran, so an installation that skipped release N
     registers its applications in the console. The mark's table stays, unread, so a rollback to release N finds it.

Per-application OAuth resources, tokens a deployed application accepts, are not part of this decision. Which
endpoints admit them is the application's approved contract, not runtime data, so
[ADR-0090](0090-a-device-grant-reaches-an-application-as-the-person.md) decides them: an application environment is a
resource of the built-in device client `agent-cli`, with no client row.

**Invariant:** IAM reads the OAuth clients it serves from its own database. Only an installation administrator writes an
external application and its clients; only the provisioning key writes an authoring client.

## Consequences

- An external application is registered, changed and removed without a deploy, by the IAM administrator, with no size
  cap. A change applies to the next authorization request, exchange or refresh; a removed client or a changed resource
  ends the existing sign-ins within one token lifetime (300 s).
- One external application with several clients has one list of roles; ADR-0084's "two clients of one app must declare
  the same roles" check goes away. An application whose roles are dropped loses its vocabulary instead of keeping the
  last one unnamed.
- IAM reads a database row per OAuth request instead of its configuration; those requests are rare.
- The roles reconcile of external applications leaves the deploys; the deploy reconciles only installation and
  application vocabularies.
- "MCP" names only what is MCP: `/mcp`, its authoring clients and the switch. The code's `McpClient`,
  `parseMcpClientsJson` and `reconcileIdentityApps` are removed with the variable.
- **Rollout.**
  - IAM's migrations add tables only; a release before this one ignores them. `OAUTH_CONFIG` gains `hosts`, which an
    older IAM refuses at boot, so a rollback must be a deploy of the older release, which writes its own
    `OAUTH_CONFIG`, never a re-activation of an older service version alone (as ADR-0084 says for its key).
  - Release N: every deploy imports once (on Cloudflare in the control-plane stage, where the roles reconcile ran; on
    Zerops in the installation deploy) and warns while the variable is set. It still writes the variable's clients
    into `OAUTH_CONFIG` (`FABRIKA_IAM_OAUTH_CONFIG` on Zerops). MCP authoring is on with the new setting, or, in
    release N only, with an authoring entry in the variable.
  - Rolling back to N-1 serves the variable's clients only while the variable is still set, and N-1's deploy
    reconciles the variable's roles over whatever the registry holds. So the operator keeps the variable until release N
    is accepted on the installation, then deletes it; a roll back and forward after an administrator's edit can leave
    the registry and IAM's roles apart, and the administrator saves the application again.
  - Release N+1 refuses a set variable and names the ways out: upgrade through release N first; or delete the
    variable, deploy N+1 and register the applications in the console (which adopts their roles), with their sign-ins
    failing until then; and set `FABRIKA_PLATFORM_MCP_AUTHORING` where authoring was on. `OAUTH_CONFIG` carries no clients. Release N+2 removes the variable's line from both generated workflows:
    `platform upgrade` regenerates the Zerops sidecar's, and re-running `platform init` refreshes Cloudflare's
    `platform.yml`.
  - An installation without the variable gets an empty import and nothing else. Grants of an external application's
    roles keep working: the import keeps the app id and the role keys.

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
