---
id: 0048
title: Bind Cloudflare delivery to the recorded application commit
status: accepted
date: 2026-10-08
---

# 0048 — Bind Cloudflare delivery to the recorded application commit

## Context

Control records a commit A from a webhook. The Cloudflare runner container could clone a branch that
now points to commit B. The runtime release and the Operations source-map scope still name A. A
successful build then reports a release that does not match the deployed code.

The neutral provider contract already resolves an immutable source before Control freezes the run's
release context. Zerops uses it. Cloudflare must use it too, and its container must prove that the
checkout matches before it runs any repository code.

The access surface has the same problem. Today a Cloudflare application config builds its own proxy
Worker with its own gates, and IAM receives the schema from the runner's outcome. Both are written by
repository code that runs in the container, so the platform enforces what the application reports
about itself ([ADR-0050](0050-approved-access.md)).

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

### The contract comes from the commit; the platform builds the proxy Worker

- After `resolveSource` pins the commit, Control reads the contract files at that commit and parses
  them statically ([ADR-0005](0005-compile-app-config-to-static-manifest.md)). The run stores the
  result as its snapshot (ADR-0050).
- The deployer builds the proxy Worker from the snapshot's endpoint table. An application config that
  builds its own proxy is refused.
- IAM receives the schema from `approvedSnapshot(app, env)`, never from the runner's outcome.
- The application config is still imported inside the credentialed runner. The checker and the type
  checks therefore stay advisory on Cloudflare until the runner separates a credential-free step.

The code does none of this yet (part B, work units B6 and B8).

## Consequences

- A moved branch cannot change an already selected deployment or mislabel its release and source maps.
- A force-pushed or removed commit is a pre-install failure; the source host need not keep old commits.
- An outdated runner may ignore the expected SHA. Rolling the runner forward first is the only guard;
  a deploy order mistake is an operator error, not something Control detects.
- An agent cannot change the proxy's endpoint table or the IAM schema of a Cloudflare application by
  editing its config or its build. A widening goes through the approval of ADR-0050.
- The Cloudflare build checks are weaker than on Zerops
  ([ADR-0043](0043-validate-and-render-one-zerops-descriptor-meaning.md)): repository code runs next to
  the account token, so a skipped checker is not detected.

Run ownership and how Control applies the runner's outcome follow the lease rules in
[ADR-0044](0044-zerops-delivery-ownership-and-recovery.md), which cover both clouds.

## Alternatives considered

- **Pass the branch alongside the recorded release.** It keeps the A/B race.
- **Trust the requested SHA or the executor's outcome file.** A request is not checkout evidence. An
  outcome written after repository code runs is too late to stop that code.
- **A source-protocol capability handshake** — Control checks the Worker's capability, the Worker checks
  the image's, before any job. It protects mixed-version installations, but costs an authenticated
  admission path across three components for a case that deploy order already prevents.
- **Keep the authored proxy Worker and check its gates against the contract.** Rejected: the check
  would run inside the build the agent controls, and a check that agrees with a widened contract proves
  nothing.
- **Make the checks binding on Cloudflare now.** Deferred: the config import holds the account token,
  so repository code could skip any check that runs beside it. A credential-free step comes first.
- **Move Cloudflare onto the Zerops source transport.** It adds a transporter and changes the native
  deployment path without being needed for exact checkout.
