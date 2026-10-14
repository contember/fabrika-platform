import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
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
	readPackages,
	stagedManifest,
	stagedSkill,
	stagePackage,
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
	test('preserves own prototype-named JSON metadata and dependency keys through staging and manifest boundaries', () => {
		const text =
			'{"name":"@fabrika/example","version":"0.0.4","publishConfig":{"access":"public"},"__proto__":{"custom":true},"dependencies":{"__proto__":"workspace:*","constructor":"^1"},"optionalDependencies":{"__proto__":"^2"},"peerDependencies":{"__proto__":"^3"}}'
		const info = packageInfo(text, '/fixture')
		const staged = stagedManifest(info, '1.2.3', new Set(['__proto__']))
		for (
			const manifest of [
				parsePackageManifest(text, 'source'),
				info.manifest,
				staged,
				parsePackedManifest(text, 'packed'),
				parseInstalledManifest(text, 'installed'),
			]
		) {
			expect(Object.hasOwn(manifest, '__proto__')).toBe(true)
			expect(Object.entries(manifest).find(([key]) => key === '__proto__')).toEqual(['__proto__', { custom: true }])
			expect(Object.getPrototypeOf(manifest)).toBe(Object.prototype)
		}
		expect(JSON.stringify(staged)).toContain('"dependencies":{"__proto__":"^1.2.3","constructor":"^1"}')
		expect(JSON.stringify(staged)).toContain('"optionalDependencies":{"__proto__":"^2"}')
		expect(JSON.stringify(staged)).toContain('"peerDependencies":{"__proto__":"^3"}')
		const packed = parsePackedManifest('{"name":"x","version":"1","devDependencies":{"__proto__":"^4"}}', 'packed')
		expect(Object.entries(packed.devDependencies ?? {})).toEqual([['__proto__', '^4']])
	})

	test('validates prototype-named dependency values rather than restoring unvalidated data', () => {
		for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
			const text = `{"name":"x","version":"1","${field}":{"__proto__":false}}`
			expect(() => parsePackedManifest(text, 'packed')).toThrow()
		}
	})
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
	test('visits own prototype-named JSON export conditions and bin commands', () => {
		const manifest = parsePackedManifest(
			'{"name":"x","version":"1","exports":{".":{"default":"./index.js","__proto__":"./custom.js"}},"bin":{"__proto__":"./cli.js"}}',
			'packed',
		)
		const targets = new Set<string>()
		collectExportTargets(manifest['exports'], 'fixture.exports', targets)
		collectBinTargets(manifest['bin'], 'fixture.bin', targets)
		expect([...targets]).toEqual(['./index.js', './custom.js', './cli.js'])
	})

	test('rejects invalid targets under prototype-named JSON keys', () => {
		const manifest = parsePackedManifest(
			'{"name":"x","version":"1","exports":{".":{"default":"./index.js","__proto__":"missing-prefix.js"}},"bin":{"__proto__":false}}',
			'packed',
		)
		expect(() => collectExportTargets(manifest['exports'], 'fixture.exports', new Set())).toThrow()
		expect(() => collectBinTargets(manifest['bin'], 'fixture.bin', new Set())).toThrow()
	})
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
	const metadata = {
		tag: 'v0.0.4',
		version: '0.0.4',
		packages: [{ name: '@fabrika/app', filename: 'app.tgz', dependencies: ['@fabrika/auth'], integrity: 'sha512-AAAA' }],
	}
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
			{ ...metadata, packages: [{ name: 'x', filename: 'x', dependencies: [] }] },
			{ ...metadata, packages: [{ name: 'x', filename: 'x', dependencies: [], integrity: 'md5-AAAA' }] },
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

describe('a staged agent skill', () => {
	test('carries the released version in its frontmatter, and nothing else changes', async () => {
		const source = await readFile(resolve(import.meta.dir, '../../packages/app/skill/SKILL.md'), 'utf8')
		const staged = stagedSkill(source, '1.2.3')
		expect(staged).toContain('\nversion: 1.2.3\n')
		expect(staged.replace('\nversion: 1.2.3\n', '')).toBe(source.replace(/\nversion: \S+\n/, ''))
	})

	test('refuses a skill without a version', () => {
		expect(() => stagedSkill('---\nname: x\n---\n\n# x\n', '1.2.3')).toThrow('must carry a version')
	})
})

describe('staging the whole public set', () => {
	test("stages every public package; only @fabrika/app's skill is versioned, its examples pinned to the release", async () => {
		const { publicPackages } = packageGraph(await readPackages())
		const publicNames = new Set(publicPackages.map((item) => item.name))
		const root = await mkdtemp(join(tmpdir(), 'fabrika-stage-'))
		try {
			for (const item of publicPackages) await stagePackage(item, '9.8.7', publicNames, join(root, item.name.replace('/', '-')))
			const app = join(root, '@fabrika-app', 'skill')
			expect(await readFile(join(app, 'SKILL.md'), 'utf8')).toContain('\nversion: 9.8.7\n')
			const setup = await readFile(join(app, 'references', 'app-setup.md'), 'utf8')
			expect(setup).toContain('"@fabrika/app": "^9.8.7"')
			expect(setup).not.toMatch(/"@fabrika\/[a-z-]+": "\^0\./)
			expect(setup).toContain('"zod": "^3.25.76"')
			const builder = publicPackages.find((item) => item.name === '@fabrika/builder')
			if (builder !== undefined) {
				const source = await readFile(join(builder.directory, 'skill', 'SKILL.md'), 'utf8')
				expect(await readFile(join(root, '@fabrika-builder', 'skill', 'SKILL.md'), 'utf8')).toBe(source)
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}, 120_000)
})

describe('the packages a Zerops application installs', () => {
	// What an installer follows from a shipped manifest: every dependency and optional dependency, and each peer that
	// is not marked optional. An optional peer is installed only when the application declares it itself.
	const shippedSchema = z.object({
		dependencies: z.record(z.string()).optional(),
		optionalDependencies: z.record(z.string()).optional(),
		peerDependencies: z.record(z.string()).optional(),
		peerDependenciesMeta: z.record(z.object({ optional: z.boolean().optional() })).optional(),
	})
	const installed = (manifest: z.infer<typeof shippedSchema>): string[] => [
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}).filter((name) => manifest.peerDependenciesMeta?.[name]?.optional !== true),
	]

	test('are what it imports and the dev tooling, without the builder or the Cloudflare provider', async () => {
		const { publicPackages } = packageGraph(await readPackages())
		const publicNames = new Set(publicPackages.map((item) => item.name))
		const shipped = new Map(publicPackages.map((item) => [item.name, shippedSchema.parse(stagedManifest(item, '9.8.7', publicNames))]))
		const closure = new Set<string>()
		const visit = (name: string): void => {
			const manifest = shipped.get(name)
			if (manifest === undefined || closure.has(name)) return
			closure.add(name)
			for (const dependency of installed(manifest)) visit(dependency)
		}
		for (
			const name of [
				'@fabrika/app',
				'@fabrika/db',
				'@fabrika/provider-zerops',
				'@fabrika/proxy-core',
				'@fabrika/cli',
				'@fabrika/check',
				'@fabrika/platform',
			]
		) {
			visit(name)
		}
		expect([...closure].sort()).toEqual([
			'@fabrika/app',
			'@fabrika/auth',
			'@fabrika/auth-core',
			'@fabrika/check',
			'@fabrika/cli',
			'@fabrika/control-contract',
			'@fabrika/db',
			'@fabrika/iam-contract',
			'@fabrika/installation-init',
			'@fabrika/jwks',
			'@fabrika/platform',
			'@fabrika/platform-node',
			'@fabrika/provider-contract',
			'@fabrika/provider-zerops',
			'@fabrika/proxy-core',
		])
	})
})
