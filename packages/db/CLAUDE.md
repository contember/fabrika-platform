# @fabrika/db

The scoped data layer for applications on Postgres: handlers reach rows only through a capability
(`Ref` or `Within`) and only for the operation its action allows. It runs inside the application
process, so it stops honest mistakes and makes a bypass conspicuous; it is not a hard boundary against
code in the same process. Design: [scoped database access](../../docs/ideas/scoped-database-access.md).
Assumes the root CLAUDE.md.

Published (`publishConfig.access: public`): applications depend on it.

```bash
bun run typecheck
bun test    # policy · store · guard · hardening · type-attacks · postgres (needs FABRIKA_TEST_POSTGRES_URL)
```

| Module           | What it owns                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `capability.ts`  | `Ref` / `Within` (opaque, type-only member) and `CapabilityAuthority`, which the framework implements.    |
| `policy.ts`      | `defineTables`: the literal table policies, checked against the generated column list, and the row types. |
| `description.ts` | `ScopedSelect`: the frozen, non-executable query description a store callback receives.                   |
| `nodes.ts`       | Kysely operation nodes built from a description and a scope predicate.                                    |
| `guard.ts`       | The allowlist over the final operation tree, run immediately before compiling.                            |
| `database.ts`    | `Database` (the connection, with no public query method) and `Session`, the only path to it.              |
| `store.ts`       | `scoped` → `defineStore` / `defineChildStore`; the table handles; every capability and scope check.       |

Not built yet: binding a capability to its request (the framework's `CapabilityAuthority`), migrations
and codegen, generated locators, `@fabrika/db/testing`, and stores for `reference` and `inbox` tables
(`defineTables` accepts their policies; no store reaches them).

## Invariants

- **Every select, update and delete carries its scope predicate as the top-level right conjunct of
  WHERE, by identity.** The caller's conditions sit in a `ParensNode` on the left. The guard checks this
  shape (`checkRoot`); without the parenthesis, `true or 1=1` followed by the scope would match every
  row. An insert carries no WHERE and gets its scope columns stamped from the capability instead.
- **The data layer checks kind, dimension and action itself, on every operation.** The authority only
  says whether a value is an authentic capability of the current request. TypeScript checks method
  parameters bivariantly, so a widened handle passes a read `Ref` to `remove` without a cast — the
  runtime check is what refuses it.
- **No raw handle leaves the package.** `Database` keeps its Kysely instance in a private field; the
  store reaches it through `sessionOf`, and `Session.run` guards every tree. Do not add a method that
  takes SQL, a builder or an unguarded node.
- **Bind scalars only.** `Bun.SQL` mis-binds a JS array (`in` lists are expanded into parameters) and
  stores a bound JSON string as a JSON string, so values are strings, numbers, bigints, booleans, Dates
  or null; the guard refuses anything else in a `ValueNode`. The pool runs with `prepare: false`:
  otherwise Bun keeps one prepared statement per distinct SQL text, and `in` lists of different
  lengths make that grow without bound.
- **The guard depends on Kysely internals** (node factories marked `@internal`, node property names,
  the operator and function strings the compiler prints). `kysely` and `kysely-postgres-js` are pinned
  exactly; `guard.test.ts` and `type-attacks.test.ts` are the upgrade check.
- **The guard uses only references it captured at load and index loops.** Loading `database.ts`
  freezes the Kysely compiler's prototype chain. Both close the two same-process attacks that
  succeeded against the spike (patching the compiler after the guard ran; patching `Set.prototype.has`).
  Do not use an iterator, a spread or a prototype method in `guard.ts` or `identifier.ts`.
- **Unknown keys in insert and update data are refused, not dropped**, so an agent learns about them.
  The key, scope columns, version and `createdBy` are stamped by the layer and can never be written.
- **A column with its own read action** (`columns: { c: { read } }`) falls back to nothing: every
  read needs the table's read action, so v1 never returns, filters or sorts by such a column.
