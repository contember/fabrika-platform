# @fabrika/dashboard

The control-plane SPA: buzola file-based router + React 19, served by the worker's `ASSETS` binding.
Assumes the root CLAUDE.md.

## Commands (this package)

```bash
bun run gen          # regenerate src/buzola.gen.ts from src/routes/ (Buzola codegen via Bun)
bun run dev          # vite on :18292, proxies /api → :18291 (run the worker's `bun run dev` alongside)
bun run typecheck    # gen + tsc --noEmit
bun run build        # gen + tsc + vite build → dist/ (what the worker serves)
```

## Invariants

- **`src/buzola.gen.ts` is GENERATED — never edit it.** Run `bun run gen` after adding/moving a route
  under `src/routes/`. `typecheck` and `build` run `gen` first.
- **API DTO types come from runtime-neutral contract packages.** `src/lib/api.ts` re-exports
  `@fabrika/control-contract`; access routes consume `@fabrika/iam-contract` through `@fabrika/iam-ui`.
  Keep browser code away from the runtime entrypoints of `@fabrika/control`, `@fabrika/iam`, and
  `@fabrika/runner-container` or `@fabrika/runner-cloudflare`.
- **Auth is propustka-native (no Cloudflare Access edge).** On a 401 carrying a `loginUrl` (the worker's
  `error()` puts it there for a human-gated miss), `src/lib/api.ts` `request()` bounces the browser to
  propustka's SSO login (`redirect` rewritten to the current page) — a blind reload would just loop since
  there's no edge to re-challenge. A short `sessionStorage` bounce guard breaks the loop if we return still-unauthorized.

- **`src/styles.css` is the console's ONLY design system.** `@fabrika/iam-ui` ships component styles for
  its own widgets (pickers, grant grid, JSON view) written in these tokens and declares no base rules —
  it used to carry a full standalone stylesheet, which only forced this one into defensive
  re-statements. Do not reintroduce base, shell, table, button or badge rules there.
- **The icon set lives in `@fabrika/iam-ui/icon`**, re-exported by `src/components/Icon.tsx`, so both
  halves of the console draw from one set. `BrandMark` stays here — it is this app's identity.

## Patterns

- A route is `createPage().loader(...).route('/path').render(...)` (default export) under `src/routes/`.
- All API calls go through the typed `api` helper (`api.get/post/put/patch/del`) in `src/lib/api.ts` — same-origin, `credentials: 'include'`.
- **Status is a lamp, category is a chip or badge** (`components/Status.tsx`, and iam-ui's mirror of it).
  Both planes speak this one language; nothing renders a coloured pill for a lifecycle state.
- **One filled button per page**, and it is that page's single constructive step. Filtering, editing and
  repairing are outline or ghost; irreversible acts live in a `.danger-zone` at the foot of the page.
- **A page head is: back link, title, one line of purpose.** Every list filters through one `.filters`
  bar; every table marks the column(s) that should absorb slack with `className="grow"` on the `<th>`.
