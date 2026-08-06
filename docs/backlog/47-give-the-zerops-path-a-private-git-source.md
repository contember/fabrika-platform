---
id: 47
title: Configure a Zerops service's repository integration so fabrika can deploy a private app
blocked-by: []
---

# 47 — Configure a Zerops service's repository integration so fabrika can deploy a private app

**Summary.** An application deployed to Zerops can only be built from a **public** URL, so a private
repository cannot deploy there. [ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
settled the mechanism: fabrika does not clone on Zerops, it configures the service's own repository
integration and triggers the platform's pipeline. Effort M.

## Problem

`triggerPipeline` (`packages/provider-zerops/src/api.ts:246`) offers two sources:

- `buildFromGit: <url>` — a one-time build from a **public** repository, or
- nothing — build from the service's configured Git integration, which its own doc comment calls
  "the private-repo path".

The second branch is never taken, because nothing in `packages/` configures an integration:
`external-repository-integration` does not appear anywhere in the repository. So every fabrika-triggered
app deploy on Zerops needs a public URL. Verified live on 2026-08-03: the account had no GitHub
authorization at all (`getGithubRepositories` → `githubAuthorizationRequired`).

This blocks more than `trigger-deploy`. Because the Operations ingest DSN is minted by the
control→Operations catalog projection that follows a successful deploy, error ingest for a
fabrika-deployed private app is unreachable as well.

**Not in scope any more.** This item previously proposed handing `buildFromGit` a credentialed clone
URL (`https://x-access-token:<token>@github.com/...`). ADR-0025 rejected it: the platform persists what
it is given, so a one-hour installation token becomes durable service state that expires. Do not
reintroduce it without superseding that decision.

**Also not in scope:** fabrika's own namespace proxy. ADR-0025 puts it on a pinned **tag** of the
public `contember/fabrika-platform` repository, which needs no credential and no integration.

## Approach

Add the integration call to the API client and make the app deploy path use it:

- `PUT /service-stack/{id}/external-repository-integration`, body
  `{ repositoryFullName, branchName, eventType, isActive, triggerBuild, zeropsYamlSetup }`.
- Configure it when fabrika creates an app's service, then call `triggerPipeline` **without**
  `buildFromGit` so the platform builds from that integration.
- Decide what `triggerBuild` should be. fabrika owns the deploy trigger through its own webhook, so a
  Zerops-side push trigger would deploy the same commit twice.

## Prerequisite that is not code

Linking a GitHub account to Zerops is an interactive OAuth flow (`getGithubAuthUrl`), so **an operator
clicks once per Zerops account** before this works. ADR-0025 accepts that cost. Confirm the flow's
result is account-wide (not per project) before designing around it.

## Acceptance

A control-plane-triggered deploy of a **private** repository succeeds on `fabrika-test`, and no
credential appears in any persisted service field or any log line.

## Touch points

`packages/provider-zerops/src/api.ts`, `packages/provider-zerops/src/control.ts`,
`docs/reference/zerops-platform.md`.
