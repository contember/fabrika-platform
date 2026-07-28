---
id: 09
title: Confirm Zerops allows multiple custom domains on one service
blocked-by: []
---

# 09 — Confirm Zerops allows multiple custom domains on one service

**Summary.** Open question, and the proxy design depends on the answer.

## Problem

[ADR-0007](../decisions/0007-proxy-based-auth-enforcement.md) makes the proxy the
only publicly routed service in an environment project, fronting every app in it.
That requires **many custom domains pointing at one service**.

Zerops documents three public-access methods — subdomain, custom domain, direct port
— but the [access & networking page](https://docs.zerops.io/features/access) does
**not** state whether a single service may hold multiple custom domains. See
[`../reference/zerops-platform.md`](../reference/zerops-platform.md).

If the answer is no, the proxy topology has to change — most likely one proxy
service per domain, which multiplies the deployables the ADR was trying to avoid.

## Approach / acceptance

Verify against a live project (GUI and the REST API). Acceptance: a documented
answer in `../reference/zerops-platform.md` with a source or an observed result;
if it's negative, a follow-up ADR revisiting the proxy topology.

## Touch points

`../reference/zerops-platform.md`, the proxy deployment design.
