---
id: 12
title: Ratify (or replace) how the proxy gets its manifest on Zerops
blocked-by: []
---

# 12 — Ratify (or replace) how the proxy gets its manifest on Zerops

[`08`](./08-distribute-gate-config-to-proxy.md) chose **redeploy** as the mechanism
for getting gate config to the auth service, on the reasoning that gates only change
at app deploy time and a manifest baked at build time cannot fail to load at 3am.

Implementing the Zerops topology exposed a wrinkle that decision did not anticipate:
on Zerops the driver has **no filesystem**, so there is nothing to bake a file into.
The root `zerops.yaml` therefore materializes `proxy.manifest.json` at build time
from a `FABRIKA_PROXY_MANIFEST_JSON` service variable.

**Nothing writes that variable today**, and whether a build container can even see
service-level variables is unverified.

This was a mechanical decision taken mid-implementation to keep the topology
coherent, not a considered one. It deserves ratification or replacement by someone
who has thought about it, because it sits on the enforcement path for every app.

## What to weigh

- The build **fails closed** on an empty manifest, and the auth service denies when
  no gate rule matches — so an empty or missing manifest is safe by construction.
  That property must stay deliberate and tested, not incidental.
- Writing the manifest into a service variable means gate config passes through the
  same channel as secrets, which is a channel we otherwise keep narrow.
- The alternative [`08`](./08-distribute-gate-config-to-proxy.md) already names —
  fetch at startup from the IAM service, fail closed if unavailable — costs a
  startup dependency but removes the build-time variable entirely, and the auth
  service already talks to IAM.

## Acceptance

The mechanism is chosen deliberately and written down; something actually writes the
manifest; and the empty/unavailable path is proven to deny, with a test.
