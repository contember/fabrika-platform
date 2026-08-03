---
id: 47
title: Give the Zerops deploy path a private git source
blocked-by: []
---

# 47 — Give the Zerops deploy path a private git source

**Summary.** fabrika's GitHub App does not reach the Zerops path at all. Every
Zerops deploy that fabrika triggers needs a repository the _platform_ can clone, and
the only one the driver can name is a **public** URL. A private repository therefore
cannot be deployed to Zerops today.

## Problem

`GitHubAppRepoSource` (`packages/control/src/repo-source.ts`) mints an installation
token and hands back a clone URL. Its only consumer is `packages/control/src/platform-cf.ts`
— the Cloudflare path, where fabrika's own runner does the cloning.

The Zerops driver never clones. `triggerPipeline`
(`packages/provider-zerops/src/api.ts`) offers the platform two choices:

- `buildFromGit: <url>` — a one-time build from a **public** repository, or
- nothing — build from _Zerops'_ own git integration, configured per service.

Neither uses fabrika's GitHub App. Verified live on 2026-08-03: the account had no
GitHub authorization at all (`getGithubRepositories` → `githubAuthorizationRequired`),
so the second path was unavailable, and the repository is private, so the first was
too.

This blocks more than it looks like. Beyond `trigger-deploy`, the **namespace
lifecycle** builds a newly provisioned proxy from `proxyBuildFromGit`
(`packages/provider-zerops/src/namespace.ts`), so a namespace cannot reconcile
either — its state stays `failed`. And because the Operations ingest DSN is minted by
the control→Operations catalog projection that follows a successful deploy, error
ingest for a fabrika-deployed app is unreachable as well.

## Approach

Two candidates, and they are not equivalent:

1. **Use Zerops' own repository integration.** `PUT /service-stack/{id}/external-repository-integration`
   takes `{ repositoryFullName, branchName, eventType, isActive, triggerBuild, zeropsYamlSetup }`
   and works for private repositories. The catch is the authorization it depends on:
   linking a GitHub account to Zerops is an interactive OAuth flow
   (`getGithubAuthUrl`), so an installation cannot be provisioned end-to-end by
   fabrika — an operator clicks once per Zerops account. It also moves the build
   trigger to Zerops, which overlaps with fabrika's own webhook path.
2. **Hand `buildFromGit` a credentialed URL.** `https://x-access-token:<token>@github.com/...`
   is GitHub's documented clone scheme and fabrika can already mint that token. But
   the platform stores what it is given, so a short-lived installation token would be
   persisted on a service and expire; and the root `CLAUDE.md` rule against ever
   logging a clone URL with an embedded token becomes much harder to hold when the
   URL is also platform state. Whether Zerops accepts a credentialed URL at all is
   **unverified**.

Decide between them before building either. (1) is the supported path and the
smaller change; (2) keeps provisioning fully automatic and is the one that needs a
security argument written down.

## Acceptance

A private repository deploys to Zerops through the control plane, a namespace
reconciles its proxy from it, and no credential appears in a log line or in an error
object. Record which option was chosen and why in an ADR.

<!-- Origin: sprint zerops-live-bringup, 2026-08-03 (finding F5). -->
