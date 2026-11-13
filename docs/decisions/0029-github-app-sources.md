---
id: 0029
title: Operator-owned GitHub Apps deliver application sources
status: accepted
date: 2026-10-07
---

# 0029 — Operator-owned GitHub Apps deliver application sources

## Context

Fabrika deploys application code from GitHub. Public repositories need no credential. Private
repositories need a machine identity that is not a person, is short-lived at the point of use, and can
be limited to selected repositories, each token to the permissions its operation needs. A GitHub App gives
exactly that.

Fabrika runs on two clouds. On Cloudflare, a runner container clones the repository and runs the
build. On Zerops, the native GitHub integration does not help: the OAuth grant made in the Zerops GUI is not
inherited by the installation's project-scoped token, so Fabrika cannot connect a service to a private
repository by API (see [Zerops platform reference](../reference/zerops-platform.md)). Zerops does
accept an uploaded archive: create an application version, PUT the archive to the returned upload
URL, then call `build-and-deploy`. Zerops still runs the build and the deploy.

A private GitHub App can be installed only on the account that owns it, an organization or a personal
account. An operator who deploys private repositories from several accounts therefore needs one App per
account, unless the App is made public — which widens who can install it. GitHub creates an
organization's App from the organization's settings, but a personal account's App on whichever account
is signed in to GitHub: the manifest flow cannot name the personal account.

GitHub's manifest flow returns an App's private key exactly once. Whatever receives it must store it
durably before it reports success, or the App is unrecoverable.

GitHub answers an anonymous caller 60 REST requests an hour per IP address. On Zerops every tenant in a
region leaves through one egress address, so that budget is shared with strangers. A deploy that resolved
the ref (`/commits`), read the descriptor and every snapshot file one by one (`/contents`, after
`/commits` and `/git/trees`) and checked the proxy's tree spent 19 of them for the example application; a
live acceptance run failed deploys and namespace reconciles on the limit. The tarball endpoint does not
count against it: measured on 2026-10-15, `x-ratelimit-used` stayed `0` across tarball requests while
`/commits` and `/contents` each spent one, and the archive's pax header names the commit a ref resolves to.

## Decision

**Ownership.** Each installation uses GitHub Apps that its operator owns. There is no central
Fabrika App and no credential shared across operators. The operator installs the platform and Fabrika
deploys applications ([ADR-0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)).
Both clouds use the one model below; nothing in it depends on the provider.

**Connections.** An installation holds any number of GitHub connections. Each connection is one
private App owned by one GitHub account (an organization or a personal account) plus one verified
installation of that App, keyed by a connection id. The connection records which of the two owns the
App. The case-insensitive owner login selects at most one connection; organizations and personal
accounts share GitHub's one namespace of logins. There is no
connection-count limit; every request, response and page stays bounded. There is no unkeyed or
default connection.

**Custody.** Control holds every connection's App id and private key in its vault
(`packages/control/src/vault.ts`) as platform-scoped, purpose-labelled entries, next to that
connection's webhook secret. Control mints installation tokens in-process when it needs them. The App key is an installation
credential, not an application secret, so the vault does not conflict with
[ADR-0004](0004-secrets-live-in-the-platform.md). No App key is a Worker secret, an environment variable
or an installation-time value: `platform init` creates no App on either cloud. Control, which resolves
sources, holds the App keys and nothing else does.

**Setup from the console.** A fresh installation starts anonymous and deploys public repositories.
A user principal with `source.connection.manage` (service tokens are refused) creates a connection from the console:

1. Control records a bounded, expiring, one-use setup state bound to the administrator, the exact
   Control origin, the owner, its type and the requested repositories. Only one nonterminal setup may
   exist at a time; connected rows do not block a new one.
2. The browser runs GitHub's manifest flow. `@fabrika/github-app` builds the manifest: private App,
   Contents and Pull requests write, the `push` event only, fixed `github.com`. No personal access token
   is ever asked for. Deploys need only Contents read; the write permissions serve MCP authoring
   ([ADR-0049](0049-author-applications-through-mcp-in-control.md)), which commits to workspace branches and
   opens pull requests. Each token is narrower than the App: a deploy mints a repository-scoped token with
   Contents read only, and only a workspace operation mints one with both write permissions.
3. The console's callback requires the principal that started the setup; the handoff callback below requires a
   minted link instead. Either consumes the state once, exchanges the code, and writes the App id and private key
   into the vault **in the same transaction as the setup checkpoint, before it reports success**.

   Only an owner of the GitHub account (an organization's owner, or the person of a personal account) can create its
   App, and that owner is often not the administrator. So the
   administrator who started the setup may mint a **handoff link** for it: a 32-byte token, kept only as its
   SHA-256 on the attempt, which holds the attempt open for the span the administrator chose (an hour unless asked
   otherwise, at most 24 hours) instead of ten minutes. Minting also replaces the one-use manifest state, so a new
   link revokes the one before it and every page already opened with either. Since only one setup may be in
   progress, any person with `source.connection.manage` can cancel a setup that still waits for GitHub to create the
   App: the attempt fails as `cancelled`, its encrypted state is deleted, and its link, console page and callback
   stop working at once.

   The owner opens the link in their own browser, with no console account. The token rides in the URL's fragment,
   which no browser sends, so it reaches no request log on either cloud. Four `protocol` rows serve that browser,
   each authenticating by the attempt's own secrets rather than a caller: `GET /api/source/github/handoff/:connectionId`
   is a page with no secret that posts the fragment's token to the same path; the `POST` checks it and answers a
   manifest whose redirect and setup URLs name the other two; `/api/source/github/handoff-callback` accepts the
   one-use state alone, and only for an attempt with a minted link; `/api/source/github/handoff-setup/:connectionId`
   runs the setup verification of step 5, which never trusted the caller anyway, and only for such an attempt.
   Their refusals are pages for the owner, never the console's JSON. The link is spent once the callback claims the
   state. The minting is audited; the steps the owner's browser drives have no principal to audit, and the
   connection's `connected_by` names the administrator who started and handed off the setup. Whoever holds the link
   gets a connection only for an App on the account the administrator named, which GitHub creates only for someone
   allowed to (an organization's owner, or the personal account itself); the callback refuses an App on any other.
4. Control generates a webhook secret, stores it in the vault, configures the App's webhook to
   `/webhooks/github/:connectionId`, and verifies the App identity (owner, visibility, permissions,
   events) with the stored key. An App GitHub created on another owner than the setup asked for fails
   the setup and leaves the vault, with its own code so the console says what to fix:
   `app_owner_not_organization` when an organization's App landed on a personal account (the person may
   not create Apps in the organization, or mistyped it), `app_owner_mismatch` when a personal account's
   App landed on another account (the person was signed in as someone else). GitHub masks the secret, so readback proves only URL, JSON content
   type and TLS verification.
5. The callback sends the browser straight on to the App's installation page. The manifest names
   `/api/source/github/setup/:connectionId` as the App's setup URL, with redirect on update, so GitHub
   returns the installer to Control. Control treats the returned `installation_id` as a hint: anyone can
   send that URL. It requires an authenticated principal with `source.connection.manage`, verifies the
   installation for the owner (`/orgs/{org}/installation` or `/users/{user}/installation`) or for the
   requested repositories with App-JWT endpoints, refuses a
   returned id that names another installation, and publishes the connection named by the path. The
   console's verify action runs the same check when GitHub does not bring the browser back.

**Recovery.** Every setup step resumes from its durable checkpoint, so an interrupted setup is
repaired by re-running the remaining steps. A stable connection can be reconciled: Control
re-verifies the App identity with the vault key and reapplies the webhook configuration. Neither
operation changes the connection id, the App, the installation or the application bindings.

**Binding.** A private application binds the pair `(connectionId, installationId)` at registration,
chosen from the repository owner's connection. Every private operation names both. An installation
id alone never selects a credential, and a mismatch fails without trying another connection.
Changing a registered application's repository or its binding takes global `app.manage`, as
registration does; `app.manage` scoped to the application changes neither.

**Webhooks.** Each connection's App delivers to `/webhooks/github/:connectionId`. Control selects that
connection's secret before reading the body, verifies the HMAC, requires the payload's installation id
to equal the connection's, and triggers only applications bound to that pair and repository. There is
no unscoped `/webhooks/github` route.

**Public repositories** need no connection, and the cron poller triggers them from the repository's Atom
feed instead of a webhook. A read that names no binding still carries a token when it can: Control takes
the connection of the account that owns the repository and mints a token scoped to that repository.
GitHub refuses that token for a repository the installation does not cover, so minting it is the access
check, and the read falls back to anonymous. Anonymous reads share the per-IP limit with every tenant of a
cloud's egress address; an installation token has its own. The fallback grants nothing new: whoever names an
application's repository could bind the same connection, and that is global `app.manage` (registration, or a
repository change). Webhooks, the poller and the registration probe are unchanged: the probe
asks whether the repository is readable WITHOUT a token, so it stays anonymous.

**Cloudflare delivery.** For each deploy, Control resolves the requested ref to one exact commit with a
repository-scoped, read-only installation token minted from the bound connection's vault key. It mints a
second such token for the runner job and hands the container a clone URL that carries it as
`x-access-token`. The runner redacts every form of that URL and token from its logs and never persists
them.

**Zerops delivery, in-process in Control.** For each deploy, Control:

1. Resolves the requested ref to one exact commit in one pass over the ref's archive: the pax global
   header names the commit, and the root `zerops.yaml` hashed in passing must equal the descriptor digest
   embedded in the registered provider artifact, or the run fails before any Zerops or Operations state is
   created. The run's access snapshot is a second pass over the commit's archive, which keeps the files it
   may read. No step reads the repository through a rate-counted REST request, except a file the snapshot
   pass did not keep and the platform tree check below.
2. Creates the Zerops application version and records its id
   ([ADR-0044](0044-zerops-delivery-ownership-and-recovery.md) owns recovery).
3. Requests `GET /repos/{owner}/{repo}/tarball/{sha}` with `redirect: 'manual'`, requires the
   `Location` to be on `https://codeload.github.com`, and fetches it without the Authorization header.
4. Pipes `gunzip → tar rewrite → gzip → PUT` to the upload URL. The rewrite works in 512-byte blocks:
   it strips the archive prefix, keeps regular files, writes each parent directory once, normalizes
   mode (`0755`/`0644`), owner and mtime, confirms the commit from the pax global header, hashes the
   root `zerops.yaml` in passing, and enforces limits incrementally.
5. Calls `build-and-deploy` with the descriptor from the artifact and the selected setup, and records
   the same commit as the release source.

**Invariants:**

- No GitHub token, private key or credential-bearing URL reaches Zerops state, a database row outside
  the vault, a response, an event or a log. On Cloudflare the only token to leave Control is the
  repository-scoped clone token in the runner job, in transit. Upstream errors are redacted before they reach a run log.
- The codeload URL and the Zerops upload URL are credentials in transit: never persisted, never
  logged, never returned in an error.
- Production origins are fixed to `api.github.com` and `codeload.github.com`. The upload destination
  must match the exact host, path and signed-query shape recorded in the
  [Zerops platform reference](../reference/zerops-platform.md); redirects are refused.
- Control never extracts the repository to disk and never executes repository code. The rewrite
  rejects symlinks, hard links, devices, every other special entry, a root `.gitmodules`, paths outside
  the archive prefix, duplicate paths, and archives above 50,000 files or 512 MiB of content.
- A private operation names a connection id. An installation id alone never selects a credential.
- A webhook delivery is authenticated by exactly one connection's secret, selected by the path.
- An App's private key is in the vault before setup reports success.
- Control never deploys the platform installation itself.

## Consequences

- A private application needs one App installation per owning account, not a GUI step per service.
  Removing a repository from the App removes future deploy access at once.
- Installations have no source service, no source RPC key and no GitHub credential in their
  environment, on either cloud. Source handling is Control code, testable in-process.
- A fresh installation deploys public repositories only, until an administrator connects GitHub from
  the console. Once an account's App is connected and installed on a repository, every read of that
  repository is authenticated, bound application or not; reads of other accounts' public
  repositories stay anonymous. Not verified against a live App: whether an installation token reads a
  public repository outside its installation. Control never relies on it.
- Losing the vault KEK loses every connection; each must be recreated, which creates a new App.
- Peak memory per upload is one chunk; no disk scales with repository size. A snapshot pass keeps at most
  32 MiB of wanted files.
- A deploy downloads its archive three times (resolve, snapshot, upload), which costs bandwidth but no
  rate-limited request. An exact-commit resolution and a platform commit's tree check are remembered per
  Control process, so a namespace proxy rebuild downloads once and spends no request after the first.
- A GitHub rate-limit refusal is its own failure (`rate_limited`) with the reset time; a namespace mutation
  that meets it stays `provisioning` and is retried.
- The tarball is `git archive` output, so `.gitattributes` `export-ignore` and `export-subst` apply. A
  path hidden from `git archive` is also missing from the deploy. Archives are not byte-deterministic;
  the descriptor digest, not the archive, binds a deploy.
- Validation runs during the PUT, so a rejected archive aborts an upload in flight. The run settles
  the archive verdict before blaming the transport, and the pre-trigger cleanup deletes the version.
- A GitHub change to the tarball redirect or format fails the deploy at the redirect check.
- Changing the repository-root `zerops.yaml` requires rebuilding and re-registering the artifact.
- An orphan window remains between GitHub accepting the manifest conversion and the vault write. An
  App lost in that window must be deleted and recreated.
- Deleting or disconnecting a connection, rotating a private key, moving an application to another
  connection, public cross-organization Apps and GitHub Enterprise are not supported.

## Alternatives considered

- **Connect each service in the Zerops GUI.** Registration would stop at an empty service and need a
  manual step per environment. Kept only as an operational escape hatch.
- **Hold a Zerops user token in Control.** A long-lived human credential with broader authority, and
  no supported delegation from the OAuth grant to the installation.
- **Put a GitHub token in `buildFromGit`.** Zerops records the source URL on the version, so the
  credential would cross into platform state. Letting the build container clone has the same flaw.
- **Deploy from GitHub Actions with `zops push`.** The workflow becomes the deploy authority and each
  repository needs a Zerops credential. Kept as a CI escape hatch.
- **A central Fabrika source service or App.** Couples every installation to one shared credential
  and widens a compromise across operators.
- **A separate `source` service holding keyed credential slots in its environment.** It needed an
  authenticated RPC, a credential bundle digest bound across two custodians, create-only env writes,
  activation and restart semantics, a single-container constraint and a digest-rebind repair. Control
  already has a vault and already holds the key on Cloudflare; a second custodian added hops and
  failure modes without reducing what a Control compromise exposes.
- **One public App installed in every organization.** Widens installability beyond the operator's
  accounts.
- **Organizations only.** Control first refused a personal account's App. It cost an operator whose
  repositories live on a personal account an organization created for no other reason, and bought nothing:
  installation tokens, webhooks and the tarball read work the same for both owner types.
- **Try every webhook secret, or route by owner or installation id.** Work grows with the connection
  set, owner text is mutable, and an installation id does not name the App credential.
- **Keep an unkeyed legacy credential path.** Two selectors invite answering through the wrong App.
- **Keep Cloudflare's single App in Worker secrets.** It needed a second webhook route with a static
  secret, a second application-binding mode keyed by installation id alone, and a second token-minting
  path. It also capped a Cloudflare installation at one organization's private repositories.
- **Read the snapshot and the descriptor file by file through `/contents`.** Exact and cheap in bandwidth,
  but each file spends one anonymous request of a budget that a cloud's tenants share.
- **Download the archive once and keep it for all three passes.** Needs memory or disk that scales with the
  repository; the extra downloads cost no rate-limited request.
- **Assemble the archive from Git objects, or stage the tarball on disk.** Both keep a disk ceiling
  (and the first needs `git` subprocesses and a second tree read) to buy byte determinism or error
  ordering that nothing needs.
- **Let the owner's browser carry a console session for the handoff.** The owner would need an account on
  the installation only to click through GitHub, and the operator's relay that held the administrator's
  session in a third browser is exactly what the handoff link replaces.
- **A `fabrika control source …` command that prints or cancels the link.** Not built: every source-connection
  action needs a person, and `fabrika control` signs in with a service key, which step 1 refuses.
- **Create the App from `platform init` with a local recovery file.** Puts one-time credentials on an
  operator's disk and makes an install command the ongoing connection authority.
