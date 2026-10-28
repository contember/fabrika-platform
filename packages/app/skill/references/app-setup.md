# references/app-setup.md — the repository of an application

An application is the root of its own repository: Zerops reads `zerops.yaml` there. In the fabrika-platform
repository an example is a workspace under `examples/<name>/`, laid out the same way. This file shows an application
with tables and an SPA; a new one starts without either (`references/start.md`), and each part below that belongs to
the SPA is added with it.

## Packages and compiler

```json package.json
{
	"name": "tasks",
	"private": true,
	"type": "module",
	"scripts": {
		"build:manifest": "fabrika app build --env=prod",
		"build:web": "bun build-web.ts",
		"typecheck": "tsc --noEmit",
		"test": "bun test --isolate"
	},
	"dependencies": {
		"@fabrika/app": "0.9.0-dev.8",
		"@fabrika/db": "0.9.0-dev.8",
		"@fabrika/provider-zerops": "0.9.0-dev.8",
		"@fabrika/proxy-core": "0.9.0-dev.8",
		"@fabrika/ui": "0.9.0-dev.8",
		"kysely": "0.29.6",
		"react": "^19.0.0",
		"react-dom": "^19.0.0",
		"zod": "^3.25.76"
	},
	"devDependencies": {
		"@fabrika/check": "0.9.0-dev.8",
		"@fabrika/cli": "0.9.0-dev.8",
		"@fabrika/platform": "0.9.0-dev.8",
		"@happy-dom/global-registrator": "^20.11.2",
		"@types/bun": "^1.4.3",
		"@types/react": "^19.0.0",
		"@types/react-dom": "^19.0.0",
		"typescript": "^5.9.3"
	}
}
```

- The name is not under `@fabrika/*` (that scope is the platform's), and every `@fabrika/*` version is a registry
  range, never `workspace:*`. The checker refuses both (`package-replacement`). Inside the fabrika-platform repository
  Bun still links the workspace copies.
- `build:web` builds the SPA: add it, `build-web.ts`, `web/`, the contract's `site` mount and the `bun run build:web`
  line of `zerops.yaml` when the application gets an SPA, and not before.
- `kysely` is there for the generated schema's types. The SPA reports its errors to Operations by itself:
  `FabrikaProvider` reads the DSN, release and environment the framework serves at `<prefix>/__fabrika-config.json`
  and sends every uncaught error and unhandled rejection there; add no error-reporting SDK. The same file carries
  `public: { <VARIABLE>: <value> }`: each public procedure's challenge `siteKey`, and the variables the SPA mount lists in
  `c.spa(prefix, { …, browserConfig: ['SIGNUP_URL'] })`. A page reads a per-environment public value (a site key, a link
  target) there, never as a build-time constant; it holds no other variable, and the contract refuses a secret in it.
  `react`, `react-dom` and `@fabrika/ui` (with `@types/react`, `@types/react-dom` and `@happy-dom/global-registrator`
  for the screen tests) are the SPA's: add them with it.
- After you create a new workspace in a monorepo, run `bun install` at the repository root. Until then every
  `@fabrika/*` import fails and tsc reports a cascade of implicit `any`s that are not your bugs.
- To try unreleased packages outside the fabrika-platform repository, run `bun scripts/release.ts pack --local
  --artifacts=<dir>` there. It writes the tarballs, `release-manifest.json` and `install.json`.
  1. Copy the tarballs into the application's `vendor/`.
  2. Give each `@fabrika/*` entry the application already lists its `file:vendor/…` value from the `dependencies` of
     `install.json`, in the field where it is: `@fabrika/check`, `@fabrika/cli` and `@fabrika/platform` stay in
     `devDependencies`, the rest in `dependencies`. Add no other package of that list; `agent-canvas` and
     `@fabrika/builder` are commands the application does not need.
  3. Add the `overrides` of `install.json` whole: each packed package names its `@fabrika/*` dependencies by a version
     only the pack has.
  4. Run `bun install`, then `fabrika-check --packed <dir>/release-manifest.json`: without the flag the checker refuses
     the tarballs.

  Put `vendor/` in `.gitignore`, and commit neither the tarballs nor the `file:` form of `package.json` and `bun.lock`
  to a branch that deploys. The platform build installs from the registry and runs the checker without `--packed`, so
  it refuses that form.
- The local pack is the one way to run a platform checkout's packages in an application. Never `bun link` a
  `@fabrika/*` package: a linked package resolves its dependencies and peers from the checkout, so the application
  runs a second React (every hook fails), a second zod and a second kysely. Installed from `vendor/`, the packages
  resolve `react`, `zod` and `kysely` from the application's own `node_modules`. The pack's version names the
  checkout's commit: after a change in the platform, commit it, pack again, replace the tarballs in `vendor/`, and
  replace the block with the new `install.json`. `bun.lock` still names the old tarballs, and `bun install` then fails
  with `ENOENT extracting tarball`. Before it, delete each line of `bun.lock` that names `vendor/`
  (`grep -v 'vendor/' bun.lock > bun.lock.next && mv bun.lock.next bun.lock`): each is one entry of a packed package,
  and `bun install` writes them again from `package.json`. Deleting the whole `bun.lock` also works, but it resolves
  every other package again.

```json tsconfig.json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"lib": ["ES2022", "DOM", "DOM.Iterable"],
		"jsx": "react-jsx",
		"strict": true,
		"noUncheckedIndexedAccess": true,
		"noImplicitOverride": true,
		"noPropertyAccessFromIndexSignature": true,
		"forceConsistentCasingInFileNames": true,
		"skipLibCheck": true,
		"isolatedModules": true,
		"noEmit": true,
		"types": ["@types/bun"]
	},
	"include": ["src/**/*", "web/**/*", "dev/**/*", "*.ts"]
}
```

The tsconfig stands alone: no `extends` of a file outside the application. `lib` is ES2022, so `toSorted` and other
newer methods are not there.

## The composition

```ts src/app-kit.ts
import { defineApp } from '@fabrika/app/contract'
import { tables } from './db/tables'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary, tables)
```

```ts fabrika.contract.ts
import { app } from './src/app-kit'
import { comments } from './src/comments/endpoints'
import { members } from './src/members/endpoints'
import { priorities } from './src/priorities/endpoints'
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', {
		projects,
		tasks,
		comments,
		reports,
		members,
		priorities,
	}),
	site: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	health: c.health('/healthz'),
}))
```

```ts src/app.ts
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'

export default serve(contract, { database: scoped(tables) })
```

- Mounts: `c.rpc(prefix, groups)` once per prefix, `c.spa(prefix, { dir, access })`, `c.health('/healthz')` (required
  on Zerops), a webhook, a link mount. An anonymous visitor reaches a public procedure of an `c.rpc` mount
  (`access: { public: true }`, `references/public-intake.md`). An SPA's `access` is `{ member: true }`, `{ action, over }`, or `{ public: true }` for a page
  anyone opens without signing in (a landing page, a public form): the approver sees it as "for anyone". A public SPA
  at `/` answers every `GET` no more specific endpoint serves; give a member SPA its own prefix (`/app`). Sections:
  `files`, `jobs`, `exports`, `csp` (`connectSrc`, `imgSrc`, `frameAncestors`, `scriptSrc`, `frameSrc`, `styleSrc`,
  `fontSrc`: exact `https://` origins, each with a `purpose`, at most 16 each). A hosted typeface needs both its
  stylesheet origin in `styleSrc` and its font origin in `fontSrc`; font files under the SPA's `dir` need neither. No path under `/__fabrika`.
- A public procedure's abuse control is its `admission`: `rate: { perClient, perEndpoint }` (per minute, shared by
  every instance; 10 and 100 by default for a public mutation; 429 past either) and
  `challenge: { provider: 'altcha', secret: 'ALTCHA_HMAC_KEY' }`. `honeypot(value)` of `@fabrika/app` is true for a
  filled field the page hides: answer the same and write nothing. A challenge needs the input field
  `challengeToken: z.string()`. An ALTCHA challenge is a proof of work the application issues at
  `GET /__fabrika/challenge/<action>` (`challengeUrl(api.<procedure>)` of `@fabrika/app/client`; the action is the
  endpoint id with `_` for `.`, `api_visitors_register`, or the challenge's own `action: 'register'`, at most 32
  letters, digits, `_` and `-`, one per procedure) and verifies itself, asking no one: the page renders `Challenge` of
  `@fabrika/ui/challenge`, which fills the field. A failed, expired or replayed one is 400 `challenge_failed`, no row.
  `secret` names the application variable holding the HMAC key, which the human sets to a long random value
  (32 characters at least), never the value itself; without it, or with a shorter one, the application does not boot. `cost` and `maxAgeMs` set the work and the lifetime
  (`references/public-intake.md`). `provider: 'turnstile'` (with `siteKey`, verified at Cloudflare, an unreachable
  provider 503) is the alternative when the human asks for it; it adds Cloudflare's origin to the CSP and serves the
  site key to every SPA mount's pages (below). On Zerops every visitor still shares one client address (the balancer),
  so `perClient` acts as a second per-endpoint limit: raise it, and use the challenge.
  `references/public-intake.md` builds a whole public intake on it.
- `defineApp(vocabulary, tables, { imports?, tokens? })`: `imports` names other applications' exports
  (`references/webhooks-links-connectors.md`), `tokens` the purposes of signed tokens (`references/endpoint.md`).
- `c.rpc('/api/v1', groups, { compatibility: 'backward' })` promises a mount's callers a stable API
  (`references/endpoint.md`).
- `kicks: ['<job>']` on a mutation names cron jobs of the same contract (`jobs`), and `ctx.kick('<job>')` in its
  handler starts one once its transaction committed: a run starts within seconds, under the job's own key, and the
  answer never waits for it (`references/jobs.md`). Kicks coalesce on the job's lease (at most one run and one
  pending, however many calls arrive), so the job still works in batches under its own budgets. Keep its schedule: it
  is the recovery path for a kicked run that died. A kick carries nothing; the job reads its rows. `kit.runJob` first
  waits for the kicked runs.
- `src/app.ts` composes and does nothing else. A dependency built from the application's own variables is
  `defineDeps(build)`, passed as `serve(contract, { database, deps })` and read in a handler with `get()`. Never read
  `process.env`. `build` runs at every boot, the generated tests' too, which pass no variable: read a variable when
  the dependency is used, and fail there (`src/links.ts` in `references/public-intake.md`). A handler of an endpoint the
  generated tests cover records an outbox row instead, and a job calls the dependency (`references/endpoint.md`).
  E-mail needs no dependency: a job that declares `mailer` sends through `ctx.mail` (`references/jobs.md`).

## The deploy surface (Zerops)

```ts fabrika.config.ts
import { compileContract, schemaFromContract } from '@fabrika/app/contract'
import { defineApp, type ZeropsServiceSpec } from '@fabrika/provider-zerops'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { contract } from './fabrika.contract'
import { tables } from './src/db/tables'

const compiled = compileContract(contract, tables)

const services = (): ZeropsServiceSpec[] => [
	{
		hostname: 'tasksdb',
		type: 'postgresql:single@18',
		profile: 'oltp-hobby',
		priority: 100,
	},
	{
		hostname: 'tasksapi',
		type: 'alpine/bun@1.3',
		priority: 10,
		enableSubdomainAccess: false,
		minContainers: 1,
		maxContainers: 2,
	},
]

export default defineApp({
	id: contract.vocabulary.app,
	schema: schemaFromContract(compiled),
	target: {
		platform: 'zerops',
		services,
		contract: compiled,
		proxy: { upstream: 'tasksapi:3000', ...contractProxyTable(compiled) },
		deployService: 'tasksapi',
		zeropsSetup: 'tasksapi',
	},
})
```

```yaml
# zerops.yaml: write only build.base, build.os and the SPA's buildCommands; the platform generates the rest.
# Without an SPA, the build holds only base: the platform installs the packages itself.
zerops:
  - setup: tasksapi
    build:
      base: alpine/bun@1.3
      buildCommands:
        - bun install --frozen-lockfile
        - bun run build:web
```

The platform's build runs the tests, writes the entrypoint, runs `fabrika-check` and the type check. Its init commands
run `fabrika db migrate`, `fabrika db codegen --verify` and `fabrika db test-isolation` before the server starts: a
version does not go live until every generated test passes. It writes every `FABRIKA_*` variable; never set one.

## The deploy surface (Cloudflare)

```ts fabrika.config.ts
import { defineApp } from '@fabrika/provider-cloudflare'

export default defineApp({ id: 'tasks' })
```

That is the whole config. `defineApp` builds the application Worker: named after the id, running
`fabrika/entry.generated.ts`, with no route and no public URL, and IAM bound at its application entrypoint. The deploy
builds the proxy Worker from `fabrika.contract.ts` and writes the application's Durable Object, its files bucket, its
cron trigger and every `FABRIKA_*` variable; Control writes the IAM schema from the approved contract. Declare none of
them: a config that does is refused. Write no `resources`, `schema` or `pipeline.workerDir` (the config's directory is
the default). A binding of the application's own, or another `compatibility_date` or `compatibility_flags`, goes in
`worker: { bindings, compatibility_date, compatibility_flags }`; `IAM` stays the platform's. `package.json` names
`@fabrika/provider-cloudflare` where the Zerops one names `@fabrika/provider-zerops`, the entry is written by
`fabrika app build --provider=cloudflare` (the deploy runs it again from the pinned commit), and there is no
`zerops.yaml`.

The application runs in its Durable Object over SQLite by default. When the human asks for Postgres (an existing
database, more than one object's throughput), add one property, inline and literal, so the checker and Control can read
it: `defineApp({ id: 'tasks', database: { kind: 'postgres', provisioningSecret: 'DATABASE_URL' } })`. The Worker then
serves every request over Hyperdrive and the object runs only the jobs. `DATABASE_URL` is an application secret the
operator sets per environment in Control: the direct (non-pooler) URL of a role that may create roles, one Postgres
cluster per environment. Never put it in `pipeline.secrets`, `vars` or a Worker binding; the deploy refuses that. The
migrations are Postgres, as on Zerops (`references/table-and-migration.md`), and the deploy runs `fabrika db migrate`
before it deploys. An environment's database never changes once it published: moving is a new environment. A
`database` the checker cannot read is refused (`cloudflare-database`).

It also serves the SPA: the deploy copies the build directory of each SPA and
link mount (`dir`, a link's `spa`) into `fabrika/assets/` at the mount's prefix (`/admin` into `fabrika/assets/admin/`)
after `pipeline.build`, and binds it as `ASSETS`. A `.assetsignore` at the root of a mount's directory excludes files
as it does for wrangler (gitignore syntax, relative to that directory); `.git`, `.hg`, `.svn` and `.bzr` are never
copied. A deploy whose mount directory the build did not write fails and
names the mount. A config that composes its own Worker with `resources` and declares `assets` keeps them instead, and the object reads each
request path from that directory as it is (`/admin/app.js` is `admin/app.js` there), so a hand-written `assets` works
only for a root mount, or for mounts whose directories nest like their prefixes; it needs `binding: 'ASSETS'` and
`run_worker_first: true`.

## The SPA (added when the application has one)

The SPA is React, built from the screens and hooks of the framework: `@fabrika/app/react` runs the typed client's
calls, and `@fabrika/ui` holds the components. Build a screen from the kit; never write a DOM helper, a router or a
component set of your own. `references/spa.md` shows every component, the forms, the routes and the tests.

```html web/index.html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>Tasks</title>
		<script type="module" src="./start.tsx"></script>
	</head>
	<body>
		<div id="root"></div>
	</body>
</html>
```

```ts web/api.ts
import { createClient } from '@fabrika/app/client'
import { contract } from '../fabrika.contract'

export const api = createClient(contract, 'api', { bounceOnAuth: true })
```

```tsx web/mine.tsx
import { useInfiniteQuery } from '@fabrika/app/react'
import { type Column, DataTable, PageHeader, StatusPill } from '@fabrika/ui'
import { api } from './api'

type Task = {
	readonly id: string
	readonly title: string
	readonly status: string
}

const columns: readonly Column<Task>[] = [
	{ key: 'title', header: 'Task', grow: true, cell: (task) => task.title },
	{
		key: 'status',
		header: 'Status',
		cell: (task) => <StatusPill>{task.status}</StatusPill>,
	},
]

export function MyTasks() {
	const mine = useInfiniteQuery(api.tasks.mine, {})
	return (
		<>
			<PageHeader title="My tasks" lead="Open tasks assigned to you." />
			<DataTable
				caption="My tasks"
				columns={columns}
				rows={mine.items}
				rowKey={(task) => task.id}
				status={mine.status === 'error'
					? 'error'
					: mine.status === 'success'
					? 'ready'
					: 'loading'}
				error={mine.error?.message}
				onRetry={() => void mine.retry()}
				loadMore={{
					hasMore: mine.hasMore,
					loading: mine.loadingMore,
					onLoadMore: () => void mine.loadMore(),
				}}
			/>
		</>
	)
}
```

```tsx web/start.tsx
import '@fabrika/ui/styles.css'
import { FabrikaProvider } from '@fabrika/app/react'
import { AppShell } from '@fabrika/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api'
import { MyTasks } from './mine'

const root = document.getElementById('root')
if (root !== null) {
	createRoot(root).render(
		<StrictMode>
			<FabrikaProvider clients={[api]}>
				<AppShell
					brand="Tasks"
					nav={[{ label: 'My tasks', href: '/', active: true }]}
				>
					<MyTasks />
				</AppShell>
			</FabrikaProvider>
		</StrictMode>,
	)
}
```

```ts build-web.ts
import { shellSlicePlugin } from '@fabrika/check/bun-plugin'
import { join } from 'node:path'

const outdir = join(import.meta.dir, 'dist', 'web')
const built = await Bun.build({
	entrypoints: [join(import.meta.dir, 'web', 'index.html')],
	outdir,
	target: 'browser',
	define: { 'process.env.NODE_ENV': JSON.stringify('production') },
	sourcemap: 'external',
	plugins: [shellSlicePlugin({ root: import.meta.dir })],
})
if (!built.success) {
	for (const log of built.logs) console.error(String(log))
	process.exit(1)
}
const index = Bun.file(join(outdir, 'index.html'))
await Bun.write(
	index,
	(await index.text()).replaceAll(/(src|href)="\.\//g, '$1="/'),
)
```

- The SPA imports `@fabrika/app/client`, `@fabrika/app/react`, `@fabrika/ui`, React, `fabrika.contract.ts`,
  `src/schemas.ts`, `src/shared/` and its own modules; never a slice, `src/db/` or a Bun or Node module. The plugin loads the
  contract without its handlers. A row type the screen declares (`Task` above) is checked against the answer where
  the rows are passed in.
- The last step points the page's assets at the SPA's prefix (`/`): the mount answers `index.html` for every page
  route under it (a path without an extension, or a navigation), so a deep link such as `/tasks/<id>` renders; a
  missing asset such as an old `chunk-….js` is 404. `define` gives React's production build.
- `sourcemap: 'external'` writes each script's map beside it, and the page names none. The platform build uploads the
  maps to Operations for the release the page reports, so an error's frames show the original source; the mount
  never serves a `.map` file (404). Keep the maps external: `inline` would ship the source to every visitor.
- **Errors.** `FabrikaProvider` reports the page's uncaught errors and unhandled rejections to Operations, with the
  release and the environment, through the DSN the mount serves; without a DSN (local development, a test) it reports
  nothing. An application that must not report passes `reportErrors={false}`.
- Set text through JSX, never `dangerouslySetInnerHTML` or `innerHTML`. Same-origin calls carry the session cookie.
- **Who is signed in.** Every member SPA serves `<prefix>/__fabrika-me.json` to the person it admitted:
  `{ label, email, actions: { app, scopes } }`. `useCaller()` (`@fabrika/app/react`) answers `{ label, email,
  can(action, scope?) }` from it, and `<Can action="tasks.write">` shows its children only when the token grants the
  action. It comes from the token and asks IAM nothing. Use it to greet the person and to show or hide a control,
  never as the check: every endpoint decides again, so a hidden button is no protection. A public SPA answers it 401,
  because its pages arrive without a token, signed in or not.

## Ignored files

`.gitignore`: `node_modules/`, `fabrika.manifest.json`, `/fabrika/entry.generated.ts`, `/dist/`, and on Cloudflare
`/fabrika/assets/`, where a deploy stages the SPA's files.
