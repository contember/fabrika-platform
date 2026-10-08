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
| `builtins.ts`    | The built-ins captured at load, `NameSet`, and `parseList`, the one way a caller's array is read.         |
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
- **A Ref's predicate covers every link of its chain, one equality per chain column.** A table carries
  a column for each ancestor (`TableModel.chain`, resolved by `defineTables` through the tables that own
  each dimension); a `Ref` whose chain names a dimension the table has no column for is refused, never
  ignored. Otherwise a `Ref` minted before an ancestor moved would still reach its rows.
- **An insert into a container, a child insert and a move lock the destination row first** (`FOR SHARE`,
  matched on the destination `Ref`'s whole chain, in the mutation's transaction; `lockDestination`), when a
  table owns the destination dimension. A
  stale destination is 404 and nothing is written. The guard admits that one lock only with
  `GuardContext.lock`.
- **Mutations answer `{ id, version }` (and `move` the new chain), never row data.** A write action does
  not include the read action; returning the row would leak columns the caller may not read.
- **A column holds at most one stamped role.** The key, every containment column of the chain, `version`
  and `createdBy` are distinct columns, or `defineTables` refuses the policy (`checkStamps`). Otherwise
  one stamp overwrites another: `createdBy` on the key inserts the principal as the id, `version` on a
  container column moves the row on every update.
- **A `version` column is INTEGER (int4).** Postgres returns BIGINT as a string (the platform-node rule in
  `packages/platform-node/CLAUDE.md`), and the acknowledgement and `expectVersion` are numbers. The policy
  types accept only a column whose generated select type is `number` (`VersionColumn`); the column list
  carries names only, so at runtime a mutation that gets a non-number version back throws inside its
  transaction and writes nothing.
- **Insert and update data are read through own property descriptors** (`readValues`): a plain or
  null-prototype object only, no symbol keys, no accessors, every key checked before any value is read.
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
- **The guard and every policy and allowlist check use only the built-ins `builtins.ts` captured at
  load, index loops, and frozen `NameSet` lookups.** Loading `database.ts` freezes the Kysely compiler's
  prototype chain. Both close the two same-process attacks that succeeded against the spike (patching
  the compiler after the guard ran; patching `Set.prototype.has`). Do not use an iterator, a spread, a
  `Set`/`Map` method or a prototype method in `guard.ts`, `identifier.ts`, or a check in `policy.ts`,
  `description.ts` or `store.ts`. Building the tree (`nodes.ts`, the value `Map`) still uses ordinary
  built-ins, so a patched `Array.prototype.map` can change what is built after the checks passed.
- **A caller's array is read only through `parseList`:** a plain array, by index, through own data
  properties. A subclass, an own property besides the indexes and `length` (an own `map`, `filter` or
  `Symbol.iterator`), a hole or an accessor element is refused, so no method the input owns ever runs.
  Each element is validated before it is copied.
- **Unknown keys in insert and update data are refused, not dropped**, so an agent learns about them.
  The key, scope columns, version and `createdBy` are stamped by the layer and can never be written.
- **A column with its own read action** (`columns: { c: { read } }`) falls back to nothing: every
  read needs the table's read action, so v1 never returns, filters or sorts by such a column.
