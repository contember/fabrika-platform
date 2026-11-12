import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { buildBaseLockfileRefusal, bunLockfileVersion, type ZeropsBuildBase, zeropsBuildBase } from '../build-base'
import { buildZeropsManifestText, runZeropsCli } from '../cli'
import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, type FabrikaManifest } from '../manifest'
import type { ZeropsAppConfig } from '../types'

/** A `bun.lock` as Bun writes it: JSONC, with trailing commas. */
const lockfile = (version: number): string =>
	`{\n  "lockfileVersion": ${version},\n  "configVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "app",\n    },\n  },\n  "packages": {},\n}\n`

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff)

const authored = (...bases: string[]): ZeropsBuildBase => ({ setup: 'app', bases, authored: true })

const contractApp: ZeropsAppConfig = {
	id: 'notes',
	target: {
		platform: 'zerops',
		services: () => [{ hostname: 'notesapi', type: 'alpine/bun@1.3' }],
		deployService: 'notesapi',
		contract: notesArtifact,
		proxy: { upstream: 'notesapi:3000', ...contractProxyTable(notesArtifact) },
	},
}

const plainApp: ZeropsAppConfig = { id: 'app', target: { platform: 'zerops', services: () => [{ hostname: 'app', type: 'alpine/bun@1.3' }] } }

const compile = async (config: ZeropsAppConfig, descriptor: string): Promise<FabrikaManifest> =>
	compileFabrikaManifest(config, 'prod', await createZeropsArtifactSourceDescriptor(descriptor))

describe('the lockfile version of a bun.lock', () => {
	test('is read from the first key, through trailing commas the JSON parser refuses', () => {
		expect(bunLockfileVersion(lockfile(2))).toBe(2)
		expect(bunLockfileVersion(`${BYTE_ORDER_MARK}${lockfile(0)}`)).toBe(0)
		expect(bunLockfileVersion('{"lockfileVersion":1}')).toBe(1)
	})

	test('is unknown for text that does not start with it', () => {
		expect(bunLockfileVersion('{ "packages": {}, "lockfileVersion": 2 }')).toBeNull()
		expect(bunLockfileVersion('{ "lockfileVersion": "2" }')).toBeNull()
		expect(bunLockfileVersion('')).toBeNull()
	})
})

describe('a build base that cannot read the bun.lock', () => {
	test('a lockfileVersion 2 is refused on Bun 1.3, naming the base that reads it', () => {
		expect(buildBaseLockfileRefusal(lockfile(2), authored('alpine/bun@1.3'))).toBe(
			'bun.lock has lockfileVersion 2, which Bun 1.3 cannot read, and the platform build runs `bun install --frozen-lockfile` on build.base `alpine/bun@1.3` of zerops.yaml setup `app`; set build.base: alpine/bun@1.4, or regenerate bun.lock with Bun 1.3, which resolves every dependency afresh',
		)
		expect(buildBaseLockfileRefusal(lockfile(2), authored('ubuntu/bun@1.3.9'))).toContain('set build.base: ubuntu/bun@1.4,')
		expect(buildBaseLockfileRefusal(lockfile(2), authored('bun@1.2'))).toContain('set build.base: bun@1.4,')
	})

	test('a lockfileVersion 2 builds on Bun 1.4 and later', () => {
		expect(buildBaseLockfileRefusal(lockfile(2), authored('alpine/bun@1.4'))).toBeNull()
		expect(buildBaseLockfileRefusal(lockfile(2), authored('alpine/bun@1.4.4'))).toBeNull()
		expect(buildBaseLockfileRefusal(lockfile(2), authored('alpine/bun@2.0'))).toBeNull()
	})

	test('lockfileVersion 0 and 1 build on every offered base, and a refusal names no base older than 1.3', () => {
		for (const version of [0, 1]) {
			expect(buildBaseLockfileRefusal(lockfile(version), authored('alpine/bun@1.3'))).toBeNull()
			expect(buildBaseLockfileRefusal(lockfile(version), authored('alpine/bun@1.4'))).toBeNull()
		}
		expect(buildBaseLockfileRefusal(lockfile(1), authored('alpine/bun@1.2'))).toBeNull()
		// Bun 1.1.39 and later read version 0, so a 1.1 base is not refused for it; version 1 needs 1.2.
		expect(buildBaseLockfileRefusal(lockfile(0), authored('ubuntu/bun@1.1'))).toBeNull()
		expect(buildBaseLockfileRefusal(lockfile(1), authored('ubuntu/bun@1.1'))).toContain('set build.base: ubuntu/bun@1.3,')
	})

	test('a lockfileVersion newer than every known one is refused on every known Bun', () => {
		const refusal = 'bun.lock has lockfileVersion 3, newer than any Bun base this release knows (Bun 1.4 reads up to lockfileVersion 2)'
		expect(buildBaseLockfileRefusal(lockfile(3), authored('alpine/bun@1.3'))).toStartWith(refusal)
		expect(buildBaseLockfileRefusal(lockfile(3), authored('alpine/bun@1.4'))).toStartWith(refusal)
		expect(buildBaseLockfileRefusal(lockfile(3), authored('alpine/bun@1.5'))).toBeNull()
	})

	test('a base whose Bun is not known by its name is not checked', () => {
		for (const base of ['alpine/bun@latest', 'alpine/bun@1', 'alpine/bun@canary', 'nodejs@22', 'alpine/go@latest']) {
			expect(buildBaseLockfileRefusal(lockfile(2), authored(base))).toBeNull()
		}
		expect(buildBaseLockfileRefusal('{}', authored('alpine/bun@1.3'))).toBeNull()
	})

	test('every Bun of a list of bases is checked', () => {
		expect(buildBaseLockfileRefusal(lockfile(2), authored('alpine/go@latest', 'alpine/bun@1.3'))).toContain('Bun 1.3 cannot read')
	})
})

describe('the build base of a manifest', () => {
	test("is a contract application's authored build.base, a name or a list", async () => {
		const manifest = await compile(contractApp, 'zerops:\n  - setup: notesapi\n    build:\n      base: alpine/bun@1.4\n')
		expect(zeropsBuildBase(manifest)).toEqual({ setup: 'notesapi', bases: ['alpine/bun@1.4'], authored: true })
		const list = await compile(contractApp, 'zerops:\n  - setup: notesapi\n    build:\n      base: [alpine/go@latest, alpine/bun@1.3]\n')
		expect(zeropsBuildBase(list)).toEqual({ setup: 'notesapi', bases: ['alpine/go@latest', 'alpine/bun@1.3'], authored: true })
	})

	test('is the platform runtime for a contract application that names none, and the refusal says so', async () => {
		const manifest = await compile(contractApp, 'zerops:\n  - setup: notesapi\n')
		const base = zeropsBuildBase(manifest)
		expect(base).toEqual({ setup: 'notesapi', bases: ['alpine/bun@1.3'], authored: false })
		expect(buildBaseLockfileRefusal(lockfile(2), base)).toContain(
			'on `alpine/bun@1.3`, the base of zerops.yaml setup `notesapi`, which names no build.base; set build.base: alpine/bun@1.4,',
		)
	})

	test('is none for an application without a contract: the platform does not generate its build', async () => {
		const descriptor = 'zerops:\n  - setup: app\n    build:\n      base: alpine/bun@1.3\n    run:\n      start: bun server.ts\n'
		expect(zeropsBuildBase(await compile(plainApp, descriptor))).toEqual({ setup: 'app', bases: [], authored: false })
	})
})

describe('fabrika app build and app register against the repository bun.lock', () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
	})

	const href = (path: string): string => JSON.stringify(pathToFileURL(join(import.meta.dir, path)).href)

	/** A contract application's repository root: its config, a `zerops.yaml` on `base` and, unless null, a `bun.lock`. */
	const repository = async (base: string, version: number | null): Promise<string> => {
		const root = await mkdtemp(join(tmpdir(), 'fabrika-zerops-build-base-'))
		roots.push(root)
		await writeFile(
			join(root, 'fabrika.config.ts'),
			[
				`import { defineApp } from ${href('../authoring.ts')}`,
				`import { contractProxyTable } from ${href('../../../proxy-core/src/manifest.ts')}`,
				`import { notesArtifact } from ${href('../../../auth-core/src/__tests__/fixtures/notes-artifact.ts')}`,
				"export default defineApp({ id: 'notes', target: { platform: 'zerops', services: () => [{ hostname: 'notesapi', type: 'alpine/bun@1.3' }],",
				"  deployService: 'notesapi', contract: notesArtifact, proxy: { upstream: 'notesapi:3000', ...contractProxyTable(notesArtifact) } } })",
				'',
			].join('\n'),
		)
		await writeFile(join(root, 'zerops.yaml'), `zerops:\n  - setup: notesapi\n    build:\n      base: ${base}\n`)
		if (version !== null) await writeFile(join(root, 'bun.lock'), lockfile(version))
		return root
	}

	const inside = async <T>(root: string, run: () => Promise<T>): Promise<T> => {
		const originalCwd = process.cwd()
		try {
			process.chdir(root)
			return await run()
		} finally {
			process.chdir(originalCwd)
		}
	}

	test('refuse a build base older than the Bun that wrote it, each naming itself', async () => {
		const root = await repository('alpine/bun@1.3', 2)
		const refusal = 'bun.lock has lockfileVersion 2, which Bun 1.3 cannot read'
		await inside(root, async () => {
			await expect(runZeropsCli(['build', '--env=prod'])).rejects.toThrow(`fabrika app build: ${refusal}`)
			await expect(buildZeropsManifestText({ config: './fabrika.config.ts', env: 'prod' })).rejects.toThrow(`fabrika app register: ${refusal}`)
		})
		expect(await Bun.file(join(root, 'fabrika.manifest.json')).exists()).toBe(false)
	})

	test('accept a base that reads it, and a repository without a bun.lock', async () => {
		await inside(await repository('alpine/bun@1.4', 2), () => buildZeropsManifestText({ config: './fabrika.config.ts', env: 'prod' }))
		await inside(await repository('alpine/bun@1.3', null), () => buildZeropsManifestText({ config: './fabrika.config.ts', env: 'prod' }))
	})
})
