import { describe, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
	collectBinTargets,
	collectExportTargets,
	packageGraph,
	packageInfo,
	parseInstalledManifest,
	parsePackageManifest,
	parsePackedManifest,
	parseRegistryDistTag,
	parseRegistryIntegrity,
	parseRegistryPackageName,
	parseReleaseManifest,
	stagedManifest,
} from '../release'

const publicManifest = {
	name: '@fabrika/example',
	version: '0.0.4',
	publishConfig: { access: 'public', provenance: true },
	exports: { '.': { bun: './src/index.ts', default: ['./dist/index.js', null] } },
	bin: { example: './bin/cli.js' },
	dependencies: { '@fabrika/app': 'workspace:*', external: '^2.0.0' },
	optionalDependencies: { '@fabrika/auth': 'workspace:^' },
	peerDependencies: { '@fabrika/engine': 'workspace:~' },
	devDependencies: { typescript: '^5' },
	custom: { nested: [false, null, { keep: 'verbatim' }] },
}

describe('release package boundaries', () => {
	test('staging preserves extensions and targets, rewrites only internal ranges, and leaves its input untouched', () => {
		const source = JSON.stringify(publicManifest)
		const info = packageInfo(source, '/fixture')
		const staged = stagedManifest(info, '1.2.3', new Set(['@fabrika/app', '@fabrika/auth', '@fabrika/engine']))
		const { devDependencies: _dev, ...retained } = publicManifest
		const expected = {
			...retained,
			version: '1.2.3',
			dependencies: { '@fabrika/app': '^1.2.3', external: '^2.0.0' },
			optionalDependencies: { '@fabrika/auth': '^1.2.3' },
			peerDependencies: { '@fabrika/engine': '^1.2.3' },
		}
		expect(staged).toEqual(expected)
		expect(info.manifest).toEqual(publicManifest)
		expect(parsePackedManifest(JSON.stringify(staged), 'packed')).toEqual(expected)
		expect(parseInstalledManifest(JSON.stringify(staged), 'installed')).toEqual(expected)
	})

	test('private manifests retain opaque fields without public-package validation', () => {
		const manifest = { name: 'private-tool', private: true, version: null, dependencies: false, publishConfig: [], custom: { x: 1 } }
		expect(packageInfo(JSON.stringify(manifest), '/fixture')).toMatchObject({ manifest, publishable: false, dependencies: {} })
		expect(() => packageInfo(JSON.stringify({ ...manifest, publishConfig: { access: 'public' } }), '/fixture'))
			.toThrow('private package must not declare public publishing')
		expect(() => packageInfo(JSON.stringify({ name: 'unclassified' }), '/fixture')).toThrow('package must be private')
	})

	for (const value of [null, [], false, {}, { name: '' }, { name: 1 }]) {
		test(`rejects malformed package identity ${JSON.stringify(value)}`, () => {
			expect(() => parsePackageManifest(JSON.stringify(value), 'fixture')).toThrow()
		})
	}

	test('rejects invalid JSON with source context', () => {
		expect(() => parsePackageManifest('{', '/fixture/package.json')).toThrow('/fixture/package.json: invalid JSON')
	})

	for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
		for (const value of [null, [], false, { bad: 1 }]) {
			test(`rejects malformed public ${field}: ${JSON.stringify(value)}`, () => {
				expect(() => packageInfo(JSON.stringify({ ...publicManifest, [field]: value }), '/fixture')).toThrow()
				expect(() => parsePackedManifest(JSON.stringify({ ...publicManifest, [field]: value }), 'packed')).toThrow()
			})
		}
	}

	test('only packed manifests require valid devDependency maps; installed manifests need only identity', () => {
		const manifest = { ...publicManifest, devDependencies: false }
		expect(packageInfo(JSON.stringify(manifest), '/fixture').manifest).toEqual(manifest)
		expect(() => parsePackedManifest(JSON.stringify(manifest), 'packed')).toThrow()
		expect(parseInstalledManifest(JSON.stringify({ ...manifest, dependencies: null }), 'installed')['dependencies']).toBeNull()
		for (const version of ['', null, 1]) {
			expect(() => parseInstalledManifest(JSON.stringify({ ...manifest, version }), 'installed')).toThrow()
			expect(() => packageInfo(JSON.stringify({ ...manifest, version }), '/fixture')).toThrow()
		}
	})
})

describe('packed entry point traversal', () => {
	test('visits every conditional and fallback target, retains null exclusions, and deduplicates files', () => {
		const targets = new Set<string>()
		collectExportTargets(
			{
				'.': { bun: './src/index.ts', default: ['./dist/index.js', { import: './dist/index.js' }, null] },
				'./feature': './src/feature.ts',
				'./blocked': null,
			},
			'fixture.exports',
			targets,
		)
		collectBinTargets({ tool: './bin/cli.js', alias: './bin/cli.js' }, 'fixture.bin', targets)
		expect([...targets]).toEqual(['./src/index.ts', './dist/index.js', './src/feature.ts', './bin/cli.js'])
		collectBinTargets(undefined, 'fixture.bin', targets)
		collectBinTargets('./other.js', 'fixture.bin', targets)
		expect([...targets].at(-1)).toBe('./other.js')
	})

	for (
		const value of [
			undefined,
			false,
			1,
			'',
			'index.js',
			'./src/*',
			'./src/',
			[],
			{},
			{ '.': './index.js', import: './index.js' },
			{
				'': './index.js',
			},
			{ '..': './index.js' },
			{ '.': { import: [null, false] } },
		]
	) {
		test(`rejects invalid exports ${JSON.stringify(value)}`, () => {
			expect(() => collectExportTargets(value, 'fixture.exports', new Set())).toThrow()
		})
	}
	for (const value of [null, [], {}, '', 'cli.js', './bin/', { '': './cli.js' }, { tool: false }, { tool: './bin/' }]) {
		test(`rejects invalid bin ${JSON.stringify(value)}`, () => {
			expect(() => collectBinTargets(value, 'fixture.bin', new Set())).toThrow()
		})
	}
})

describe('artifact metadata', () => {
	const metadata = { tag: 'v0.0.4', version: '0.0.4', packages: [{ name: '@fabrika/app', filename: 'app.tgz', dependencies: ['@fabrika/auth'] }] }
	test('retains metadata order and strips extensions as before', () => {
		expect(parseReleaseManifest(
			JSON.stringify({
				...metadata,
				extra: true,
				packages: metadata.packages.map((entry) => ({ ...entry, extra: true })),
			}),
			'release',
		)).toEqual(metadata)
	})
	for (
		const value of [
			null,
			[],
			{ ...metadata, tag: '' },
			{ ...metadata, version: false },
			{ ...metadata, packages: {} },
			{
				...metadata,
				packages: [null],
			},
			{ ...metadata, packages: [{ name: '', filename: 'x', dependencies: [] }] },
			{
				...metadata,
				packages: [{ name: 'x', filename: '', dependencies: [] }],
			},
			{ ...metadata, packages: [{ name: 'x', filename: 'x', dependencies: [1] }] },
		]
	) {
		test(`rejects malformed metadata ${JSON.stringify(value)}`, () => {
			expect(() => parseReleaseManifest(JSON.stringify(value), 'release')).toThrow()
		})
	}
})

describe('npm JSON output', () => {
	test('accepts exact string values and the missing dist-tag forms', () => {
		expect(parseRegistryIntegrity('"sha512-abc"\n', 'app')).toBe('sha512-abc')
		expect(parseRegistryPackageName('"@fabrika/app"\n', 'app')).toBe('@fabrika/app')
		expect(parseRegistryDistTag('"1.2.3"', 'app', 'latest')).toBe('1.2.3')
		expect(parseRegistryDistTag('null', 'app', 'latest')).toBeUndefined()
		expect(parseRegistryDistTag(' \n', 'app', 'latest')).toBeUndefined()
	})
	for (const text of ['{', '{}', '[]', 'false', '1', '""']) {
		test(`rejects malformed registry metadata ${text}`, () => {
			expect(() => parseRegistryIntegrity(text, 'app')).toThrow()
			expect(() => parseRegistryPackageName(text, 'app')).toThrow()
			expect(() => parseRegistryDistTag(text, 'app', 'latest')).toThrow()
		})
	}
	test('does not turn an object mentioning a package into evidence of its existence', () => {
		expect(() => parseRegistryPackageName('{"error":"@fabrika/app"}', 'app')).toThrow()
		expect(() => parseRegistryIntegrity('null', 'app')).toThrow('npm did not return dist.integrity')
		expect(() => parseRegistryDistTag('{', 'app', 'latest')).toThrow('npm returned invalid latest dist-tag metadata')
	})
})

describe('release dependency graph', () => {
	const root = resolve(import.meta.dir, '../..')
	const inventory = async () => {
		const packages = []
		for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const directory = join(root, 'packages', entry.name)
			const path = join(directory, 'package.json')
			if (await Bun.file(path).exists()) packages.push(packageInfo(await readFile(path, 'utf8'), directory))
		}
		return packages
	}

	test('places every local dependency before its consumer', async () => {
		const { order } = packageGraph(await inventory())
		const positions = new Map(order.map((item, index) => [item.name, index]))
		for (const [index, item] of order.entries()) {
			for (const dependencies of [item.dependencies.dependencies, item.dependencies.peerDependencies, item.dependencies.optionalDependencies]) {
				for (const name of Object.keys(dependencies ?? {})) {
					const position = positions.get(name)
					if (position !== undefined) expect(position).toBeLessThan(index)
				}
			}
		}
	})

	for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
		test(`rejects private or missing workspace targets and non-workspace local ${field}`, async () => {
			const packages = await inventory()
			const privatePackage = packages.find((item) => !item.publishable)
			if (privatePackage === undefined) throw new Error('Fixture requires a private package')
			for (
				const { name, range, message } of [
					{ name: privatePackage.name, range: 'workspace:*', message: 'must not depend on private package' },
					{ name: '@fabrika/nonexistent', range: 'workspace:*', message: 'missing workspace package' },
					{ name: '@fabrika/auth-core', range: '^0.0.4', message: 'must use the workspace protocol' },
				]
			) {
				const changed = packages.map((item) =>
					item.name === '@fabrika/app'
						? packageInfo(JSON.stringify({ ...item.manifest, [field]: { [name]: range } }), item.directory)
						: item
				)
				expect(() => packageGraph(changed)).toThrow(message)
			}
		})
	}
})
