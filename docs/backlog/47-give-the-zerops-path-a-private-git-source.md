---
id: 47
title: Deliver private GitHub source through an operator-owned GitHub App
blocked-by: []
---

# 47 — Deliver private GitHub source through an operator-owned GitHub App

**Summary.** The operator-owned GitHub App, per-installation `source` service and application-version
upload lifecycle from
[ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md) are implemented
and locally verified. [ADR-0030](../decisions/0030-persist-github-app-creation-before-success.md)
makes the one-time App creation response durable during init. This item stays open for the complete
live init, public/private parity and credential-absence witness in `fabrika-install-test`. Effort L.

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
delivered the foundation; `b55d059` made the archive order canonical across GitHub metadata order and
`5c9d99f` added legacy active-run recovery:

- `source` is private and authenticates every RPC before reading its bounded body. Requests and
  responses bind the run, repository, exact commit, descriptor digest and app version; upload also
  binds the presigned URL. Stable errors contain no upstream body, URL or credential.
- `control` owns the Zerops token, app-version creation, durable checkpoints, cleanup and
  `build-and-deploy`. Source owns GitHub identity, Git metadata validation, Git-object archiving and the
  upload PUT. Source receives no Zerops token and executes no application code.
- Production is fixed to `github.com` and `api.github.com`; there is no GitHub Enterprise or API-base
  setting. Public repositories work anonymously. A private repository uses the operator's optional
  all-or-none App id and private key, held only by source.
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
- Fresh install provisions source and generates the shared RPC key. Interactive `platform init`
  upgrades an existing project with a source-only `startWithoutCode: true` import and crash-safe key
  reconciliation: matching keys are reused, a valid one-sided key repairs the absent side, both absent
  generate one, and invalid or mismatched values are refused.
- The shared manifest helper supports an optional, awaited and bounded `onCreated` hook. Zerops init
  supplies it and durably stores the one-time App result before the helper reports success, in an
  owner-only, bounded absolute XDG recovery file outside the worktree. It supports strict `create`,
  `resume`, `existing`, `preserve` and `anonymous` states; partial or mismatched state fails closed.
- Missing RPC and GitHub values use create-only Zerops writes. Duplicate or ambiguous results are
  accepted only after bounded exact rereads, and final reads prove both RPC sides and all three GitHub
  fields. A same-organization App defaults to private; a cross-organization App requires an explicit
  public choice.
- Init verifies App identity, owner, visibility, exact authority and webhook structure before deleting
  recovery and opening the installation step. Every App-backed init run verifies the organization or
  each repository through App-JWT endpoints. It never adds a repository to the installation.

A loopback TCP lock keyed by Zerops project and installation serializes init on one host. It is
independent of the XDG recovery root. There is no distributed serialization. Create-only conflicts and
final rereads fail closed when they observe concurrent remote writes, but cannot prevent a writer after
final verification. One operator per project at a time is a supported operational requirement.

## Operator step that remains

The public witness needs no GitHub App. For the private witness, init creates or verifies the
organization-owned GitHub App and configures source and control without exposing its credentials to
the sidecar. The operator must still approve the App installation on the selected organization or
repositories in GitHub's UI. This is one installation-level action, not one Zerops GUI action per
application service.

## Acceptance

A control-plane-triggered deploy of the same exact commit succeeds on `fabrika-install-test` while the
repository is public and again after it becomes private. Both runs use app-version upload, and no
credential appears in Fabrika logs, Zerops process data or application-version metadata. An attacker
upload URL receives zero bytes, and repository entries cannot expose local source-service files.

The code-level attacker-destination, repository-safety and init recovery checks pass. The complete
live App creation/install flow, two successful live deploys and live credential inspection have not
been performed; they are the remaining acceptance work. GitHub can still accept manifest conversion
and fail before `onCreated` can persist the response; that narrow orphan requires deleting and
recreating the App. GitHub also masks the webhook secret, so post-patch readback proves only the URL,
JSON content type and TLS setting.

## Touch points

New `packages/source-zerops/`; `packages/control/src/repo-source.ts`;
`packages/provider-zerops/src/{api,control,provider}.ts`; `packages/installation-zerops/`;
`docs/reference/zerops-platform.md`.
