---
id: 34
title: Adopt existing Poplach state and retire the standalone app
blocked-by:
  - ./35-prove-operations-browser-and-sdk-workflows.md
---

# 34 — Adopt existing Poplach state and retire the standalone app

**Summary.** Cut existing users and data over to Fabrika Operations, then remove
the duplicate repository, deployment, and package dependencies.

## Problem

Absorbing code does not migrate an existing installation. Poplach project ids,
API keys, source maps, raw events, issue state, activity, alert rules, channels,
and count history need explicit treatment. A flag-day replacement could lose
triage history or break deployed Sentry clients. Running both indefinitely would
leave two authorities and double alert delivery.

## Approach / acceptance

- Inventory actual deployed Poplach environments and classify each state type as
  migrate, reconstruct, rotate, retain read-only, or discard.
- Map Poplach projects to Fabrika application environments with an operator-
  reviewable plan and collision checks.
- Preserve issue identity, mutable triage state, activity, source maps, and alert
  policy where the target model supports them.
- Provide a credential overlap or explicit rotation window so applications do
  not lose events during cutover.
- Prevent duplicate processing and notification while both ingest endpoints may
  be live.
- Verify counts and representative issue histories before switching the console
  and routing.
- Remove the standalone Poplach deployment and archive its repository only after
  the integrated service is the sole writer and rollback evidence is recorded.

If no live Poplach installation exists, the migration path should collapse to a
documented no-op rather than manufacturing compatibility machinery.

## Touch points

- Operations migrations and adoption tooling
- control registry and provider routing
- Cloudflare resource adoption where applicable
- `projects/oss/poplach/`
- CI, release, and documentation references

<!-- Origin: ../ideas/operations-plane.md and ADR-0016. -->
