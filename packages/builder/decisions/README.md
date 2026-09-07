# Decisions catalog

A **catalog of atomic, self-contained stack decisions** plus thin **stack presets**
(`../stacks/`) that compose them. Replaces the old monolithic `profiles/*/profile.ts`
(where cf-fat had to copy ~80% of cf-lightweight): each choice is one referenceable
`.md`, and a stack is just a list of decision ids.

fabrika core stays **stack-neutral** and consumes this as data — a **curated
reference, not a code generator** (no templates). There is **no resolver code**: the
graph is consumed _pure-reference_ by the **tech phase** (`phases.ts` phase 4) — the
agent reads the selected stack's decisions, resolves the graph by reading, composes
the concrete stack into `.fabrika/architecture/tech.md`, and the human edits it at the gate.

This catalog is **not copied** into the target repo at `init`. It lives here in the
fabrika tree and is delivered by **absolute path**: `fabrika builder next` (tech) and `fabrika
build` resolve the active `profile` to `stacks/<profile>.md` + this `decisions/` dir
and emit them as a `Stack:` pointer in the packet (see `cli/src/catalog.ts`).

> **Team preference: Bun, lopata, non-vite.** When composing a stack, default to
> `bun` (runtime/toolchain) and `lopata` (local CF runtime, over `cloudflare-vite-plugin`),
> and prefer Bun-native bundling (`@buzola/bun-plugin`, pletivo's Bun build) over `vite`
> wherever a decision offers it. `vite` stays a scoped exception for libs that mandate it
> (React Router v7).

## Two orthogonal axes: `kind` and `status`

Every decision is classified on two independent axes.

**`kind`** — _what sort of thing it is_ (and which subfolder it lives in):

| kind         | folder          | what it is                                                                                                                                                                   | has a package?     |
| ------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `technology` | `technologies/` | a concrete lib / service / framework you **adopt & install** (cloudflare, react, contember, pletivo, opice…)                                                                 | yes (`npm`/binary) |
| `pattern`    | `patterns/`     | an architectural recipe you **apply** _over_ technologies — no package; it `requires` the technologies it composes (count-store, write-split, named-seeds, auth-password-kv) | no                 |
| `tooling`    | `tooling/`      | an **additive** dev tool outside the runtime stack (deptective, edvabe) — never part of a preset's closure                                                                   | yes                |

`kind` is **orthogonal to `slot`**: a pattern can still fill a slot (`named-seeds`→`seed-strategy`, `auth-password-kv`→`authentication`).

**`status`** — _how prod-ready it is_: `stable` | `wip` | `experimental`.

> **Selection policy.** The tech phase **defaults to `stable`**. `wip`/`experimental`
> are opt-in: surface them only when the goal specifically calls for one, flag them as
> not-prod-ready, and **never auto-recommend** them. A preset that includes a non-stable
> decision must say so.

## A decision file

`decisions/<kind>/<id>.md` — ids are **globally unique** across the subfolders (a stack
references a decision by bare id, never by path). Frontmatter is the machine-readable
graph; the body is the human/agent reference (what it is, when/why, tradeoffs, impacts,
gotchas, sources). Patterns use the same schema minus `npm`, and their body says what
they **apply to** rather than how to install. Schema:

```yaml
---
id: <kebab-case>          # == filename; globally unique
kind: technology|pattern|tooling
title: <human title>
slot: <slot|null>         # exclusive slot it fills (router, platform, relational-db…).
                          # two decisions in the same slot conflict implicitly.
provides: [capability]    # capability tags this decision fulfills
requires: [id, …]         # HARD deps — must also be in the stack
recommends: [id, …]       # SOFT suggestions — offer, don't force
conflicts: [id, …]        # explicit incompatibilities (beyond same-slot)
npm: [pkg@^baseline, …]   # technologies/tooling only; REFERENCE baseline (verify against installed)
status: stable|wip|experimental
sources:                  # live truth to READ before scaffolding (anti-staleness)
  - where: <repo path / npm pkg / URL>
    read: <what to read it for>
---
```

## The three edge types (everything the graph needs)

- **`requires`** — hard dependency. Pick A ⇒ B must be in the stack. `vozka →
  {cloudflare, oblaka, wrangler, propustka}`, `buzola → react`, `write-split → analytics-engine`.
- **`recommends`** — soft suggestion. Pick A ⇒ offer B. `cloudflare → d1, durable-objects`.
- **`conflicts`** — declared incompatibility. `buzola ✕ react-router` (both routers).
  Often _implied_ by two decisions sharing an exclusive **`slot`**, so `conflicts` is
  only written where same-slot detection isn't enough.

`provides` is the capability vocabulary the edges talk about; `slot` is the
single-occupancy version of a capability (a stack has one `router`, one `platform`).

## Dangling references are fine

A `requires`/`recommends`/`conflicts` id that has no file yet is a **TODO marker**,
not an error — same convention as memory `[[links]]`.

## Stack presets (`../stacks/`)

A preset is **thin**: a one-line goal + a list of decision ids (technologies + patterns;
tooling is additive, not part of closure). All gotchas/conventions live on the decisions.
See `../stacks/README.md`.

## Catalog

### Technologies (`technologies/`)

| slot / area                        | decisions                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| platform / edge auth               | `cloudflare`, `cloudflare-access` (legacy alternative to native Propustka)       |
| relational store (`relational-db`) | `d1`, `postgres`                                                                 |
| storage / state                    | `kv`, `r2`, `durable-objects`, `analytics-engine`                                |
| messaging / jobs                   | `queue`, `cron-triggers`                                                         |
| AI runtime                         | `workers-ai`                                                                     |
| runtime / build / iac / deploy     | `bun`, `vite`, `lopata`, `cloudflare-vite-plugin`, `oblaka`, `wrangler`, `vozka` |
| ui framework                       | `react`, `preact`                                                                |
| router                             | `react-router`, `buzola`                                                         |
| styling                            | `tailwind`                                                                       |
| backend / data API (`backend`)     | `contember`, `bindx`                                                             |
| site / content (`site-framework`)  | `pletivo`, `nuasite`                                                             |
| agents (`agent-sdk`)               | `roj`                                                                            |
| native authn/authz                 | `propustka`                                                                      |
| error tracking (`error-tracking`)  | `sentry`                                                                         |
| testing                            | `opice`                                                                          |

### Patterns (`patterns/`)

Applied _over_ the technologies they `require` (no package; `kind: pattern`).

| theme                   | patterns                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| architecture / delivery | `monorepo`, `di-container`, `feature-architecture`, `single-worker-spa`, `typed-worker-rpc` |
| data / seeds            | `named-seeds`                                                                               |
| CF write patterns       | `count-store`, `write-split`                                                                |
| auth                    | `auth-password-kv`                                                                          |
| CI / CD                 | `app-deploy` (direct), `vozka-app-deploy` (control plane), `lib-publish`                    |
| observability           | `structured-logging`, `observability`                                                       |

### Tooling (`tooling/`)

`deptective`, `edvabe` — additive dev tools (`slot: null`), not part of preset closure.
