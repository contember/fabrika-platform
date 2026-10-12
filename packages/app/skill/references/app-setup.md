# references/app-setup.md — the repository of an application

An application is the root of its own repository: Zerops reads `zerops.yaml` there. In the fabrika-platform
repository an example is a workspace under `examples/<name>/`, laid out the same way.

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
		"@fabrika/app": "^0.0.4",
		"@fabrika/db": "^0.0.4",
		"@fabrika/provider-zerops": "^0.0.4",
		"@fabrika/proxy-core": "^0.0.4",
		"kysely": "0.29.6",
		"zod": "^3.25.76"
	},
	"devDependencies": {
		"@fabrika/check": "^0.0.4",
		"@fabrika/cli": "^0.0.4",
		"@fabrika/platform": "^0.0.4",
		"@types/bun": "latest",
		"typescript": "^5.9.3"
	}
}
```

- The name is not under `@fabrika/*` (that scope is the platform's), and every `@fabrika/*` version is a registry
  range, never `workspace:*`. The checker refuses both (`package-replacement`). Inside the fabrika-platform repository
  Bun still links the workspace copies.
- `kysely` is there for the generated schema's types.
- After you create a new workspace in a monorepo, run `bun install` at the repository root. Until then every
  `@fabrika/*` import fails and tsc reports a cascade of implicit `any`s that are not your bugs.

```json tsconfig.json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ESNext",
		"moduleResolution": "bundler",
		"lib": ["ES2022", "DOM", "DOM.Iterable"],
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
	"include": ["src/**/*", "web/**/*", "*.ts"]
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
import { projects } from './src/projects/endpoints'
import { reports } from './src/reports/endpoints'
import { tasks } from './src/tasks/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { projects, tasks, comments, reports, members }),
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
  on Zerops), `c.form(path, { input, appendTo })` (an anonymous form that appends one row and runs no handler), a
  webhook, a link mount. Sections: `files`, `jobs`, `exports`, `csp`. No path under `/__fabrika`.
- `src/app.ts` composes and does nothing else. A dependency built from the application's own variables is
  `defineDeps(build)`, passed as `serve(contract, { database, deps })` and read in a handler with `get()`. Never read
  `process.env`.

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

## The SPA

```ts web/main.ts
import { createClient, RpcError } from '@fabrika/app/client'
import { contract } from '../fabrika.contract'

const api = createClient(contract, 'api')

export const showMine = async (list: HTMLElement): Promise<void> => {
	try {
		const page = await api.tasks.mine({})
		list.replaceChildren(
			...page.items.map((task) =>
				Object.assign(document.createElement('li'), { textContent: task.title })
			),
		)
	} catch (error) {
		list.textContent = error instanceof RpcError
			? `Failed: ${error.type}`
			: 'Failed'
	}
}
```

```html web/index.html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<title>Tasks</title>
		<script type="module" src="./start.ts"></script>
	</head>
	<body>
		<ul id="mine"></ul>
	</body>
</html>
```

```ts web/start.ts
import { showMine } from './main'

const list = document.getElementById('mine')
if (list !== null) void showMine(list)
```

```ts build-web.ts
import { shellSlicePlugin } from '@fabrika/check/bun-plugin'
import { join } from 'node:path'

const built = await Bun.build({
	entrypoints: [join(import.meta.dir, 'web', 'index.html')],
	outdir: join(import.meta.dir, 'dist', 'web'),
	target: 'browser',
	plugins: [shellSlicePlugin({ root: import.meta.dir })],
})
if (!built.success) {
	for (const log of built.logs) console.error(String(log))
	process.exit(1)
}
```

- The SPA imports `@fabrika/app/client`, `fabrika.contract.ts`, `src/schemas.ts` and its own modules; never a slice,
  `src/db/` or a Bun or Node module. The plugin loads the contract without its handlers.
- Set text with `textContent`, never `innerHTML`. Same-origin calls carry the session cookie.

## Ignored files

`.gitignore`: `node_modules/`, `fabrika.manifest.json`, `/fabrika/entry.generated.ts`, `/dist/`.
