---
id: 179
title: Build a platform distribution that bundles extra email adapters
blocked-by: []
---

# 179 — Build a platform distribution that bundles extra email adapters

**Summary.** A separate repository builds IAM and Control images from a platform release plus extra email adapters,
passed in as composition inputs. An installation then sends through a provider fabrika does not build in, without a
relay and without a fork. Large; two platform changes and one constraint come first.

## Problem

[ADR-0019](../decisions/0019-portable-outbound-email.md) gives each service its providers as a registry from its
composition. IAM's Bun runtime takes one (`createRuntime(source, { emailProviders })`), and the Worker entry
composes its own. But both providers build IAM and Control from this repository's release: the Zerops sidecar pins
it in `fabrika.ref`, and the Cloudflare platform deploy builds the release's own entries. No step adds a package to
that build, so an installation transport can use only `builtinEmailProviders`.

## Approach / acceptance

A distribution repository holds a lock of the platform release and the adapter packages, and an entry for IAM and
for Control that composes `builtinEmailProviders` with the extra providers. It builds images the installation deploys
in place of the release's own.

It requires:

1. **Another build source in both providers.** The Zerops sidecar and the Cloudflare platform deploy build IAM and
   Control from the distribution repository instead of this one, with the same pinning
   ([ADR-0045](../decisions/0045-upload-immutable-platform-and-namespace-proxy-sources.md)).
2. **A version lock.** An adapter is built against one `@fabrika/email` major version. The distribution pins the
   platform release and every adapter together, and a platform upgrade fails its build when an adapter does not
   match. Each adapter passes the conformance kit in the distribution's CI.
3. **IAM's local-only guard stays.** The distribution adds providers through the registry only. It never passes a
   sender through `EMAIL_SENDER`, which IAM refuses outside `ENVIRONMENT=local`, and that guard is not relaxed.

Witness: a distribution that adds a stub provider builds both images, the stub passes the conformance kit, and an
installation configured with `FABRIKA_EMAIL_PROVIDER=<stub>` sends IAM's and an application's mail through it.

Consider [backlog 178](178-an-http-mail-relay-protocol-and-a-relay-adapter.md) first: a relay reaches any adapter
without changing how the platform is built.

## Touch points

`packages/iam/src/index.ts`, `packages/iam/src/node/runtime.ts`, Control's composition, the Zerops sidecar scaffold
(`packages/installation-init`, `packages/provider-zerops/src/installation/`), the Cloudflare platform deploy
(`packages/provider-cloudflare/src/installation/`), `docs/reference/release-process.md`.

<!-- Origin: the application-mail work (ADR-0019, rejected alternative "IAM loads adapters by package name"). -->
