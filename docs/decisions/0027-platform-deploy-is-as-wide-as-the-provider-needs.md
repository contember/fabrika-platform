---
id: 0027
title: `platform deploy` is as wide as its provider needs, not uniformly wide
status: accepted
date: 2026-08-06
---

# 0027 — `platform deploy` is as wide as its provider needs, not uniformly wide

## Context

[ADR-0025](./0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) made
`fabrika platform deploy` the public interface an operator's pipeline calls. It did not say how much
of an installation that command deploys, and the two providers had already answered differently
without anyone writing it down.

**On Cloudflare the order lives in the operator's pipeline.** The scaffolded workflow
(`packages/installation-cloudflare/src/templates/platform.yml`) runs three steps: IAM (`:96`),
Operations (`:123`), then the runner and control plane (`:136`). The first two are `fabrika app
deploy` against a package directory; only the third is `fabrika platform deploy`, and
`deployPlatform` (`packages/installation-cloudflare/src/installation.ts:14-33`) composes exactly that
runner+control pair. So the command is narrow and the YAML holds the sequence.

**On Zerops the command did not exist at all.** `packages/installation-zerops/src/index.ts:16`
declares `commands: ['plan']`. Bringing the live installation to HEAD on 2026-08-05 took `zops push`
from a laptop, once per service, in a hand-chosen order — and the knowledge that made that run
correct stayed in a run log.

Backlog 61 proposed resolving this by giving the shared `@fabrika/installation-contract` the order,
with each provider owning only its per-service mechanics. Writing the Zerops implementation showed
that the two providers do not have the same shape of work to order:

- **Zerops has no runner** ([ADR-0003](./0003-no-deploy-runner-on-zerops.md)). A Cloudflare stage is "enter
  a package directory and run a deploy that shells out to `wrangler`"; a Zerops deploy is
  `triggerPipeline` against a **service id**, naming a setup from the repository-root `zerops.yaml`.
  There is no directory to enter and no per-package config to point at, so the Cloudflare stage shape
  does not translate.
- **The proxy manifest is cross-service state that must move with the code it describes.** Enforcement
  configuration for IAM, the console and Operations is one `FABRIKA_PROXY_MANIFEST_JSON` document on
  one proxy service. Regenerating it and applying it must happen in the same run as the deploy, or
  enforcement silently describes a previous version of the gate modules. No single pipeline step owns
  that document, because it spans every service the pipeline deploys.
- **The order carries a security property, not just a dependency.** Since
  [ADR-0022](./0022-the-proxy-is-the-only-enforcement-point.md) the application enforces nothing, so
  deploying control at a new version while the previous permissive manifest is still live leaves
  `/api/*` open for the length of the deploy. That is an invariant worth holding in code with a test,
  rather than in the ordering of steps in a YAML file an operator owns and may edit.

## Decision

We will let `platform deploy` be **as wide as its provider needs**, and we will say which is which
rather than forcing them to match.

- **On Zerops, `fabrika platform deploy` owns the whole ordered sequence**: resolve the project and
  its services, write the service environment (including the generated proxy manifest and the
  installation's environment name), deploy IAM → Operations → proxy → control waiting for each,
  reconcile the console's app schema, and ensure the proxy's public entry point. The operator's
  pipeline calls one step.
- **On Cloudflare, `fabrika platform deploy` stays narrow** and the scaffolded workflow keeps the
  order, as it ships today.
- `@fabrika/installation-contract` keeps owning **the command surface** — which commands a provider
  offers and how they are invoked — and does **not** own the deploy order. Backlog 61's "the contract
  owning the order" is superseded by this ADR.

**Invariant: whatever owns the order must apply the proxy manifest in the same run as the code it
describes, and must fail closed — a deploy that cannot apply the manifest must not leave the previous
manifest in front of new code.**

## Consequences

- An operator's Zerops pipeline is trivial to generate and hard to get wrong: one step, no ordering
  for a human to preserve across edits. That is what backlog 62 will emit.
- The ordering invariant becomes testable on the Zerops path, because it is code rather than YAML.
- **The two providers now differ in a user-visible way**, and the usage text and docs must say so
  plainly. Someone reading only the Cloudflare path will guess wrong about Zerops, and vice versa.
- Cloudflare keeps a shape whose ordering lives in a file the operator can edit. That is a real
  weakness this ADR does not fix — it accepts it, because the Cloudflare path is in service and
  cannot currently be exercised end to end against an account, so rewriting it is a change we could
  not verify. If that changes, revisit.
- `fabrika platform deploy --provider=zerops` becomes a long-running command that talks to a live
  account. It must take every credential from its environment, never prompt, never log a secret, and
  be idempotent: a re-run is a redeploy, not a bring-up.

## Alternatives considered

**Put the order in `@fabrika/installation-contract` and make both providers implement it** — backlog
61's original proposal. It loses because the two providers' units of work are not the same kind of
thing: a contract-level "deploy IAM, then Operations" would have to be either a directory-and-command
pair (meaningless on Zerops) or a service-id-and-setup pair (meaningless on Cloudflare). The
abstraction would exist only to make two sentences look alike.

**Mirror Cloudflare: put the order in a scaffolded Zerops pipeline and keep `platform deploy`
narrow.** Consistent across providers, and rejected for two reasons. It leaves the proxy manifest
without an owner — it spans the services the pipeline deploys, so no step can regenerate and apply it
coherently. And it puts a security-bearing sequence in a file the operator owns, where an edit that
reorders two steps opens `/api/*` for the length of a deploy with nothing to catch it.

**Widen Cloudflare to match Zerops**, moving the order out of `platform.yml` into `platform deploy`.
The cleanest end state, and deferred rather than refused: it means rewriting a path that is in
service and that we cannot currently exercise against a live account. Doing it blind trades a known
asymmetry for an unknown regression.
