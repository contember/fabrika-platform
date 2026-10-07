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
be limited to read-only Contents on selected repositories. A GitHub App gives exactly that.

On Zerops, the native GitHub integration does not help: the OAuth grant made in the Zerops GUI is not
inherited by the installation's project-scoped token, so Fabrika cannot connect a service to a private
repository by API (see [Zerops platform reference](../reference/zerops-platform.md)). Zerops does
accept an uploaded archive: create an application version, PUT the archive to the returned upload
URL, then call `build-and-deploy`. Zerops still runs the build and the deploy.

A private GitHub App can be installed only in the organization that owns it. An operator who deploys
private repositories from several organizations therefore needs one App per organization, unless the
App is made public — which widens who can install it.

GitHub's manifest flow returns an App's private key exactly once. Whatever receives it must store it
durably before it reports success, or the App is unrecoverable.

## Decision

**Ownership.** Each installation uses GitHub Apps that its operator owns. There is no central
Fabrika App and no credential shared across operators. The operator installs the platform, Fabrika
deploys applications, and Zerops executes every application build and deploy
([ADR-0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)).

**Connections.** An installation holds any number of GitHub connections. Each connection is one
private App owned by one GitHub organization plus one verified installation of that App, keyed by a
connection id. The case-insensitive organization login selects at most one connection. There is no
connection-count limit; every request, response and page stays bounded. There is no unkeyed or
default connection.

**Custody.** Control holds every connection's App id and private key in its vault
(`packages/control/src/vault.ts`) as platform-scoped, purpose-labelled entries, next to that
connection's webhook secret. Control mints installation tokens in-process when it needs them. The App key is an installation
credential, not an application secret, so the vault does not conflict with
[ADR-0004](0004-secrets-live-in-the-platform.md). Connections, console setup and vault custody are
the Zerops composition. Cloudflare has one App whose id and key are Worker secrets. On both
providers the process that resolves sources holds the App key and nothing else does.

**Setup from the console.** A fresh installation starts anonymous and deploys public repositories.
A user principal with `source.connection.manage` (service tokens are refused) creates a connection from the console:

1. Control records a bounded, expiring, one-use setup state bound to the administrator, the exact
   Control origin, the organization and the requested repositories. Only one nonterminal setup may
   exist at a time; connected rows do not block a new one.
2. The browser runs GitHub's manifest flow. `@fabrika/github-app` builds the manifest: private App,
   Contents read, the `push` event only, fixed `github.com`. No personal access token is ever asked for.
3. The callback requires the same authenticated principal, consumes the state once, exchanges the
   code, and writes the App id and private key into the vault **in the same transaction as the setup
   checkpoint, before it reports success**.
4. Control generates a webhook secret, stores it in the vault, configures the App's webhook to
   `/webhooks/github/:connectionId`, and verifies the App identity (owner, visibility, permissions,
   events) with the stored key. GitHub masks the secret, so readback proves only URL, JSON content
   type and TLS verification.
5. The administrator installs the App. Control verifies the installation for the organization or the
   requested repositories with App-JWT endpoints, then publishes the connection.

**Recovery.** Every setup step resumes from its durable checkpoint, so an interrupted setup is
repaired by re-running the remaining steps. A stable connection can be reconciled: Control
re-verifies the App identity with the vault key and reapplies the webhook configuration. Neither
operation changes the connection id, the App, the installation or the application bindings.

**Binding.** A private application binds the pair `(connectionId, installationId)` at registration,
chosen from the repository owner's connection. Every private operation names both. An installation
id alone never selects a credential, and a mismatch fails without trying another connection.

**Webhooks.** Each connection's App delivers to `/webhooks/github/:connectionId`. Control selects that
connection's secret before reading the body, verifies the HMAC, requires the payload's installation id
to equal the connection's, and triggers only applications bound to that pair and repository. The
unscoped `/webhooks/github` route exists only for the Cloudflare composition's single App.

**Zerops delivery, in-process in Control.** For each deploy, Control:

1. Resolves the requested ref to one exact commit and reads the root `zerops.yaml` (raw contents). Its
   SHA-256 must equal the descriptor digest embedded in the registered provider artifact, or the run
   fails before any Zerops or Operations state is created.
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
  the vault, a response, an event or a log. Upstream errors are redacted before they reach a run log.
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

- A private application needs one App installation per organization, not a GUI step per service.
  Removing a repository from the App removes future deploy access at once.
- Zerops installations have no source service, no source RPC key and no credential environment
  slots. Source handling is Control code, testable in-process.
- Losing the vault KEK loses every connection; each must be recreated, which creates a new App.
- Peak memory per upload is one chunk; no disk scales with repository size.
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
  organizations.
- **Try every webhook secret, or route by owner or installation id.** Work grows with the connection
  set, owner text is mutable, and an installation id does not name the App credential.
- **Keep an unkeyed legacy credential path.** Two selectors invite answering through the wrong App.
- **Assemble the archive from Git objects, or stage the tarball on disk.** Both keep a disk ceiling
  (and the first needs `git` subprocesses and a second tree read) to buy byte determinism or error
  ordering that nothing needs.
- **Create the App from `platform init` with a local recovery file.** Puts one-time credentials on an
  operator's disk and makes an install command the ongoing connection authority.
