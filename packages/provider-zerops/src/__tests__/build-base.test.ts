import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { buildBaseLockfileRefusal, bunLockfileVersion, type ZeropsBuildBase, zeropsBuildBase } from '../build-base'
import { assertBuildBaseReadsLockfile } from '../cli'
import { compileFabrikaManifest, createZeropsArtifactSourceDescriptor, type FabrikaManifest } from '../manifest'
import type { ZeropsAppConfig } from '../types'

/** A `bun.lock` as Bun writes it: JSONC, with trailing commas. */
const lockfile = (version: number): string =>
	`{\n  "lockfileVersion": ${version},\n  "configVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "app",\n    },\n  },\n  "packages": {},\n}\n`

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
		expect(bunLockfileVersion(`﻿${lockfile(0)}`)).toBe(0)
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
			'bun.lock has lockfileVersion 2, which Bun 1.3 cannot read, and the platform build runs `bun install --frozen-lockfile` on build.base `alpine/bun@1.3` of zerops.yaml setup `app`; set build.base: alpine/bun@1.4 (Bun 1.4 or later reads it), or write bun.lock with Bun 1.3',
		)
		expect(buildBaseLockfileRefusal(lockfile(2), authored('ubuntu/bun@1.3.9'))).toContain('set build.base: ubuntu/bun@1.4 ')
		expect(buildBaseLockfileRefusal(lockfile(2), authored('bun@1.2'))).toContain('set build.base: bun@1.4 ')
	})

	test('a lockfileVersion 2 builds on Bun 1.4 and later', () => {
		expect(buildBaseLockfileRefusal(lockfile(2), authored('alpine/bun@1.4'))).toBeNull()
		expect(buildBaseLockfileRefusal(lockfile(2), authored('alpine/bun@1.4.4'))).toBeNull()
		expect(buildBaseLockfileRefusal(lockfile(2), authored('alpine/bun@2.0'))).toBeNull()
	})

	test('lockfileVersion 0 and 1 build on Bun 1.2 and 1.3, and not on 1.1', () => {
		for (const version of [0, 1]) {
			expect(buildBaseLockfileRefusal(lockfile(version), authored('alpine/bun@1.3'))).toBeNull()
			expect(buildBaseLockfileRefusal(lockfile(version), authored('alpine/bun@1.2'))).toBeNull()
			expect(buildBaseLockfileRefusal(lockfile(version), authored('ubuntu/bun@1.1'))).toContain('set build.base: ubuntu/bun@1.2 ')
		}
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
	test('is the selected setup authored build.base', async () => {
		const manifest = await compile(contractApp, 'zerops:\n  - setup: notesapi\n    build:\n      base: alpine/bun@1.4\n')
		expect(zeropsBuildBase(manifest)).toEqual({ setup: 'notesapi', bases: ['alpine/bun@1.4'], authored: true })
	})

	test('is the platform runtime for a contract application that names none, and the refusal says so', async () => {
		const manifest = await compile(contractApp, 'zerops:\n  - setup: notesapi\n')
		const base = zeropsBuildBase(manifest)
		expect(base).toEqual({ setup: 'notesapi', bases: ['alpine/bun@1.3'], authored: false })
		expect(buildBaseLockfileRefusal(lockfile(2), base)).toContain(
			'on `alpine/bun@1.3`, the base of zerops.yaml setup `notesapi`, which names no build.base; set build.base: alpine/bun@1.4 ',
		)
	})

	test('is the build of the first applied setup that has one, through extends', async () => {
		const descriptor = [
			'zerops:',
			'  - setup: base',
			'    build:',
			'      base: [alpine/go@latest, alpine/bun@1.3]',
			'  - setup: app',
			'    extends: base',
			'    run:',
			'      start: bun server.ts',
		].join('\n')
		expect(zeropsBuildBase(await compile({ ...plainApp, target: { ...plainApp.target, zeropsSetup: 'app' } }, descriptor))).toEqual({
			setup: 'app',
			bases: ['alpine/go@latest', 'alpine/bun@1.3'],
			authored: true,
		})
	})

	test('is none for an application without a contract that names none', async () => {
		expect(zeropsBuildBase(await compile(plainApp, 'zerops:\n  - setup: app\n'))).toEqual({ setup: 'app', bases: [], authored: false })
	})
})

describe('fabrika app build against the repository bun.lock', () => {
	const roots: string[] = []

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
	})

	const rootWith = async (files: Readonly<Record<string, string>>): Promise<string> => {
		const root = await mkdtemp(join(tmpdir(), 'fabrika-zerops-build-base-'))
		roots.push(root)
		await Promise.all(Object.entries(files).map(([path, text]) => writeFile(join(root, path), text)))
		return root
	}

	test('refuses a build base older than the Bun that wrote it', async () => {
		const manifest = await compile(contractApp, 'zerops:\n  - setup: notesapi\n    build:\n      base: alpine/bun@1.3\n')
		const root = await rootWith({ 'bun.lock': lockfile(2) })
		await expect(assertBuildBaseReadsLockfile(manifest, root)).rejects.toThrow(
			'fabrika app build: bun.lock has lockfileVersion 2, which Bun 1.3 cannot read',
		)
	})

	test('accepts a base that reads it, and a repository without a bun.lock', async () => {
		const manifest = await compile(contractApp, 'zerops:\n  - setup: notesapi\n    build:\n      base: alpine/bun@1.4\n')
		await assertBuildBaseReadsLockfile(manifest, await rootWith({ 'bun.lock': lockfile(2) }))
		const older = await compile(contractApp, 'zerops:\n  - setup: notesapi\n')
		await assertBuildBaseReadsLockfile(older, await rootWith({}))
	})
})
