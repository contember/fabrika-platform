---
id: 0030
title: Persist GitHub App creation before success
status: accepted
date: 2026-08-12
---

# 0030 — Persist GitHub App creation before success

## Context

[ADR-0029](0029-an-operator-owned-github-app-delivers-zerops-sources.md) assigns GitHub credentials
to an operator-owned GitHub App. GitHub's manifest conversion returns the App id, slug, URL, private
key and webhook secret once. If the manifest helper reports success before its caller durably stores
that response, a process failure can leave an App whose private key cannot be recovered.

The Zerops installation has a second durability boundary. The private key belongs only on `source`,
the webhook secret belongs only on `control`, and existing values must never be overwritten while an
init retry repairs missing state. A browser callback alone cannot make those separate remote writes
atomic.

This ADR amends only ADR-0029's init durability detail. It does not change its source-service,
credential-ownership or deploy architecture.

## Decision

The shared GitHub App manifest helper accepts an optional `onCreated` callback. When Zerops supplies
it, the helper treats manifest conversion as successful only after that callback completes within the
bounded callback deadline. The helper
cleans up its loopback listener when the setup hook or callback fails. Zerops init uses `onCreated` to
persist the exact conversion result before the interactive flow proceeds.

That recovery bundle is stored at an absolute XDG state path outside the worktree. Its directory is
owner-only (`0700`), and its fixed temporary and final files are owner-only (`0600`). The file has a
strict schema, a 72 KiB bound and an exact binding to installation, Zerops project id and the live
control origin. Publishing it fsyncs the temporary file, atomically renames it and fsyncs the parent
directory. A recognized safe stale temporary file is removed; an unsafe one is refused. Deletion
cleans both fixed files and fsyncs the directory.

Init classifies the source state before mutating it:

- `anonymous` is offered only when live GitHub state is empty, no recovery exists and no repository
  grant was requested. It needs no control or proxy origin.
- `create` starts from empty live state and no recovery. The App is private by default for a same-org
  repository set; a cross-org set requires an explicit public App choice.
- `resume` requires the recovery bundle and every binding to match the live installation.
- `existing` verifies operator-supplied App credentials against GitHub before use.
- `preserve` accepts only complete live GitHub state. Partial, invalid or mismatched state is refused.

Every App-backed path binds the manifest homepage and webhook to the exact live HTTPS control origin.
Missing RPC and GitHub service variables are written through create-only Zerops writes. Init never
uses an update to repair them. A duplicate or ambiguous create response is accepted only after a
bounded exact reread proves the intended value. Final repeated reads prove that both RPC variables
match and that the three GitHub variables equal the selected App state.

Before recovery is deleted, init verifies the authenticated App identity, owner, visibility, exact
permission authority and `push` event. It patches the webhook to the exact URL, JSON content type and
TLS verification, then reads the configuration back. GitHub masks the webhook secret, so readback can
verify only that structural configuration; the successful patch is the value-setting operation.
Recovery is deleted only after the Zerops credentials and those GitHub checks succeed, and before init
opens the App installation step.

Each App-backed init run then verifies with App JWT endpoints that the App is installed for the
selected organization or for every selected repository. Init does not add a repository to an
installation.

A loopback TCP lock keyed by Zerops project and installation serializes init processes on one host. It
is independent of the XDG recovery root and is not a distributed lock. Across hosts, create-only
conflicts and final exact rereads fail closed when they observe a competing writer, but cannot prevent
another writer from changing state after final verification. Running at most one operator for a
project at a time is therefore a supported operational requirement.

## Consequences

- A crash after `onCreated` persists the one-time response is recoverable without putting a private
  key or webhook secret in the worktree, sidecar repository or GitHub Environment.
- Recovery briefly contains those two GitHub credentials. Its bounded owner-only XDG file and durable
  deletion protocol become part of the installation's local secret boundary.
- There remains an unavoidable orphan window after GitHub has irreversibly accepted manifest
  conversion but before `onCreated` begins or can persist the response. The operator must delete and
  recreate that App because GitHub will not return its private key again.
- Webhook readback cannot prove the secret value because GitHub masks it. It proves the requested URL,
  JSON content type and TLS setting after the patch instead.
- The implementation is locally tested. The complete live GitHub/Zerops init flow and WU3's public
  and private application deploys remain unverified.

## Alternatives considered

- **Return the conversion response before persistence.** Rejected: a successful-looking run can lose
  the only copy of the App private key.
- **Keep recovery in the generated repository.** Rejected: it crosses the sidecar and source-control
  trust boundary.
- **Repair partial remote state with updates.** Rejected: retry could overwrite credentials created by
  another operator.
- **Add a distributed installation lock.** Deferred: create-only writes and exact rereads provide a
  fail-closed remote boundary, while one operator per project is an explicit current requirement.

## References

- [ADR-0029 — An operator-owned GitHub App delivers Zerops application sources](0029-an-operator-owned-github-app-delivers-zerops-sources.md)
- [Zerops platform reference](../reference/zerops-platform.md)
- [Archived Zerops deploy sprint](../archive/sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md)
