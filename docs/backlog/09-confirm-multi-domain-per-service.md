---
id: 09
title: Confirm Zerops allows multiple custom domains on one service
blocked-by: []
---

# 09 — Confirm Zerops allows multiple custom domains on one service

**Summary.** Near-settled in ADR-0007's favour. Upstream's custom-domain procedure
takes **more than one domain per service**, so the one-proxy-fronts-many-apps
topology holds. What remains is confirming it on an account and writing it down.

## What upstream says

The custom-domain setup flow is: assign IP addresses → service detail → _Setup first
domain access_ → **"enter one or more domains"**, choose SSL management → define
routing rules, where a rule maps a public path to a service plus an internal port.
Both halves point the same way: many domains terminate on one service, and the L7
balancer routes among them.

Two operational facts that come with it, and that the bring-up will need:

- A shared IPv4 requires **both** A and AAAA records — Zerops reverse-looks-up the
  AAAA record to verify ownership for SNI routing, and without it routing fails
  **silently**. A dedicated IPv4 is the production recommendation.
- A plain domain validates over HTTP-01, so it must already route to the service
  before the certificate can issue. Wildcards need DNS-01
  (`CNAME _acme-challenge.<domain>` → `<domain>.zerops.zone`).

Not yet observed on a live account, so the ADR-0007 topology is well-supported rather
than proven.

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

Bind two custom domains to one proxy service on a live project (GUI and the REST
API) and confirm both route. Acceptance: a documented answer in
`../reference/zerops-platform.md` with the observed result, plus the DNS and
certificate prerequisites above; if it turns out negative, a follow-up ADR revisiting
the proxy topology.

## Touch points

`../reference/zerops-platform.md`, the proxy deployment design.
