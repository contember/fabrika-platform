# Stack presets

A **stack preset** is a thin composition of `../decisions/`: a one-line goal + a
list of decision ids. It is **not** a code generator and carries **no gotchas** —
those live on the decisions. Cross-cutting integration (e.g. the Worker entry
threading every binding into the loader context, the route table matching opice
urls) is **composed by the agent at scaffold time** from the selected decisions'
gotchas — pure-reference, no resolver code (see `../decisions/README.md`).

## A stack file

`stacks/<id>.md`:

```yaml
---
id: <kebab>            # == filename; the value stored in .fabrika config `profile`
title: <human title>
goal: <one line: from empty to a running, opice-green slice>
support: supported | unsupported   # unsupported: kept for reference, off the paved road; init and the packet warn
decisions: [id, …]     # the composition. requires-closure must hold (see below).
build: <pointer to the per-issue verify recipe, if stack-shaped>
---
```

## Invariant: the decision set must be closed and conflict-free

A valid stack is a set of decision ids where:

- every `requires` of every included decision is **also in the set** (requires-closure),
- no two decisions share an exclusive `slot` and no `conflicts` edge is violated,
- `recommends` are _optional_ — surfaced to the user at the tech gate, not auto-included.

The tech phase reads the stack, checks this by reading the decision frontmatter,
surfaces recommends, and writes the resolved, app-specific stack into
`.fabrika/architecture/tech.md` (which the human edits at the gate). Picking a stack
is a **starting point**, not a lock-in — add/drop decisions freely.

## Presets

Supported: the paved road (contract, proxy, `@fabrika/ui`, `@fabrika/db`, `fabrika-check`).

- **`zerops-app`** (the default) — local Bun + PostgreSQL + React/Buzola, Fabrika IAM and proxy access, deployed through an installed Fabrika Control plane.
- **`cf-app`** — the same contract application on Cloudflare: one Durable Object per environment over its SQLite, the proxy Worker, a local lopata run. Deployed by the installation's Control, outside the builder.

Unsupported, kept for reference: they leave the paved road, and the platform can neither check nor deploy what they build.

- **`cf-lightweight`** — buzola SPA + lopata + D1, **no SSR**. The simplest end-to-end Cloudflare stack (bun/lopata path).
- **`cf-internal-app`** — the full internal-app stack: Buzola SPA +
  Worker API, D1/R2/Queue/Cron/Workers AI, native Fabrika IAM login and Fabrika Control deploy.
- **`cf-fat`** — RRv7 **SSR** + vite + `@cloudflare/vite-plugin` (workerd) + the full CF primitive set (D1/KV/R2/Queue/AE/Cron); counts behind `count-store` so it stays locally testable.
- **`contember-app`** — a Contember (Postgres GraphQL CMS) backend + a buzola/React admin SPA bound via bindx. A Node-backend + static-SPA shape (not Workers/D1).
- **`content-site`** — a Bun-native static content site: pletivo SSG + Preact islands + Tailwind. No SSR, no vite — fits the bun/non-vite preference.
