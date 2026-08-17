---
id: 47
title: Deliver private GitHub source through an operator-owned GitHub App
blocked-by: []
---

# 47 — Deliver private GitHub source through an operator-owned GitHub App

**Summary.** The operator-owned GitHub App, per-installation `source` service and application-version
upload lifecycle from
[ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md) are implemented
and locally verified. Normal App creation and adoption now run in authenticated Control under
[ADR-0031](../decisions/0031-manage-zerops-github-source-from-control.md); ADR-0030 remains the legacy
CLI recovery record. Multiple private organization connections, keyed source credentials and scoped
webhooks are locally implemented under
[ADR-0032](../decisions/0032-support-multiple-private-github-source-connections.md). This item stays
open for the ordered live rollout, complete browser flow, public/private parity, second-organization
deploy and credential-absence witness in `fabrika-install-test`. Effort L.

## Problem

The original Zerops `triggerPipeline` seam offered two sources:

- `buildFromGit: <url>` — a one-time build from a **public** repository, or
- nothing — build from the service's configured Git integration, which its own doc comment calls
  "the private-repo path".

The second branch is not usable by the installation identity. Verified live on 2026-08-11: the Zerops
GUI OAuth flow completed and listed `contember/fabrika-example-zerops`, but
`SetupExternalRepositoryIntegration` called on a disposable service with the exact project-scoped
token stored on `control` returned `githubAuthorizationRequired`. The status endpoint confirmed that
no integration was created; the service was deleted.

This blocks more than `trigger-deploy`. Because the Operations ingest DSN is minted by the
control→Operations catalog projection that follows a successful deploy, error ingest for a
fabrika-deployed private app is unreachable as well.

**Not in scope.** Do not hand `buildFromGit` a credentialed clone URL. Zerops records what it is given,
so a one-hour installation token can survive in platform state or diagnostics. ADR-0029 keeps the
GitHub credential inside the source service and sends Zerops only repository bytes; application deploys
no longer call this seam.

**Also not in scope:** fabrika's own namespace proxy. ADR-0025 puts it on a pinned **tag** of the
public `contember/fabrika-platform` repository, which needs no credential and no integration.

## Implemented foundation

Commits `d091d67`, `49f3b17`, `4084234`, `4ab9ec2`, `5bc1f0e`, `68854f3` and `71e406a`
delivered the transport foundation; `b55d059` made the archive order canonical across GitHub metadata
order and `5c9d99f` added legacy active-run recovery. Commits `a64278f`, `d6dd195`, `459bc64` and
`ecd49b9` completed remote credential adoption, moved normal App setup into authenticated Control and
added the browser UI:

- `source` is private and authenticates every RPC before reading its bounded body. Requests and
  responses bind the run, repository, exact commit, descriptor digest and app version; upload also
  binds the presigned URL. Stable errors contain no upstream body, URL or credential.
- `control` owns the Zerops token, app-version creation, durable checkpoints, cleanup and
  `build-and-deploy`. Source owns GitHub identity, Git metadata validation, Git-object archiving and the
  upload PUT. Source receives no Zerops token and executes no application code.
- Production is fixed to `github.com` and `api.github.com`; there is no GitHub Enterprise or API-base
  setting. Public repositories work anonymously. A private repository uses the operator's atomic,
  versioned App id/private-key bundle, held only by source.
- GitHub REST metadata is checked before Git fetch. GitHub's
  [recursive tree endpoint](https://docs.github.com/en/rest/git/trees#get-a-tree) allows up to 100,000
  entries or 7 MB; Fabrika limits the repository to 50,000 entries and 512 MiB expanded, bounds the
  response, refuses truncation and rechecks the fetched objects against the metadata.
- Only the measured `prg1` HTTPS upload host and exact path are accepted. Redirects are refused. The
  repository is archived from Git objects without a checkout; symlinks, submodules, special entries,
  unsafe paths and excessive trees are rejected.
- `zerops.yaml` exact bytes and digest are embedded in the provider artifact. Drift fails before an
  Operations release or Zerops app version is created. Public and private applications now use the
  same app-version upload lifecycle; the temporary application `buildFromGit` branch is deleted.
- Fresh install provisions source, generates the shared RPC key and leaves GitHub anonymous.
  Interactive `platform init` upgrades an existing project with a source-only `startWithoutCode: true`
  import, crash-safe two-sided RPC reconciliation and the nonsecret Control project binding. It does
  not create, recover or print GitHub credentials.
- Authenticated Control creates the organization-owned App through a one-use,
  human-and-origin-bound manifest callback. The one-time App id and private key first enter the
  encrypted platform vault. Control then creates and proves one canonical source credential bundle, activates it without
  restarting source, stores the webhook secret separately, verifies App and webhook structure and
  deletes recovery before asking the human to install the App.
- Durable phase leases and compare-and-set checkpoints turn interrupted work into a bounded terminal
  or repairable state. Browser DTOs, redirects, logs and errors carry no manifest code, opaque state,
  private key, webhook secret, source RPC key or GitHub token.
- A complete legacy App id/private-key pair can be adopted. The provider canonicalizes it into the
  atomic bundle with a deterministic project-and-digest connection id and fails closed on partial,
  conflicting or unverifiable state. Old ADR-0030 XDG files remain a CLI compatibility case only.
- The console verifies the organization or every requested same-owner repository through App-JWT
  endpoints before publishing the connection. It never adds a repository to the installation.
- One installation can hold multiple private organization-owned Apps. The migrated connection keeps
  the v1 source credential and generic webhook; each new connection uses a create-only keyed v2 slot,
  exact connection-and-installation registry pair and scoped webhook. Cloudflare keeps its
  installation-only generic route. Fabrika defines no total connection-count limit.

## Operator step that remains

The public witness needs no GitHub App. For the private witness, an authenticated administrator opens
**Settings → Source**, creates or adopts the organization-owned App and approves its installation on
the selected organization or repositories in GitHub. This is one installation-level action, not one
Zerops GUI action per application service. `platform init` remains available for source/RPC repair and
legacy-state inspection, not as a second normal App-creation path. Adding another private organization
uses the same Control flow while existing connections remain available.

## Acceptance

A control-plane-triggered deploy of the same exact commit succeeds on `fabrika-install-test` while the
repository is public and again after it becomes private. Both runs use app-version upload, and no
credential appears in Fabrika logs, Zerops process data or application-version metadata. An attacker
upload URL receives zero bytes, and repository entries cannot expose local source-service files.

The code-level attacker-destination, repository-safety, Control recovery and legacy-adoption checks
pass. Deterministic multi-connection compatibility and isolation gates pass locally. The local fixture
does not support the GitHub manifest/install browser E2E. The complete live browser/App
creation/install flow, ordered v1-plus-v2 rollout, source restart, two successful public/private live
deploys, a second-organization private deploy, one genuine positive legacy-v1 generic delivery, one
genuine positive keyed-v2 scoped delivery and live credential inspection have not been performed; they
are the remaining WU10 and backlog-47 acceptance work. GitHub can still accept manifest conversion
before Control persists the callback response; that narrow orphan requires deleting and recreating the
App. GitHub also masks the webhook secret, so post-patch readback proves only the URL, JSON content type
and TLS setting.

## Touch points

`packages/source-zerops/`; `packages/provider-zerops/src/{api,control,provider,source-connection}.ts`;
`packages/control/src/{repo-source,source-connection,github-connection-store}.ts`;
`packages/control-contract/`; `packages/dashboard/src/routes/settings/source.tsx`;
`packages/installation-zerops/`; `docs/reference/zerops-platform.md`.
