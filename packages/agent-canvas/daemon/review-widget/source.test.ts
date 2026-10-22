import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { resolveSources } from './source'

const ORIGIN = 'http://localhost:44841'
const realFetch = globalThis.fetch

function inlineMap(map: object): string {
	return `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
}

/** Serves each script with its source map comment, and the maps that are separate files. */
function serve(files: Record<string, string | object>): void {
	const network = async (input: string | URL | Request): Promise<Response> => {
		const url = input instanceof Request ? input.url : input.toString()
		if (url.startsWith('data:')) return realFetch(url)
		const body = files[url]
		if (body === undefined) return new Response(null, { status: 404 })
		return new Response(typeof body === 'string' ? body : JSON.stringify(body))
	}
	spyOn(globalThis, 'fetch').mockImplementation(Object.assign(network, { preconnect: realFetch.preconnect }))
}

function script(mapReference: string): string {
	return `export const x = 1\n//# sourceMappingURL=${mapReference}`
}

const frame = (url: string) => ({ label: '<td> in OrderTable', url, line: 1, column: 1 })

afterEach(() => {
	mock.restore()
})

describe('resolveSources', () => {
	test('an inline map resolves against the module path Vite names in `file`', async () => {
		const url = `${ORIGIN}/src/modules/sales/OrderTable.tsx`
		// A long map whose base64 contains `/`: resolved against the data URL, the map itself ended up in the path.
		const map = {
			version: 3,
			sources: ['OrderTable.tsx'],
			sourcesContent: ['?'.repeat(3000)],
			file: '/app/src/modules/sales/OrderTable.tsx',
			mappings: 'AAAA',
			names: [],
		}
		serve({ [url]: script(inlineMap(map)) })

		expect(await resolveSources([frame(url)])).toEqual([
			{ label: '<td> in OrderTable', file: '/app/src/modules/sales/OrderTable.tsx', line: 1, column: 1 },
		])
	})

	test('an inline map without `file` resolves next to the script, as a path from the dev server root', async () => {
		const url = `${ORIGIN}/node_modules/@buzola/router/src/define/create-page.tsx?v=1`
		serve({ [url]: script(inlineMap({ version: 3, sources: ['create-page.tsx'], mappings: 'AAAA', names: [] })) })

		expect((await resolveSources([frame(url)]))[0]?.file).toBe('node_modules/@buzola/router/src/define/create-page.tsx')
	})

	test('a separate map on the dev server gives paths from its root', async () => {
		const url = `${ORIGIN}/node_modules/.vite/deps/@buzola_router.js?v=63d39487`
		serve({
			[url]: script('@buzola_router.js.map'),
			[`${ORIGIN}/node_modules/.vite/deps/@buzola_router.js.map`]: {
				version: 3,
				sources: ['../../@buzola/router/src/engine/router.ts'],
				mappings: 'AAAA',
				names: [],
			},
		})

		expect((await resolveSources([frame(url)]))[0]?.file).toBe('node_modules/@buzola/router/src/engine/router.ts')
	})

	test('a file Vite serves from outside its root keeps its absolute path', async () => {
		const url = `${ORIGIN}/@fs/home/dev/shared/Button.tsx`
		serve({ [url]: script(inlineMap({ version: 3, sources: ['Button.tsx'], mappings: 'AAAA', names: [] })) })

		expect((await resolveSources([frame(url)]))[0]?.file).toBe('/home/dev/shared/Button.tsx')
	})

	test('a source path over the limit is left out instead of failing the thread', async () => {
		const url = `${ORIGIN}/src/Long.tsx`
		serve({ [url]: script(inlineMap({ version: 3, sources: [`${'a/'.repeat(600)}Long.tsx`], mappings: 'AAAA', names: [] })) })

		expect(await resolveSources([frame(url)])).toEqual([])
	})
})
