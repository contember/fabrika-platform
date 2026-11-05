---
id: 277
title: A partial platform deploy leaves a newer release's environment on older code
blocked-by: []
---

# 277 — A partial platform deploy leaves a newer release's environment on older code

**Summary.** `fabrika platform deploy` on Zerops writes the environment of all four services before it builds any. A
run that stops between the two leaves each unbuilt service with the new variables and the old code, and that mix
boots at the next restart. Medium.

## Problem

`packages/provider-zerops/src/installation/deploy.ts` ("Write the service environment") reads and checks every
service's environment, writes it for `iam`, `operations`, `proxy` and `control` in `PLATFORM_DEPLOY_ORDER`, and only
then builds: `iam` and `operations` together, then `proxy`, then `control`. The order is deliberate, as the comment
above the builds says. A proxy build that does not go ACTIVE leaves the previous manifest in front of the previous
code, and `ENVIRONMENT` is in place before any service that refuses `local` restarts.

The price is the gap between the write and the build. A Zerops env write does not restart a service, so nothing
breaks at once. But when the run fails, is cancelled or times out after the writes, each service it did not build
keeps the new values on the old code. The next restart boots that pair: an operator's restart, a node move, a scale
event. A variable that only the new release reads is harmless. A value the old release refuses, such as a provider
name it does not know or a changed format, stops that service. One production outage had this shape, though there
it came from a hand edit (backlog [276](276-iam-serves-sign-in-on-an-invalid-mail-transport.md)).

## Approach / acceptance

1. Each service's environment is written right before that service's build, after every service's environment has
   been read and checked (the refusal still leaves nothing half-written). `iam` and `operations` are written, then
   built together. Then `proxy` is written and built, then `control`.
2. The fail-closed properties the comment names survive: the proxy's manifest still rides in its own archive, and
   `control` still builds only after the proxy went ACTIVE. Each value one service reads from another is in place
   before the reader restarts: the IAM proxy secret, the table digests, `ENVIRONMENT`.
3. A run that stops partway prints which services carry the new environment and which still run the old release,
   and that re-running the same tag converges them.
4. The commit states the rollout path. An existing installation needs no step: the next `platform deploy` writes and
   builds in the new order.

Witness: a deploy test with the emulated Zerops API fails the `proxy` build. `control` keeps its previous environment,
and `iam` and `operations` carry the new one.

## Touch points

`packages/provider-zerops/src/installation/deploy.ts` (`desiredServiceEnv`, `applyServiceEnv`, `deployConcurrently`,
`deployPlatformService`), its tests, `docs/reference/zerops-platform.md` if the order is recorded there.

<!-- Origin: the root-cause review of an IAM outage on a production Zerops installation (2026-10). -->
