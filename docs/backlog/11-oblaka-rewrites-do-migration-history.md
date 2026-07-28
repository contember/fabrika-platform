# oblaka rewrites Durable Object migration history on class removal

`bun run oblaka` in `packages/control` does not only _append_ to `wrangler.jsonc`'s
`migrations` array when a Durable Object class is removed — it **rewrites history**.

Observed when `DeployLock` was deleted (phase 1, the DO→DB-row lock swap):

```
before                                        after
v0001 new_sqlite_classes [RunnerContainer]    v0001 new_sqlite_classes [RunnerContainer]
v0002 new_sqlite_classes [DeployLock]         ← DELETED by oblaka
v0003 deleted_classes    [RunnerContainer]    v0003 deleted_classes    [RunnerContainer]
                                              v0004 deleted_classes    [DeployLock]
```

Cause: `oblaka-iac/src/commands/resource-processor.ts` strips a vanishing class from
every historical `new_sqlite_classes` entry, drops the entry when it becomes empty,
and only then appends the `deleted_classes` migration.

This is precisely the hazard the root `CLAUDE.md` names when it explains why
`wrangler.jsonc` is committed at all: the `migrations` array is supposed to be the
one durable record of a worker's DO migration history, and regenerating it must not
shift or lose entries. After this rewrite the array has a numbering gap and one
deploy's history is gone, so the file is no longer a faithful record.

`wrangler deploy` most likely still succeeds — it locates the deployed
`migrations_tag` (`v0003`, still present) and applies everything after it — but that
is luck, not design: had the deployed tag been the deleted `v0002`, the worker would
have had no anchor to resume from.

`deleteDurableObjectsOnRemoval: false` is **not** a workaround. It preserves history
but never emits the deletion, so the class is never actually removed.

## What to do

- File the bug upstream against `oblaka-iac`; removal should be append-only.
- Until it is fixed, treat a DO-class removal as a change that needs the regenerated
  `wrangler.jsonc` reviewed by hand before it is committed — the one case where the
  "never hand-edit, just regenerate" rule is not sufficient on its own.
- Decide whether the currently-committed `packages/control/wrangler.jsonc` (which
  already carries the rewritten array) should be repaired to restore `v0002`, or
  left as-is because the deployed tag makes it harmless. **Do not repair it blindly**
  — check what `migrations_tag` the live worker actually reports first.
