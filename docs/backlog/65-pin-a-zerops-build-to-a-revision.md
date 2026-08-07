---
id: 65
title: Pin a Zerops build to a revision, or record that it cannot be
blocked-by: []
---

# 65 — Pin a Zerops build to a revision, or record that it cannot be

**Summary.** On Zerops a build source names a **repository**, not a revision, so "which version is this
installation running" has no answer for the code Zerops builds — only for the pipeline that triggers
it. Settle it against the live platform and reconcile
[ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md), which states
otherwise. Effort S to settle, unknown to fix.

## Problem

`triggerPipeline`'s `buildFromGit` is documented in our own client as _"a one-time build from that
PUBLIC repository URL"_ (`packages/provider-zerops/src/api.ts:246-256`), and every caller passes a bare
URL — `FABRIKA_PROXY_SOURCE = 'https://github.com/contember/fabrika-platform'`
(`packages/installation-zerops/zerops/topology.ts:126`). `docs/reference/zerops-platform.md:100-102`
already records the honest position: _"The public documentation does not establish that this URL is an
immutable content pin."_

Two consequences, one of them drift in a decision:

- **The sidecar's pin is half a pin.** `fabrika.ref` pins what `platform deploy` DOES — the order, the
  composed proxy manifest, the gate sets, the console schema, every written variable — but not the
  revision Zerops BUILDS. The two agree only while the pinned tag happens to be the tip of whatever
  branch Zerops resolves. Two installations pinned to the same tag can be running different service
  code, and nothing reports it. The generated sidecar README says this rather than implying otherwise.
- **ADR-0025:72 is wrong about the code as it stands.** It states `proxyBuildFromGit` _"names a **tag**
  of `github.com/contember/fabrika-platform`"_. It does not — it names the repository. This is drift,
  not a not-yet-built gap, so `docs/CLAUDE.md`'s rule applies: say so, don't silently pick a side. ADRs
  are immutable, so the correction is a short superseding/amending ADR, never an edit to 0025.

## Approach / acceptance

Settle the platform question first, live, the way `sprint-2026-08-03-zerops-live-bringup` settled the
rest of `reference/zerops-platform.md`. Nothing in this repository or in Zerops' published docs
establishes a `<url>@<ref>` form; do not invent one.

1. **Ask the platform.** Does `trigger-pipeline` (or the import format's `buildFromGit`) accept a
   revision, tag, or ref in any form? Try it against `fabrika-test` and record the response verbatim.
2. Then one of:
   - **It can be pinned** → pass the same tag `fabrika.ref` carries, everywhere `buildFromGit` is set,
     and the sidecar's pin becomes whole.
   - **It cannot** → record it as a platform fact in `reference/zerops-platform.md` alongside the
     existing caveat, and write the amending ADR. Then decide whether an installation should record the
     commit it actually built (readable after the fact) even though it could not choose it.

Acceptance: `reference/zerops-platform.md` states the answer with live evidence, ADR-0025's claim is
reconciled by a new ADR, and — if pinning is possible — a `platform deploy` at a given `fabrika.ref`
builds the same service code twice in a row regardless of what moved on the default branch meanwhile.

Related but **not** the same as [47](./47-give-the-zerops-path-a-private-git-source.md): 47 is about
reaching a **private** source at all; this is about identifying **which revision** of a source — public
or private — was built. Fixing 47 through the repository integration may change the answer here, so
settle 47's mechanism before building anything for this one.

## Touch points

`packages/provider-zerops/src/api.ts`, `packages/installation-zerops/zerops/topology.ts`,
`packages/installation-zerops/src/templates/README.md`, `docs/reference/zerops-platform.md`,
a new `docs/decisions/`.

<!-- Origin: sprint-2026-08-06-zerops-platform-deploy run log, WU4. -->
