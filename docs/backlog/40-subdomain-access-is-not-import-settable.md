---
id: 40
title: Subdomain access cannot be established by an import document
blocked-by: []
---

# 40 — Subdomain access cannot be established by an import document

**Summary.** `enableSubdomainAccess: true` does not take effect on a service that
has never been deployed. The `zerops-subdomain` public-access path therefore
provisions a project with no public entry point and reports success.

## Problem

`PublicAccess = 'custom-domain' | 'zerops-subdomain'`
([`../../packages/installation-zerops/zerops/topology.ts`](../../packages/installation-zerops/zerops/topology.ts))
selects how a project's proxy is published, and `zerops-subdomain` is the only
branch that ever writes `enableSubdomainAccess: true` — on the proxy, for throwaway
environments.

A live-verified upstream note records that after an import the service still reads
`subdomainAccess: false`, and that enabling it explicitly fails with
`Service stack is not http or https`. The subdomain needs a **deployed HTTP port**,
so an import document cannot establish it on its own. Our bring-up order makes that
guaranteed to bite: [ADR-0004](../decisions/0004-secrets-live-in-the-platform.md)
provisions every service `startWithoutCode: true`, so at import time nothing has a
deployed port.

Production is unaffected — it takes `custom-domain`, and the import format has no
field for one, so that step is already manual by construction. The failure is
confined to the throwaway path, where it is silent: the import succeeds, the
project comes up, and nothing is reachable.

## Approach / acceptance

- Confirm the behaviour on a live account, including whether the flag is accepted
  and ignored or rejected.
- Make the `zerops-subdomain` path enable the subdomain **after** the proxy's first
  successful deploy, rather than declaring it in the import — or drop the branch and
  document the manual toggle, if the automation is not worth its weight for a
  throwaway environment.
- Whichever is chosen, the declaration must not claim something the import cannot
  deliver: either the field stops being written at import time, or the topology
  states plainly that it is a no-op until first deploy.
- Acceptance: a throwaway environment brought up through the `zerops-subdomain` path
  is publicly reachable at the end of bring-up without a GUI step, or the bring-up
  documentation names the GUI step explicitly.

## Touch points

- `packages/installation-zerops/zerops/topology.ts`
- `packages/provider-zerops/src/namespace.ts` (namespace `publicAccess`)
- [`./05-bring-up-on-a-real-zerops-account.md`](./05-bring-up-on-a-real-zerops-account.md)

<!-- Origin: Zerops skill conformance review, 2026-07-31. -->
