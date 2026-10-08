---
id: 81
title: Exercise a private keyed deploy in the local stack
blocked-by: []
---

# 81 — Exercise a private keyed deploy in the local stack

**Summary.** The local stack can compose a keyed source connection but can never use one: Control's
source mints installation tokens against `api.github.com`, which the local stack answers with 404, so no local app can hold a private binding
and no webhook delivery can trigger a bound deploy. Effort M.

## Problem

`packages/local-stack/src/source-connection-fixture.ts` seeds two keyed connections with
synthetic App ids and a locally generated private key, and
`source-connection-fixture-seed.ts` publishes them into `github_source_connections_keyed` with their
keys in Control's vault. Nothing can deploy through them.

An app bound to a connection takes the keyed path: `run-lifecycle` passes the binding,
`provider-zerops/src/control.ts` calls the source port's `resolve` with `privateBinding`, and
`packages/control/src/source/credentials.ts` mints a repository token through `GitHubAppClient`. The
only seam is `githubAppFetch` (`packages/control/src/zerops/provider.ts`), which
`packages/local-stack/src/control-server.ts` answers with 404, and `compose.yaml` has no GitHub double.
The synthetic App is not a real App, so the mint fails and the deploy fails with it.

Two consequences are visible in `packages/local-stack/src/smoke.ts` today:

- `notes` must stay registered anonymously, so its deploy runs on the public-repository path.
- `proveScopedWebhookSignature` can prove only that the scoped route resolves the connection's vault
  secret and accepts the HMAC. `handleWebhook` then answers 204, because no application is bound to
  that connection. The deploy it used to trigger is now a manual `POST /deploy`.

So the keyed private path — credential selection by connection, token minting, private tarball
resolve, and a delivery that reaches a bound application — has no deterministic witness. Only a live
installation exercises it, which is exactly the gap the retirement of the v1 path leaned on.

## Approach / acceptance

Two options, to be decided rather than assumed:

1. **A GitHub API double.** Add a small service to `compose.yaml` answering the three endpoints
   Control's source needs (App JWT → installation token, commit for a ref, the root `zerops.yaml`, and the
   codeload redirect), reached through the existing `GitHubSourceSeams`. The seam must stay a
   composition input, never an operator-facing setting: ADR-0029 fixes production origins to
   `api.github.com` and `codeload.github.com`. Acceptance: `bun run local:smoke` registers `notes` against a fixture connection, a signed
   push to that connection's scoped route answers 200 with exactly one triggered run, and the run
   succeeds through the keyed resolve.

2. **Record that the live installation is the only witness.** Write the decision down instead of
   building the double, and state in `docs/reference/local-development.md` what the local stack does
   and does not cover, so the next reader does not mistake a green `local:smoke` for coverage of the
   private path.

Either way the outcome is explicit: today the absence is undocumented and easy to misread.

## Touch points

`packages/local-stack/compose.yaml`, `packages/local-stack/src/{smoke,source-connection-fixture,source-connection-fixture-seed}.ts`,
`packages/local-stack/src/control-server.ts`, `docs/reference/local-development.md`.

<!-- Origin: sprint-2026-08-21-cheap-rebuild-from-scratch, WU1 — found while making the smoke's scoped webhook coherent. -->
