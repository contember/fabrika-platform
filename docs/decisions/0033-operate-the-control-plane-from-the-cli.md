---
id: 0033
title: Operate the control plane from the CLI
status: accepted
date: 2026-08-18
---

# 0033 — Operate the control plane from the CLI

## Context

The Delivery control plane has exactly one client: the console SPA. Every registry, deploy and run
operation is reachable only from a browser holding a human session. That was a deliberate boundary —
sprint `fabrika-deploys-an-app-on-zerops` records `fabrika app deploy` as out of scope because "the
control plane is the entry point by design" — but the boundary was drawn around the wrong actor. It
answers where an APP AUTHOR deploys from. It says nothing about the operator, and nothing about an
agent operating an installation on the operator's behalf.

Live bring-up made the gap concrete. Establishing the current state of one installation took `zops`
for the account, `gh` for the sidecar and hand-written `curl` for everything the control plane owns,
because the control plane has no non-browser client at all. The typed contract that a client would
need already exists and is already provider-neutral: `ControlRpcContract`
(`packages/control-contract/src/rpc.ts`) covers apps, environments, secrets, variables, namespaces,
runs, `deploy` and `register`, and the console reaches it through `createRpcClient` over `/api/rpc`.
Nothing about that surface is browser-specific except the credential.

The credential is the second half of the problem, and it is worse. A fresh installation holds exactly
one credential, `FABRIKA_IAM_PROVISIONING_KEY`, and **it cannot call anything through the public
surface**. The proxy resolves a bearer by asking IAM to `mintFromKey`, which reads only DB-backed
credentials; the provisioning key is held in env and never in the DB, and is honoured only by
`resolveCaller`. Two correct decisions — keep the bootstrap credential out of the database, and make
the proxy the only enforcement point — compose into an installation that no machine can call until a
human has logged into the console and issued a key by hand. Backlog item 67 already records the
symptom, that the four RPC calls which admit the first administrator live in a throwaway script.

The control gates admit this client today and always did: `/api/*` carries both a `service` and a
`human` rule (`packages/control/fabrika.gates.ts`). Only the source-connection routes are human-only,
and they stay that way — App creation is a browser flow with a GitHub redirect in the middle, and
`requireHuman` enforcing `principal.type === 'user'` is the correct reading of ADR-0031.

## Decision

We will add a provider-neutral `fabrika control` command area that speaks the existing
`ControlRpcContract` with a machine `px_` credential, and one bootstrap command that mints that
credential.

The area is provider-neutral because the control API is. It routes through no provider or
installation package, and it adds no new server surface: every verb maps onto a procedure that the
console already calls. `fabrika control key issue` performs the bootstrap explicitly — it presents
the installation's IAM RPC key as transport authentication and its provisioning key as the ISSUER
credential to `issueKey`, and returns a DB-backed key bound to a new service principal with the
requested actions. That is the shipped form of what backlog 67 describes as a throwaway script.

The output contract follows the one the operator already knows from `zops`: stdout carries data only,
progress and errors go to stderr, and `--json` prints the procedure's result verbatim so a caller
never parses a table. A non-zero exit means the command failed, never that the answer was empty.

Credentials are read from the ENVIRONMENT ONLY and have no flag, matching `platform deploy`, so they
cannot reach a CI log or a process listing. The control origin is not a credential and takes both.

`fabrika app deploy` stays out of scope on Zerops and keeps its existing Cloudflare meaning. This ADR
moves the operator, not the app author: `control deploy` triggers a run for an app that is already
registered, through the same authorization the console passes.

## Consequences

An installation becomes operable without a browser, which is what makes an unattended live run
repeatable rather than a one-off performed by hand. The console and the CLI cannot drift, because
they call the same typed contract through the same client; a procedure added to `ControlRpcContract`
is reachable from both or neither.

Two things get harder. Machine credentials now exist in normal operation, so they must be revocable
and short-lived by habit rather than by mechanism — `issueKey` accepts `expiresAt` and `revokeKey`
exists, and nothing in this ADR forces either. And the bootstrap command needs the installation's IAM
RPC key, which is a service-to-service secret; an operator who can read it can mint an admin
credential. That is already true of anyone who can read the installation's environment, but the
command makes the path obvious, so it belongs to the operator's own tooling and not to a shared CI
step.

The `source.connection.manage` surface stays browser-only. An agent can therefore drive an
installation end to end EXCEPT for creating a GitHub App connection, and any runbook must keep that
step assigned to a human.

## Alternatives considered

**Widen the provisioning key so it traverses the proxy.** Teaching `mintFromKey` about the env-held
key would remove the bootstrap step entirely. Rejected: it puts a non-revocable, non-expiring,
installation-wide credential on the hot path of every proxy decision, and the reason it is not in the
database is precisely that it must not be resolvable like an ordinary credential.

**Put the verbs under `fabrika app`.** Rejected: that area is provider-inferred from
`fabrika.config.ts` and belongs to the app author, while these operations are the operator's and are
identical on every provider. Overloading it would make `--provider` meaningful for commands where it
is not.

**A separate `@fabrika/control-client` package.** Rejected for now as premature. The client is
`createRpcClient` from `@fabrika/app`, which the console already uses; what the CLI adds is argument
parsing and rendering. If a third caller appears, extracting the construction is mechanical.

**Leave it to the console and script the browser.** Rejected: driving a SPA to register an app is
slower, unobservable in CI, and would make the source-connection exception invisible by making
everything equally browser-shaped.
