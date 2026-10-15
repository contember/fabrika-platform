---
id: 167
title: A mutation's mutate is new every render, and the screen-test DOM empties a form
blocked-by: []
---

# 167 — A mutation's `mutate` is new every render, and the screen-test DOM empties a form

**Summary.** Three gaps of `@fabrika/app/react` that an application built on the paved road worked around by hand:
`mutate` cannot drive an effect, no hook reads a set of calls known only after other data loads, and `installDom`
makes the kit's own `Form` submit an empty `FormData`. Effort: M.

## Problem

- **`mutate` changes identity on ordinary renders.** `useRun`'s `mutate` depends on `[run, after, onSuccess]`
  (`packages/app/src/react/hooks.ts:234`). `useAction` takes `run` from the caller, so an inline function gives a new
  `mutate` at each render; `useMutation` and `useAction` memoize their invalidation prefixes on the `invalidates`
  array's identity (`hooks.ts:256`, `:272`), so an inline `{ invalidates: [] }` does the same. An effect that calls
  `mutate` once its input loads then fires again at each render. An inline `onSuccess` has the same effect.
- **A pending call drops the last answer.** `mutate` sets `{ status: 'pending', data: undefined }` (`hooks.ts:215`),
  so a screen that reloads through `useAction` flashes its loading state at each reload.
- **No hook reads a growing set of calls.** Hooks cannot run in a loop, and `@fabrika/app/react` exports no
  `useQueries` (`packages/app/src/react/index.ts:5`). A screen that reads one procedure per id named by rows it loaded
  first calls the client in a `useEffect`, keeps the last answer and maps a throw through `toFabrikaError` itself.
- **`installDom` keeps Bun's `FormData`** (`packages/app/src/react/testing.ts:22`, restored at `:56`). Bun's
  constructor reads nothing from a happy-dom `<form>`: under `installDom`, `new FormData(form)` has no entry (checked
  at HEAD with a one-input form). `Form` builds its `onSubmit` argument that way (`packages/ui/src/Form.tsx:37`), and
  `spa.md` tells a form to read its fields from that `FormData` (`packages/app/skill/references/spa.md:357`), while
  the same page says `installDom` keeps Bun's `FormData` (`spa.md:737`). A screen test of the documented form
  therefore submits blank fields. Applications either hold every field in React state or install happy-dom without
  `installDom`.

## Approach / acceptance

- Keep `mutate` stable: read `run`, `after` and `onSuccess` through refs updated each render, and key the
  invalidation prefixes by content. Witness: a hook test re-renders with an inline `run`, `invalidates: []` and
  `onSuccess`, and `mutate` keeps its identity.
- Keep `data` while a later call runs (as `useQuery`'s `keepPrevious` does), or document why not. Witness: `data` is
  the previous answer while `pending`.
- `useQueries(procedure, inputs)`: one state per input, keyed by the input's content, sharing the store and its
  invalidation. Witness: a hook test whose input list grows after a first query resolves.
- `Form` must give a field's values under `installDom`. Prefer `installDom` keeping happy-dom's `FormData`, unless the
  client, the kit or a download depends on Bun's (find out first: the comment at `testing.ts:8` names the client, the
  kit, a challenge and a download). The alternative is `Form` collecting its controls itself. Witness: a
  `testing.test.tsx` case submits a `Form` with a typed field under `installDom` and reads the value.

## Touch points

`packages/app/src/react/{hooks.ts,index.ts,testing.ts}`, `packages/app/src/react/__tests__/`,
`packages/ui/src/Form.tsx`, `packages/app/skill/references/spa.md`.

<!-- Origin: framework gaps an application built on the paved road met on the 0.4.1 React stack. -->
