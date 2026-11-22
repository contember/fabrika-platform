// A Vite build of an SPA that imports the typed client and the contract: through `@fabrika/check/vite-plugin` it holds
// no handler code and calls its endpoint at the contract's path, its answer read through the contract's output schema.

import { afterAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'vite'
import { z } from 'zod/v4'
import { shellSlicePlugin } from '../vite-plugin'
import { ARCHITECTURE_ROOT, materialize, readTree, removeMaterialized } from './colocated-helpers'

afterAll(removeMaterialized)

const BUILDER = join(import.meta.dir, 'fixtures', 'vite-build.ts')
const PAGE = join(import.meta.dir, 'fixtures', 'vite-page.ts')

/** The page: `web/main.ts` of the fixture calls `api.deals.pipeline` through the typed client and renders the answer. */
const SPA_FILES: ReadonlyMap<string, string> = new Map([
	[
		'web/index.html',
		'<!doctype html>\n<html>\n\t<head>\n\t\t<script type="module" src="./start.ts"></script>\n\t</head>\n\t<body><div id="app"></div></body>\n</html>\n',
	],
	['web/start.ts', "import { showPipeline } from './main'\n\nvoid showPipeline('org-1')\n"],
])

const spaTree = (): Map<string, string> => new Map([...readTree(ARCHITECTURE_ROOT, ['.fixture']), ...SPA_FILES])

/** Text of the fixture's handlers that minification keeps: an error message and a SQL template. */
const HANDLER_TEXT = ['only a won or lost deal reopens', 'select d.stage']

/** Modules only handlers import, and the stand-in Vite bundles for a Node builtin. */
const SERVER_MODULES = /src\/(deals|companies)\/(logic|queries)\.ts$|src\/app\.ts$|__vite-browser-external/

const built = z.strictObject({ ok: z.boolean(), error: z.string(), modules: z.array(z.string()) })

/** Builds `root`'s SPA into `root/out` with Vite, in a process of its own. */
const viteBuild = (root: string, mode: 'plugin' | 'plain' | 'web' = 'plugin'): z.infer<typeof built> => {
	const run = Bun.spawnSync([process.execPath, BUILDER, root, join(root, 'out'), mode], { cwd: root })
	return built.parse(JSON.parse(run.stdout.toString()))
}

const scripts = (root: string): string =>
	readdirSync(join(root, 'out', 'assets'))
		.filter((name) => name.endsWith('.js'))
		.map((name) => readFileSync(join(root, 'out', 'assets', name), 'utf8'))
		.join('\n')

const page = z.strictObject({
	requests: z.array(z.strictObject({ method: z.string(), url: z.string(), body: z.string() })),
	text: z.string(),
})

/** Runs the built page in happy-dom; its `fetch` answers `answer`. */
const runPage = (root: string, answer: unknown): z.infer<typeof page> => {
	const run = Bun.spawnSync([process.execPath, PAGE, join(root, 'out'), JSON.stringify(answer)], { cwd: root })
	return page.parse(JSON.parse(run.stdout.toString()))
}

describe('a Vite build of the SPA through the plugin', () => {
	test('holds the client and the contract and none of the handlers, which a build without the plugin bundles', () => {
		const plain = materialize(spaTree())
		const unsliced = viteBuild(plain, 'plain')
		expect(unsliced.ok).toBe(true)
		expect(unsliced.modules.filter((id) => SERVER_MODULES.test(id)).length).toBeGreaterThan(0)
		for (const text of HANDLER_TEXT) expect(scripts(plain)).toContain(text)

		const sliced = materialize(spaTree())
		const result = viteBuild(sliced)
		expect(result.ok).toBe(true)
		for (const module of ['fabrika.contract.ts', 'src/deals/endpoints.ts', 'packages/app/src/client/contract.ts']) {
			expect(result.modules.some((id) => id.endsWith(module))).toBe(true)
		}
		expect(result.modules.filter((id) => SERVER_MODULES.test(id))).toEqual([])
		const code = scripts(sliced)
		expect(code).toContain('/api')
		for (const text of HANDLER_TEXT) expect(code).not.toContain(text)
	})

	test("a root that is not the contract's fails the build instead of bundling the handlers", () => {
		const result = viteBuild(materialize(spaTree()), 'web')
		expect(result.ok).toBe(false)
		expect(result.error).toContain("fabrika.contract.ts is not the contract of the plugin's root")
	})

	test('the page calls its endpoint at the contract path and renders the answer the output schema admits', () => {
		const root = materialize(spaTree())
		expect(viteBuild(root).ok).toBe(true)
		const answer = { rows: [{ stage: 'won', deals: 3 }] }
		expect(runPage(root, answer)).toEqual({
			requests: [{ method: 'POST', url: 'https://crm.example.test/api/deals.pipeline', body: JSON.stringify({ orgId: 'org-1' }) }],
			text: `lead · proposal · won · lost: ${JSON.stringify(answer)}`,
		})
		// An answer the contract's output schema refuses never reaches the page.
		expect(runPage(root, { rows: [{ stage: 'archived', deals: 3 }] }).text).toBe('')
	})

	test('a handler the reader refuses fails the build', () => {
		const tree = spaTree()
		const endpoints = tree.get('src/deals/endpoints.ts') ?? ''
		const inline = ".handle(async ({ input, ctx }) => ctx.db.target.deals.insert({ title: input.title, stage: 'lead' }))"
		expect(endpoints).toContain(inline)
		tree.set('src/deals/endpoints.ts', `import { createDeal } from './handlers'\n${endpoints.replace(inline, '.handle(createDeal)')}`)
		tree.set('src/deals/handlers.ts', 'export const createDeal = async () => ({})\n')
		const result = viteBuild(materialize(tree))
		expect(result.ok).toBe(false)
		expect(result.error).toMatch(/src\/deals\/endpoints\.ts:\d+:\d+ literal/)
	})
})

describe('the plugin in a Vite dev server', () => {
	test('serves a shell module as its slice, watches it outside the root, and serves the edit', async () => {
		const root = materialize(spaTree())
		const server = await createServer({
			root: join(root, 'web'),
			configFile: false,
			logLevel: 'silent',
			plugins: [shellSlicePlugin({ root })],
			server: { middlewareMode: true, hmr: false, ws: false },
		})
		try {
			const endpoints = join(root, 'src', 'deals', 'endpoints.ts')
			const served = async (): Promise<string> => (await server.transformRequest(`/@fs${endpoints}`))?.code ?? ''
			const first = await served()
			expect(first).toContain('crm.read')
			for (const text of HANDLER_TEXT) expect(first).not.toContain(text)
			// Vite watches only its root (`web/`) and the files it reads itself; the plugin adds the shell beside it.
			expect(server.watcher.getWatched()[join(root, 'src', 'deals')]).toContain('endpoints.ts')

			writeFileSync(endpoints, readFileSync(endpoints, 'utf8').replace("action: 'crm.read'", "action: 'deals.write'"))
			server.watcher.emit('change', endpoints)
			let next = first
			for (let tick = 0; tick < 100 && next === first; tick++) {
				await new Promise((resolve) => setTimeout(resolve, 10))
				next = await served()
			}
			expect(next).not.toContain('crm.read')
			for (const text of HANDLER_TEXT) expect(next).not.toContain(text)
		} finally {
			await server.close()
		}
	})
})
