---
id: 0003
title: No deploy runner on Zerops — Control drives the platform over HTTP
status: accepted
date: 2026-10-07
---

# 0003 — No deploy runner on Zerops — Control drives the platform over HTTP

## Context

On Cloudflare, a deploy needs a container. `wrangler deploy` needs a filesystem, and the
app's build needs `bun install`. Workers have neither. Control therefore hands each run to a
Cloudflare Container, run by a separate runner Worker so that an operator's redeploy of Control does not reset the
containers executing application deploys.

Zerops has its own build pipeline: a build container with a filesystem and a shell, triggered
through the REST API and not charged separately
([pipeline docs](https://docs.zerops.io/features/pipeline)). Everything fabrika would start a
container for, Zerops already does. What remains for fabrika is HTTP work: write secrets,
apply the import YAML, create an app version, upload the source, trigger the build, poll the
status, and reconcile the authorization schema.

## Decision

We will not run a deploy runner on Zerops. Control executes the whole Zerops delivery path
in-process, over the Zerops REST API:

- it fetches the application's GitHub tarball and streams it to the app version's upload URL
  ([ADR-0029](0029-github-app-sources.md) covers sources and
  credentials);
- it triggers the build and polls the version to a terminal state;
- it writes managed configuration and reconciles the authorization schema.

No other service takes part in a Zerops deploy. Zerops, not fabrika, runs the build and the
deploy, so a Control restart does not interrupt a build. Run state lives in the database, and
Control settles in-flight runs on restart. Control never deploys the installation it runs in
([ADR-0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)). Recovery and run ownership are defined in
[ADR-0044](0044-zerops-delivery-ownership-and-recovery.md).

**Invariant: the runner is a Cloudflare-only component.** The provider contract must not assume
that a runner exists.

## Consequences

- A Zerops installation has no container image, no runner deployment, and no runner/Control
  version skew.
- An operator's redeploy of Control is not a special case on Zerops: in-flight runs settle on restart.
- Control must be crash-safe across a deploy. A run whose state is only in memory is a lost run.
- Log relay is pull-based. Log latency and granularity are what Zerops offers.
- Source upload streams through Control. Control must not buffer a whole tarball.

## Alternatives considered

- **Port the container runner to Zerops.** It duplicates a capability that Zerops provides
  for free, and makes fabrika own build isolation, caching, and timeouts.
- **A separate source-transport service next to Control.** It adds a deployable, an RPC key,
  and a wire protocol to move bytes that Control can stream itself.
- **Keep the runner/Control split on Zerops for symmetry.** The split exists only so a Control
  redeploy does not reset running containers. On Zerops no container runs inside Control.
- **Block until the deploy finishes in one request.** A Control restart orphans the run.
  Restart recovery is needed for crashes anyway.
