---
id: 0048
title: Bind Cloudflare delivery to the recorded application commit
status: accepted
date: 2026-10-05
---

# 0048 — Bind Cloudflare delivery to the recorded application commit

## Context

Control can record webhook commit A while the Cloudflare container follows a branch that now points to B. Runtime release variables and Operations source-map scope can still identify A. A successful build therefore does not establish which recorded source was deployed.

The neutral provider contract already supports immutable source resolution before Control freezes its release context. Zerops uses that capability. Cloudflare's similarly named options hook only prepares a clone URL and can return a different ref. Its container does not compare checkout HEAD before running repository code.

The detached runner has two independently replaceable consumers: its Worker and container image. Tightening only a new producer's job validator cannot establish exact-source behavior in an older consumer.

## Decision

We will make exact application-source identity an observable guarantee for Cloudflare and Zerops, while retaining their native execution boundaries.

**Invariant: a successful non-dry Cloudflare run uses the same commit for its frozen run identity, verified checkout, runtime release and source-map scope.** Unavailable or mismatched source fails before dependency installation or repository-controlled commands. No fallback to a current branch tip is permitted.

Control retains source-selection persistence and fenced ownership. The Cloudflare provider implements the existing neutral source-resolution capability. Its public options separate immutable `resolveSource` from ephemeral `prepareClone`; clone authorization returns a URL and cannot replace the selected commit.

Recorded commit IDs take precedence over mutable refs and must be verified as commits. Unrecorded concrete refs resolve once before the release context is frozen. Qualified heads and tags preserve their namespaces; bare names try the exact branch first and the exact tag only after not-found. Annotated tags selected by ref are peeled to commits. A recorded non-commit object fails rather than silently rewriting recorded history. The current GitHub composition supports complete 40-hex SHA-1 commit IDs; the neutral contract retains its broader format support.

The provider-owned `CloudflareRunnerJob.ref` carries the expected complete commit for non-dry jobs. Dry mutable-ref previews retain their separate release-unavailable semantics. A full-commit preview uses exact checkout verification too.

The container fetches the selected object, detaches HEAD and compares the observed complete commit before installing dependencies. It emits a runner-owned expected/actual source witness through the existing logs. Git authorization belongs only in the Git child's environment, never argv, persisted Git configuration or repository children.

Control must verify an authenticated read-only Worker source-protocol capability before recording external acceptance or submitting a job. The Worker must verify the image's health capability before POSTing `/run`. Missing or incompatible capability refuses work. The capability remains Cloudflare-owned; no neutral provider registry, status field or shared source transporter is added.

**Invariant: source-protocol admission cannot run repository code or submit a deployment as its probe.** The Worker check authenticates using the existing runner key. That key still stops at the Worker, and IAM's provisioning key remains in Control.

The runner stays detached and is rolled forward, with its account-owned image, before Control through the operator-owned CI path. Existing cancellation, checkpoints, guarded terminal co-writes, IAM reconciliation, private routing and proxy enforcement retain their owners.

## Consequences

- A moved ref cannot silently change an already selected deployment or mislabel its release/maps.
- The Cloudflare options and non-dry job contracts tighten deliberately. Custom compositions must supply distinct resolution, clone-authorization and protocol-admission collaborators.
- Mixed old/new installations may refuse application delivery until the detached runner pair and Control agree. Refusal is preferable to a falsely attributed success.
- Force-pushed or removed objects may be unavailable; the outcome is a pre-install failure, not a promise that the source host retains every old commit.
- Real local Git witnesses verify checkout bytes and lifecycle/artifact scope. Operator-owned live acceptance remains separate evidence.
- Platform installation pin policy, successful normalization of recorded tag-object webhook IDs, and wider Cloudflare orchestration require separate decisions.

## Alternatives considered

- **Pass the original branch alongside the recorded release.** This retains the A/B race and cannot establish release identity.
- **Trust the requested SHA or the executor's outcome file.** A request is not checkout evidence; an outcome written after repository code runs is too late to admit that code.
- **Add only a new expected-SHA job field.** Old consumers can ignore it and start mutable checkout. The existing ref can carry the selected commit, but consumer capability must be established before submission.
- **Move Cloudflare onto the Zerops source service.** This adds a transporter and changes native deployment ownership without being necessary for exact checkout.
