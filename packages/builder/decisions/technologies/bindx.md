---
id: bindx
kind: technology
title: Bindx — typed React data binding for Contember
slot: data-binding
provides: [react-data-binding, form-state, persistence, schema-codegen, undo-redo]
requires: [contember, react]
recommends: []
conflicts: []
npm: ["@contember/bindx@^0.1.41", "@contember/bindx-react@^0.1.41", "@contember/bindx-generator@^0.1.41", "@contember/bindx-client@^0.1.41"]
status: wip
sources:
  - where: "bindx/packages/example/ (article-view.tsx, article-editor.tsx, App.tsx, generated/index.ts)"
    read: "Real usage: Entity/Field/HasOne/HasMany components, usePersist, and the generated schema the app imports."
  - where: "bindx/packages/bindx-react/src/index.ts"
    read: "The hook + component surface (useEntity, useEntityList, usePersist, useUndo; Entity, Field, HasOne, HasMany, If, Show; ContemberBindxProvider)."
  - where: "bindx/packages/bindx-generator/src/generate.ts"
    read: "How `bun run generate:schema` turns a Contember Model (+ optional ACL) into typed entities + a schema object."
---

# Bindx

## What it is

A **typed, schema-bound React data-binding layer** over a Contember GraphQL API.
You define the model in Contember, the generator emits TypeScript entity types + a
schema object, and bindx gives you live data access, form state, dirty tracking,
persistence, undo/redo, and field events — fully typed. Instead of
`useState` + manual GraphQL + a form lib, you get `useEntity` / `useEntityList` +
`<Entity>`/`<Field>`/`<HasMany>` and a single `usePersist()` that builds and posts
the Contember mutations.

## When & why to use

- You have a **Contember** backend and are building a **React admin/CRUD/editor** that needs form state + binding.
- You want **strict typing**: a model change breaks TypeScript immediately.
- You want **persistence as one call** + free **undo/redo** + fine-grained field subscriptions.

## When NOT to use

- **Not using Contember** — bindx assumes Contember's GraphQL/mutation shape (core is adapter-pluggable, but the generator + ecosystem are Contember-shaped).
- Lightweight client-only form state with no backend → `react-hook-form` + a store.

## Impacts & gotchas

- Requires a **live Contember API** + a **codegen step** (`generate:schema`) you run before TypeScript sees the entity types; commit the generated files.
- **Selection is collected implicitly from JSX** — nesting unused relations over-fetches. Use `SelectionScope` / `debugSelection()`.
- **Role-aware generation (ACL)** produces per-role entity types (PublicArticle/EditorArticle/…), which adds type complexity but enforces security.
- **Undo is local-snapshot**, not a server transaction — a half-failed `persistAll()` undoes locally only; recover by refetching.

## Relationships — why

- **requires `contember`** — it is a binding layer over a Contember GraphQL API; no Contember, no bindx.
- **requires `react`** — `@contember/bindx-react` ships React hooks/components (React 18+).
- **slot `data-binding`** — orthogonal to the router; it composes with the rest of the stack.
