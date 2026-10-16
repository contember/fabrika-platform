# @fabrika/dashboard

The unified console SPA (Delivery, Access, Operations): buzola file-based router + React 19, served by
control. Assumes the root CLAUDE.md.

Layout: `src/routes/` holds every page (`access/` and `operations/` included); plane-only code lives in
`src/access/` and `src/operations/`; `src/components/` and `src/lib/` are shared by all three planes.

## Commands (this package)

```bash
bun run gen          # regenerate src/buzola.gen.ts from src/routes/ (Buzola codegen via Bun)
bun run dev          # vite on :18292, proxies /api → :18291 (run the worker's `bun run dev` alongside)
bun run typecheck    # gen + tsc --noEmit
bun run build        # gen + tsc + vite build → dist/ (what the worker serves)
bun run test         # bun test src/__tests__ (excluded from tsc; no DOM)
```

## Invariants

- **`src/buzola.gen.ts` is GENERATED — never edit it.** Run `bun run gen` after adding/moving a route
  under `src/routes/`. `typecheck` and `build` run `gen` first. It is the only route map — a page lives
  in its route file, never behind a re-export shim.
- **API DTO types come from runtime-neutral contract packages.** `src/lib/api.ts` re-exports
  `@fabrika/control-contract`; Access uses `@fabrika/iam-contract` and Operations
  `@fabrika/operations-contract`. Keep server code, persistence types and runtime bindings out. Keep browser code away from the runtime entrypoints of `@fabrika/control`, `@fabrika/iam`, and
  `@fabrika/runner-container` or `@fabrika/runner-cloudflare`.
- **Auth uses Fabrika IAM (no Cloudflare Access edge).** Delivery calls use the typed
  `ControlRpcContract` client in `src/lib/api.ts`. On the proxy's 401 for a `human` row, carrying a `loginUrl`, the shared
  RPC client opens IAM login with `redirect` rewritten to the current page. A short `sessionStorage`
  guard breaks the loop if IAM returns an identity that is still unauthorized. The overview's IAM
  snapshot uses `IamAdminRpcContract` directly with auth bounce disabled because that panel is
  best-effort; the Access routes use the same contract (`src/access/lib/api.ts`) with normal auth bounce.
  Operations uses `OperationsRpcContract` through control's `/operations/api/rpc` gateway
  (`src/operations/client.ts`). Every client is a plain `createRpcClient` — no positional adapters.
- **Sign-out is IAM's, not the console's** (`src/lib/session.ts`). The bar links to IAM's `GET /auth/logout`
  confirmation, whose same-origin POST revokes the IAM login and so every app session derived from it; IAM refuses a
  cross-site POST, so never post it from the console. IAM's origin comes from `/.well-known/fabrika-builder`. The
  signed-in name is Control's `consoleAccess` principal, or IAM's `me` when Control does not answer.
- **The console shows what its caller may use; it decides nothing** (`src/lib/console-access.ts`). `consoleSession()`
  reads, once per load and without a login bounce, Control's `consoleAccess`, IAM's `me` (answers administrators only:
  `iamAdministrationScope` of its permissions says whether of the installation or of some applications' people,
  ADR-0058) and `appPeople.apps`. `mayOpen` gives each rail page the rule its LOADER needs, so a page in the rail loads: the
  overview needs `app.manage`, `namespace.manage` and `deploy.read` globally, Applications `app.manage` globally,
  Deploy runs `deploy.read` in any scope, Operations `operations.read` in any scope, Access's Users any IAM administration, every other Access page the
  installation's. The root layout drops the rest,
  answers a hidden page reached by URL with "not available", and shows the no-access page when nothing is left. A
  part no service answered is `null` and reads as usable, so an outage still shows its own page. Controls use
  `mayDo` at the object's app and environment (`ConsoleAccessContext`). The action names come from the contracts —
  `CONTROL_ACTIONS` (`@fabrika/control-contract`) and `OPERATIONS_ACTIONS` (`@fabrika/operations-contract/access`).
- **An IAM application reads as its display name** (`src/access/lib/app-names.tsx`). The Access layout reads
  `apps.list` once and provides the names; `AppName` renders the name with the id as its tooltip, and a picker
  option shows both. The console itself is `vozka`, named `Console`.

- **`src/styles.css` is the console's ONLY design system.** `src/access/styles.css` holds styles for the
  Access-only widgets (pickers, grant grid, JSON view) written in these tokens. Do not put base, shell,
  table, button or badge rules there.
- **One copy of each shared piece.** `components/` (`Icon`, `Modal`, `Table`, `ConfirmDialog`, `Status`,
  `RouteError`) and `lib/format.ts` serve all three planes. Formatters take epoch **seconds**;
  Operations timestamps are milliseconds, so divide by 1000 at the call site.
- **The Operations layout keeps its own outage screen** ("Operations is unavailable" / "Retry
  connection"), not `RouteError`: an Operations outage must read as bounded to its plane
  (`tests/browser/operations-outage-isolation.test.ts`).
- **The Access rail is five items and stays five: Overview · Users · Credentials · Permissions · Audit.**
  Each answers a different question — what is the state of access, who are the people, what gets in
  without a person, what does a grant mean, what happened. It was seven pages that cut the same
  material three ways; don't add a sixth without retiring one.
  - **Users are people.** A service principal's page is its API key's, under Credentials
    (`credentials/keys/:id`, `apiKeys.get`), which edits its grants through `grants.*`; `apiKeys.list` returns every
    one of them, so Credentials is the complete machine list and the Users list filters to `?type=user`. The key's grant
    form offers only the app its key is bound to (`keyGrantTargets`).
  - **Credentials holds both API keys and share links** — both are `px_…` tokens shown once at issue.
    Neither section's button is filled: a page with two constructive steps has no single primary.
  - **Permissions is one page for roles, actions and scope dimensions**, with a policy edited inline in
    the roles table it belongs to. `roles.list({ app })` already returns custom roles; the page drops them and
    renders the policy rows instead, which carry what it takes to edit them.
- **People (`/people`) is outside the Access rail on purpose.** It serves an application's own administrator, who holds
  the application's `members.manage` and is no IAM administrator, so the Access layout's gate would refuse
  them. It only asks IAM's `appPeople.*`; IAM decides which applications and roles it lists and audits each change.
- **A user administrator (ADR-0058) works in Access's Users.** The Access layout waits for `me` and provides its
  `IamAdministrationScope` (`src/access/lib/administration.tsx`); `grantTargets` gives a grant form the applications in
  the caller's scope, never an `installation: true` app and never the cross-app option, and the user page hides
  promotion. It decides nothing: IAM refuses a grant, or an action on a person, outside the caller's administration.

## Patterns

- A route is `createPage().loader(...).route('/path').render(...)` (default export) under `src/routes/`.
- Delivery calls use named `ControlRpcContract` procedures through `src/lib/api.ts` at `/api/rpc`.
  IAM calls use named `IamAdminRpcContract` procedures at `/iam/admin/rpc`; Operations calls use named
  `OperationsRpcContract` procedures at `/operations/api/rpc`. The shared RPC client sends same-origin credentials. Keep public
  health checks and static asset delivery outside RPC; do not add path-string REST helpers for domain calls.
- **Status is a lamp, category is a chip or badge** (`components/Status.tsx`).
  All three planes speak this one language; nothing renders a coloured pill for a lifecycle state.
- **One filled button per page**, and it is that page's single constructive step. Filtering, editing and
  repairing are outline or ghost; irreversible acts live in a `.danger-zone` at the foot of the page.
- **A page head is: back link, title, one line of purpose.** Every list filters through one `.filters`
  bar; every table marks the column(s) that should absorb slack with `className="grow"` on the `<th>`.
- **Two `grow` columns fight.** With `table-layout: auto` the surplus does not split evenly — whichever
  column has the larger max-content wins and the other collapses. If a row has a name AND a sentence
  about it, put them in one cell (name, then a `.muted.small` line) rather than two columns.
