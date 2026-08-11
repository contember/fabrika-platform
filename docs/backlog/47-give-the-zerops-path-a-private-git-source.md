---
id: 47
title: Deliver private GitHub source through an operator-owned GitHub App
blocked-by: []
---

# 47 — Deliver private GitHub source through an operator-owned GitHub App

**Summary.** An application deployed to Zerops cannot give `buildFromGit` a private repository, and
the control plane's integration token cannot consume a Zerops user's GitHub OAuth grant.
[ADR-0029](../decisions/0029-an-operator-owned-github-app-delivers-zerops-sources.md) settles the
replacement: an operator-owned GitHub App authenticates a per-installation `source` service, which
uploads an exact repository snapshot for Zerops to build and deploy. Effort L.

## Problem

`triggerPipeline` (`packages/provider-zerops/src/api.ts:246`) offers two sources:

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

**Not in scope.** Do not hand `buildFromGit` a credentialed clone URL. The platform records what it is
given, so a one-hour installation token can survive in platform state or diagnostics. ADR-0029 keeps
the GitHub credential inside the source service and sends Zerops only repository bytes.

**Also not in scope:** fabrika's own namespace proxy. ADR-0025 puts it on a pinned **tag** of the
public `contember/fabrika-platform` repository, which needs no credential and no integration.

## Approach

Provision one non-public `source` service beside `control`:

- Authenticate every control→source request; private-network reachability is not authorization.
- Bind repository, ref, GitHub App installation, app version, upload URL and run in every request.
- Use the operator-owned GitHub App to resolve one exact commit without executing repository code.
- Let `control` create the Zerops app version and pass only its presigned upload URL to `source`; keep
  the project integration token and `build-and-deploy` call in `control`.
- Accept only the measured Zerops HTTPS upload origin and path, refuse redirects, and send zero bytes to
  every other destination.
- Inspect and archive Git objects without a checkout. Reject symlinks, submodules, special entries,
  escaping paths and trees above hard count or expanded-byte limits.
- Embed the bounded root `zerops.yaml` and its digest in the registration artifact. Source returns only
  the resolved commit and matching digest, then `control` builds with the registered descriptor and
  selected setup.
- Use this upload path for public and private repositories. Remove the temporary public application
  `buildFromGit` path after live parity.

## Prerequisite that is not code

The operator creates one organization-owned GitHub App, installs it on selected repositories, and
configures its identity, private key and webhook secret for the Fabrika installation. This is one
installation-level action, not one Zerops GUI action per application service.

## Acceptance

A control-plane-triggered deploy of the same exact commit succeeds on `fabrika-install-test` while the
repository is public and again after it becomes private. Both runs use app-version upload, and no
credential appears in Fabrika logs, Zerops process data or application-version metadata. An attacker
upload URL receives zero bytes, and repository entries cannot expose local source-service files.

## Touch points

New `packages/source-zerops/`; `packages/control/src/repo-source.ts`;
`packages/provider-zerops/src/{api,control,provider}.ts`; `packages/installation-zerops/`;
`docs/reference/zerops-platform.md`.
