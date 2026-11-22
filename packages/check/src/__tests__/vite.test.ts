// A Vite build of an SPA that imports the typed client and the contract: through `@fabrika/check/vite-plugin` it holds
// no handler code and calls its endpoint at the contract's path, its answer read through the contract's output schema.

import { afterAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

const built = z.strictObject({ ok: z.boolean(), error: z.string() })

/** Builds `root`'s SPA into `root/out` with Vite, in a process of its own. */
const viteBuild = (root: string, mode: 'plugin' | 'plain' = 'plugin'): z.infer<typeof built> => {
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
		expect(viteBuild(plain, 'plain')).toEqual({ ok: true, error: '' })
		for (const text of HANDLER_TEXT) expect(scripts(plain)).toContain(text)

		const sliced = materialize(spaTree())
		expect(viteBuild(sliced)).toEqual({ ok: true, error: '' })
		const code = scripts(sliced)
		expect(code).toContain('/api')
		for (const text of HANDLER_TEXT) expect(code).not.toContain(text)
		expect(code).not.toMatch(/from\s*["'](node|bun):|["']bun["']/)
	})

	test('the page calls its endpoint at the contract path and renders the answer the output schema admits', () => {
		const root = materialize(spaTree())
		expect(viteBuild(root)).toEqual({ ok: true, error: '' })
		const answer = { rows: [{ stage: 'won', deals: 3 }] }
		expect(runPage(root, answer)).toEqual({
			requests: [{ method: 'POST', url: 'https://crm.example.test/api/deals.pipeline', body: JSON.stringify({ orgId: 'org-1' }) }],
			text: `lead · proposal · won · lost: ${JSON.stringify(answer)}`,
		})
		// An answer the contract's output schema refuses never reaches the page.
		expect(runPage(root, { rows: [{ stage: 'archived', deals: 3 }] }).text).toBe('')
	})

	test('a handler the reader refuses fails the build, before its module is requested', () => {
		const tree = spaTree()
		const endpoints = tree.get('src/deals/endpoints.ts') ?? ''
		const inline = ".handle(async ({ input, ctx }) => ctx.db.target.deals.insert({ title: input.title, stage: 'lead' }))"
		expect(endpoints).toContain(inline)
		tree.set('src/deals/endpoints.ts', `import { createDeal } from './handlers'\n${endpoints.replace(inline, '.handle(createDeal)')}`)
		tree.set('src/deals/handlers.ts', "throw new Error('a handler module ran at import')\n")
		const result = viteBuild(materialize(tree))
		expect(result.ok).toBe(false)
		expect(result.error).toMatch(/src\/deals\/endpoints\.ts:\d+:\d+ literal/)
	})
})

describe('the plugin in a dev server', () => {
	test('loads a shell module as its slice and watches it, leaves every other module to Vite, and reads the shell again after a change', () => {
		const root = materialize(spaTree())
		const plugin = shellSlicePlugin({ root })
		const watched: string[] = []
		const context = { addWatchFile: (id: string) => void watched.push(id) }
		const endpoints = join(root, 'src', 'deals', 'endpoints.ts')
		const first = plugin.load.call(context, `${endpoints}?import`)?.code ?? ''
		expect(first).toContain('export const deals = app.group(')
		expect(first).not.toContain('.handle(')
		expect(plugin.load.call(context, join(root, 'web', 'main.ts'))).toBeNull()
		expect(plugin.load.call(context, join(root, 'src', 'deals', 'logic.ts'))).toBeNull()
		expect(watched).toEqual([endpoints])

		writeFileSync(endpoints, readFileSync(endpoints, 'utf8').replace("'only a won or lost deal reopens'", "'only a closed deal reopens'"))
		plugin.watchChange()
		const next = plugin.load.call(context, endpoints)?.code ?? ''
		expect(next).not.toContain('.handle(')
		expect(next).not.toContain('reopens')
		expect(next.length).toBe(first.length - 'won or lost'.length + 'closed'.length)
	})
})
