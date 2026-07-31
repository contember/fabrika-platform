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
  Operations routes consume `@fabrika/operations-contract` through
  `@fabrika/operations-ui`.
  Keep browser code away from the runtime entrypoints of `@fabrika/control`, `@fabrika/iam`, and
  `@fabrika/runner-container` or `@fabrika/runner-cloudflare`.
- **Auth uses Fabrika IAM (no Cloudflare Access edge).** Delivery calls use the typed
  `ControlRpcContract` client in `src/lib/api.ts`. On a human-gated 401 carrying a `loginUrl`, the shared
  RPC client opens IAM login with `redirect` rewritten to the current page. A short `sessionStorage`
  guard breaks the loop if IAM returns an identity that is still unauthorized. The overview's IAM
  snapshot uses `IamAdminRpcContract` directly with auth bounce disabled because that panel is
  best-effort; the Access routes use the same contract through `@fabrika/iam-ui` with normal auth bounce.

- **`src/styles.css` is the console's ONLY design system.** `@fabrika/iam-ui` ships component styles for
  its own widgets (pickers, grant grid, JSON view) written in these tokens and declares no base rules —
  it used to carry a full standalone stylesheet, which only forced this one into defensive
  re-statements. Do not reintroduce base, shell, table, button or badge rules there.
- **The icon set lives in `@fabrika/iam-ui/icon`**, re-exported by `src/components/Icon.tsx`, so all
  three planes draw from one set. `BrandMark` stays here — it is this app's identity.
- **The Access rail is five items and stays five: Overview · Users · Credentials · Permissions · Audit.**
  Each answers a different question — what is the state of access, who are the people, what gets in
  without a person, what does a grant mean, what happened. It was seven pages that cut the same
  material three ways; don't add a sixth without retiring one.
  - **Users are people.** A service principal has no page of its own: `apiKeys.list` returns every one
    of them, so Credentials is the complete machine list and the Users list filters to `?type=user`.
  - **Credentials holds both API keys and share links** — both are `px_…` tokens shown once at issue.
    Neither section's button is filled: a page with two constructive steps has no single primary.
  - **Permissions is one page for roles, actions and scope dimensions**, with a policy edited inline in
    the roles table it belongs to. `roles.list({ app })` already returns custom roles; the page drops them and
    renders the policy rows instead, which carry what it takes to edit them.

## Patterns

- A route is `createPage().loader(...).route('/path').render(...)` (default export) under `src/routes/`.
- Delivery calls use named `ControlRpcContract` procedures through `src/lib/api.ts` at `/api/rpc`.
  IAM calls use named `IamAdminRpcContract` procedures at `/iam/admin/rpc`; Operations views own their
  `OperationsRpcContract` client. The shared RPC client sends same-origin credentials. Keep public
  health checks and static asset delivery outside RPC; do not add path-string REST helpers for domain calls.
- **Status is a lamp, category is a chip or badge** (`components/Status.tsx`, and iam-ui's mirror of it).
  All three planes speak this one language; nothing renders a coloured pill for a lifecycle state.
- **One filled button per page**, and it is that page's single constructive step. Filtering, editing and
  repairing are outline or ghost; irreversible acts live in a `.danger-zone` at the foot of the page.
- **A page head is: back link, title, one line of purpose.** Every list filters through one `.filters`
  bar; every table marks the column(s) that should absorb slack with `className="grow"` on the `<th>`.
- **Two `grow` columns fight.** With `table-layout: auto` the surplus does not split evenly — whichever
  column has the larger max-content wins and the other collapses. If a row has a name AND a sentence
  about it, put them in one cell (name, then a `.muted.small` line) rather than two columns.
