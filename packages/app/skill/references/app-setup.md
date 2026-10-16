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
		"@fabrika/app": "0.5.2",
		"@fabrika/db": "0.5.2",
		"@fabrika/provider-zerops": "0.5.2",
		"@fabrika/proxy-core": "0.5.2",
		"@fabrika/ui": "0.5.2",
		"kysely": "0.29.6",
		"react": "^19.0.0",
		"react-dom": "^19.0.0",
		"zod": "^3.25.76"
	},
	"devDependencies": {
		"@fabrika/check": "0.5.2",
		"@fabrika/cli": "0.5.2",
		"@fabrika/platform": "0.5.2",
		"@happy-dom/global-registrator": "^20.11.2",
		"@types/bun": "latest",
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
  `public: { <VARIABLE>: <value> }`: each form challenge's `siteKey`, and the variables the SPA mount lists in
  `c.spa(prefix, { …, public: ['SIGNUP_URL'] })`. A page reads a per-environment public value (a site key, a link
  target) there, never as a build-time constant; it holds no other variable, and the contract refuses a secret in it.
  `react`, `react-dom` and `@fabrika/ui` (with `@types/react`, `@types/react-dom` and `@happy-dom/global-registrator`
  for the screen tests) are the SPA's: add them with it.
- After you create a new workspace in a monorepo, run `bun install` at the repository root. Until then every
  `@fabrika/*` import fails and tsc reports a cascade of implicit `any`s that are not your bugs.
- To try unreleased packages outside the fabrika-platform repository, run `bun scripts/release.ts pack --local
  --artifacts=<dir>` there. It writes the tarballs, `release-manifest.json` and `install.json`. Copy the tarballs into
  the application's `vendor/`, replace every `@fabrika/*` entry of `dependencies` and `devDependencies` with the
  `dependencies` of `install.json`, add its `overrides`, and run `bun install`. Then run the checker as
  `fabrika-check --packed <dir>/release-manifest.json`: without the flag it refuses the tarballs. A deployed
  application never takes this form; the platform build installs from the registry.
- The local pack is the one way to run a platform checkout's packages in an application. Never `bun link` a
  `@fabrika/*` package: a linked package resolves its dependencies and peers from the checkout, so the application
  runs a second React (every hook fails), a second zod and a second kysely. Installed from `vendor/`, the packages
  resolve `react`, `zod` and `kysely` from the application's own `node_modules`. The pack's version names the
  checkout's commit: after a change in the platform, commit it, pack again, and replace the block with the new
  `install.json`.

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
  on Zerops), `c.form(path, { input, appendTo, then? })` (an anonymous form that appends one row and runs no handler), a
  webhook, a link mount. An SPA's `access` is `{ member: true }`, `{ action, over }`, or `{ public: true }` for a page
  anyone opens without signing in (a landing page, a public form): the approver sees it as "for anyone". A public SPA
  at `/` answers every `GET` no more specific endpoint serves; give a member SPA its own prefix (`/app`). Sections:
  `files`, `jobs`, `exports`, `csp` (`connectSrc`, `imgSrc`, `frameAncestors`, `scriptSrc`, `frameSrc`, `styleSrc`,
  `fontSrc`: exact `https://` origins, each with a `purpose`, at most 16 each). A hosted typeface needs both its
  stylesheet origin in `styleSrc` and its font origin in `fontSrc`; font files under the SPA's `dir` need neither. No path under `/__fabrika`.
- A public form's abuse control, all optional on `c.form`: `rate: { perClient, perForm }` (per minute, shared by
  every instance; 10 and 100 by default; 429 past either), `honeypot: '<field>'` (a `z.optional(z.string())` input
  field the page hides; a filled one gets the same answer and writes nothing) and
  `challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' }`. A challenge needs the input field
  `challengeToken: z.string()`, which the page fills from the Turnstile widget rendered with `action` set to the
  form's mount name; the framework verifies it on the server (a failed token 400, an unreachable provider 503, no
  row either way) and adds Turnstile's origin to the CSP. `secret` names an application variable the human sets,
  never the value; without it the application does not boot. `siteKey` names the variable with the widget's public
  site key, which every SPA mount serves its pages (below). Neither field reaches the inbox, so neither is a
  column. On Zerops every visitor still shares one client address (the balancer), so `perClient` acts as a second
  per-form limit: raise it, and use the challenge. `references/public-intake.md` builds a whole public intake on it.
- `then: '<job>'` on `c.form` names a cron job of the same contract (`jobs`), which each accepted submission kicks
  once its row committed: a run starts within seconds, under the job's own key, and the answer stays the same constant
  and never waits for it. A mutation declares the same `then` for the outbox row it records (`references/jobs.md`). Kicks coalesce on the job's lease (at most one run and one pending, however many visitors
  submit), so the job still drains its inbox in batches under its own budgets. Keep its schedule: it is the recovery
  path for a kicked run that died. A kick carries nothing; the job reads its inbox. `kit.runJob` first waits for the
  kicked runs.
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

The platform's build runs the tests, writes the entrypoint, runs `fabrika-check` and the type check. Its start script
runs `fabrika db migrate`, `fabrika db codegen --verify` and `fabrika db test-isolation` before the server: the
application is not ready until every generated test passes. It writes every `FABRIKA_*` variable; never set one.

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
- The last step points the page's assets at the SPA's prefix (`/`): the mount answers `index.html` for every path
  under it, so a deep link such as `/tasks/<id>` renders. `define` gives React's production build.
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

`.gitignore`: `node_modules/`, `fabrika.manifest.json`, `/fabrika/entry.generated.ts`, `/dist/`.
