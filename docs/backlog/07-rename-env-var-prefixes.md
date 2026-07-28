---
id: 07
title: Sweep VOZKA_* env vars to FABRIKA_*; decide whether PROPUSTKA_* follows
blocked-by: []
---

# 07 — Sweep `VOZKA_*` env vars to `FABRIKA_*`; decide whether `PROPUSTKA_*` follows

**Summary.** The package rename in
[ADR-0001](../decisions/0001-merge-propustka-and-vozka.md) left the environment
variable prefixes untouched. Finish the rename — and settle the open half.

## Problem

Phase 0 was deliberately **behaviour-neutral**, so renaming env vars was excluded
from it: an env-var rename is an operational break for every existing deployment,
which is exactly what phase 0 promised not to be. The result is a repo where the
packages say `@fabrika/*` and the runtime says `VOZKA_*`.

**Open:** whether `PROPUSTKA_*` follows. Unlike `VOZKA_*`, these prefixes may appear
in downstream app configuration, not just in fabrika's own deployments — so the
blast radius is different and the answer is not automatically "yes". Not decided;
do not assume.

## Approach / acceptance

Sweep `VOZKA_*` → `FABRIKA_*` with a deprecation window (read the old name, warn,
prefer the new) rather than a hard cutover, unless someone decides otherwise.

Decide `PROPUSTKA_*` explicitly, with the downstream consumers (poplach, revizor,
opice) accounted for — and record the outcome, since "we chose to leave it" is
itself a decision a future reader will question.

Acceptance: no `VOZKA_` string remains in the repo outside the compatibility shim;
the `PROPUSTKA_*` question has a written answer.

## Touch points

`@fabrika/control`, `@fabrika/engine`, `@fabrika/cli`, `@fabrika/iam`, deployment
configs, docs.
