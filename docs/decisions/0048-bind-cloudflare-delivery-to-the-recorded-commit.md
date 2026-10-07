---
id: 0048
title: Bind Cloudflare delivery to the recorded application commit
status: accepted
date: 2026-10-07
---

# 0048 — Bind Cloudflare delivery to the recorded application commit

## Context

Control records a commit A from a webhook. The Cloudflare runner container could clone a branch that
now points to commit B. The runtime release and the Operations source-map scope still name A. A
successful build then reports a release that does not match the deployed code.

The neutral provider contract already resolves an immutable source before Control freezes the run's
release context. Zerops uses it. Cloudflare must use it too, and its container must prove that the
checkout matches before it runs any repository code.

## Decision

**Invariant: a successful non-dry Cloudflare run uses one commit for its run identity, verified
checkout, runtime release and source-map scope.** Unavailable or mismatched source fails before
dependency installation or any repository-controlled command. Nothing falls back to a branch tip.

- The Cloudflare provider implements `resolveSource`. It resolves the run's source to a complete commit
  SHA once, before Control freezes the release context. A recorded commit ID wins over a mutable ref
  and must exist as a commit; a recorded non-commit object fails.
- Ref resolution: qualified heads and tags keep their namespace; a bare name tries the exact branch,
  then the exact tag; an annotated tag is peeled to its commit; the GitHub composition accepts
  complete 40-hex SHA-1 commit IDs.
- Clone authorization (`prepareClone`) only returns a clone URL. It cannot change the selected commit.
- A non-dry `CloudflareRunnerJob.ref` carries that complete commit SHA. The runner refuses any other
  form for a non-dry job.
- The container fetches exactly that object, detaches HEAD on it, and compares HEAD with the expected
  SHA before it installs dependencies. It logs the expected and actual SHA.
- Git credentials go only into the Git child process's environment — never argv, persisted Git
  configuration or a repository-controlled child.
- A dry run of a mutable ref keeps its preview semantics and reports no release.

The runner Worker and its container image are rolled forward before Control, through the operator's CI.
Control does not negotiate a source protocol with them.

## Consequences

- A moved branch cannot change an already selected deployment or mislabel its release and source maps.
- A force-pushed or removed commit is a pre-install failure; the source host need not keep old commits.
- An outdated runner may ignore the expected SHA. Rolling the runner forward first is the only guard;
  a deploy order mistake is an operator error, not something Control detects.

Run ownership and how Control applies the runner's outcome follow the lease rules in
[ADR-0044](0044-zerops-delivery-ownership-and-recovery.md), which cover both clouds.

## Alternatives considered

- **Pass the branch alongside the recorded release.** It keeps the A/B race.
- **Trust the requested SHA or the executor's outcome file.** A request is not checkout evidence. An
  outcome written after repository code runs is too late to stop that code.
- **A source-protocol capability handshake** — Control checks the Worker's capability, the Worker checks
  the image's, before any job. It protects mixed-version installations, but costs an authenticated
  admission path across three components for a case that deploy order already prevents.
- **Move Cloudflare onto the Zerops source transport.** It adds a transporter and changes the native
  deployment path without being needed for exact checkout.
