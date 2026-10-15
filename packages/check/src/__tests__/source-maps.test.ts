import { readSourceMapUploadReport, sourceMapUploadReport } from '@fabrika/operations-contract/releases'
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAssetSourceMaps, collectSourceMaps, uploadSourceMaps } from '../source-maps'
import { runSourceMapUpload } from '../source-maps-cli'

const MAP = JSON.stringify({ version: 3, sources: ['../web/main.ts'], names: [], mappings: 'AAAA' })
const BEARER = 'b'.repeat(64)
const DESTINATION = {
	url: 'https://operations.test/api/artifacts/source-maps/',
	appId: 'notes',
	environment: 'prod',
	serviceKey: 'default',
	release: `fabrika/notes/prod/default/${'c'.repeat(40)}`,
	runId: 'run-1',
}

const withTree = async (files: Readonly<Record<string, string>>, body: (root: string) => Promise<void>): Promise<void> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-source-maps-'))
	try {
		for (const [path, contents] of Object.entries(files)) {
			await mkdir(join(root, path, '..'), { recursive: true })
			await writeFile(join(root, path), contents)
		}
		await body(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

describe('source maps of an asset root', () => {
	test('each map is named by the URL path of the file it maps, whatever its own `file` says', async () => {
		await withTree({
			'dist/web/chunk-abc.js.map': MAP,
			'dist/web/nested/chunk-def.js.map': MAP,
			'dist/share/chunk-ghi.js.map': MAP,
			'dist/web/node_modules/dep.js.map': MAP,
			'src/stray.js.map': MAP,
		}, async (root) => {
			const collection = await collectAssetSourceMaps(root, [{ prefix: '/', dir: 'dist/web' }, { prefix: '/s', dir: 'dist/share' }])
			expect(collection.incomplete).toBe(false)
			expect(collection.artifacts.map((artifact) => artifact.logicalPath).sort()).toEqual([
				'chunk-abc.js',
				'nested/chunk-def.js',
				's/chunk-ghi.js',
			])
		})
	})

	test('a root outside the application is skipped and counts as incomplete; a missing one holds nothing', async () => {
		await withTree({ 'dist/web/a.js.map': MAP }, async (root) => {
			const collection = await collectAssetSourceMaps(root, [{ prefix: '/', dir: '../outside' }, { prefix: '/x', dir: 'dist/none' }])
			expect(collection).toEqual({ artifacts: [], incomplete: true })
		})
	})

	test('the runner reads a public logical path from the map and never guesses from a nested basename', async () => {
		await withTree({
			'dist/assets/ambiguous.js.map': JSON.stringify({ version: 3, file: 'ambiguous.js', sources: [], names: [], mappings: '' }),
			'dist/assets/rooted.js.map': JSON.stringify({ version: 3, file: '/assets/rooted.js', sources: [], names: [], mappings: '' }),
		}, async (root) => {
			const collection = await collectSourceMaps(root)
			expect(collection.incomplete).toBe(true)
			expect(collection.artifacts.map((artifact) => artifact.logicalPath)).toEqual(['assets/rooted.js'])
		})
	})
})

describe('the upload', () => {
	const artifact = { logicalPath: 'chunk-abc.js', digest: 'd'.repeat(64), body: new TextEncoder().encode(MAP).buffer }

	test('sends each map with the run scope and its bearer', async () => {
		const requests: Request[] = []
		const result = await uploadSourceMaps({ ...DESTINATION, bearer: BEARER }, { artifacts: [artifact], incomplete: false }, (input, init) => {
			requests.push(new Request(input, init))
			return Promise.resolve(new Response(null, { status: 201 }))
		})
		expect(result).toEqual({ uploaded: 1, state: 'complete' })
		expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${BEARER}`)
		expect(requests[0]?.headers.get('X-Fabrika-Release')).toBe(DESTINATION.release)
		expect(requests[0]?.headers.get('X-Fabrika-Run-Id')).toBe('run-1')
		expect(requests[0]?.headers.get('X-Fabrika-Artifact-Path')).toBe('chunk-abc.js')
	})

	test('a refused or failed upload is incomplete and never throws', async () => {
		const collection = { artifacts: [artifact], incomplete: false }
		const refused = await uploadSourceMaps({ ...DESTINATION, bearer: BEARER }, collection, () => Promise.resolve(new Response(null, { status: 401 })))
		expect(refused).toEqual({ uploaded: 0, state: 'incomplete' })
		const failed = await uploadSourceMaps({ ...DESTINATION, bearer: BEARER }, collection, () => Promise.reject(new Error('unreachable')))
		expect(failed).toEqual({ uploaded: 0, state: 'incomplete' })
	})
})

describe('fabrika-source-maps', () => {
	const environment = (upload: unknown, key = BEARER) => ({
		FABRIKA_SOURCE_MAP_UPLOAD: JSON.stringify(upload),
		FABRIKA_SOURCE_MAP_UPLOAD_KEY: key,
	})

	test('uploads the maps of the asset roots the build names', async () => {
		await withTree({ 'dist/web/chunk-abc.js.map': MAP }, async (root) => {
			const paths: (string | null)[] = []
			const result = await runSourceMapUpload(
				root,
				environment({ destination: DESTINATION, assetRoots: [{ prefix: '/', dir: 'dist/web' }] }),
				(input, init) => {
					paths.push(new Request(input, init).headers.get('X-Fabrika-Artifact-Path'))
					return Promise.resolve(new Response(null, { status: 201 }))
				},
			)
			expect(result).toEqual({ uploaded: 1, state: 'complete' })
			expect(paths).toEqual(['chunk-abc.js'])
		})
	})

	test('without its destination or bearer it uploads nothing and reports incomplete', async () => {
		const refuse = () => Promise.reject(new Error('no request expected'))
		expect(await runSourceMapUpload('.', environment({ destination: DESTINATION, assetRoots: [] }, ''), refuse)).toEqual({
			uploaded: 0,
			state: 'incomplete',
		})
		expect(await runSourceMapUpload('.', environment({ assetRoots: [] }), refuse)).toEqual({ uploaded: 0, state: 'incomplete' })
	})

	test('its report line is the one the provider reads back from a build log', () => {
		expect(readSourceMapUploadReport(sourceMapUploadReport(3, 'complete'))).toBe('complete')
		expect(readSourceMapUploadReport(`2026-10-15T10:00:00Z ${sourceMapUploadReport(0, 'incomplete')}`)).toBe('incomplete')
		expect(readSourceMapUploadReport('fabrika-source-maps: some uploaded, state=complete')).toBeNull()
	})
})
