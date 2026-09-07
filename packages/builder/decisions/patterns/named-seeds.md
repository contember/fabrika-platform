---
id: named-seeds
kind: pattern
title: Named idempotent seeds (vs self-provisioning)
slot: seed-strategy
provides: [seed-strategy, foundation-manifest]
requires: [d1]
recommends: [opice]
conflicts: []
npm: []
status: stable
sources:
  - where: "Pattern. Reference: opice skeleton metadata `seeds: [...]` + fabrika `induce`."
    read: "How the union of `seeds` across skeletons induces a foundation 'seed infra' issue."
---

# Named idempotent seeds

## What it is

The seed strategy fabrika prefers: **one SQL file per named seed** (`seeds/<name>.sql`,
filename = opice `seeds: ['<name>']`), purely **idempotent** (`INSERT OR IGNORE` /
`ON CONFLICT DO NOTHING`, keyed on stable ids), applied before a test. The
alternative is **self-provisioning** (register through the UI with `Date.now()`
markers, `seeds: []`).

## When & why to use

- You want "seeds = foundation manifest": fabrika induces a foundation data issue from the **union of `seeds`** across skeletons. Named seeds make that induction strong.
- Data that pre-exists for a flow (catalog, members, projects, mixed issues).

## When NOT to use (fallback)

- Flows where a seed makes no sense (**signup**) → `seeds: []` + **self-provisioning** with `Date.now()` markers. This is the explicit fallback, not a competing slot.

## Impacts & gotchas

- **Idempotent or it breaks the verify loop** — the app stays up between iterations and reseeding must tolerate repeats.
- Some seeds also stage non-D1 fixtures (R2 object, KV key) via a small `seeds/<name>.ts`.
- Apply: `lopata d1 execute DB --file seeds/<name>.sql` (local-first) or `wrangler d1 execute DB --local --file …`.

## Relationships — why

- **requires `d1`** — seeds are SQL into the relational store.
- **recommends `opice`** — the filename↔metadata link (`seeds: ['<name>']`) is the contract that drives induction.
