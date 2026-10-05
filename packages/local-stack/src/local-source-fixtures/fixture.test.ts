import { createTarRewrite } from '@fabrika/source-zerops'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
	LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE,
	LOCAL_SOURCE_MANIFEST_FILE,
	LOCAL_SOURCE_MAX_COMPRESSED_BYTES,
	LOCAL_SOURCE_MAX_MANIFEST_BYTES,
	LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE,
	type LocalSourceManifest,
} from '../local-source-contract'
import { loadLocalSourceFixtures, prepareLocalSourceFixtures } from './fixture'
import { sha256 } from './generate'

const roots: string[] = []

async function directory(): Promise<string> {
	const root = await mkdtemp(join(import.meta.dir, '.test-'))
	roots.push(root)
	return root
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('local immutable source fixtures', () => {
	test('independent generations and repeated preparation preserve exact identities and bytes', async () => {
		const first = await directory()
		const second = await directory()
		const manifest = await prepareLocalSourceFixtures(first)
		expect(await prepareLocalSourceFixtures(second)).toEqual(manifest)
		expect(await prepareLocalSourceFixtures(first)).toEqual(manifest)
		expect(await loadLocalSourceFixtures(first)).toEqual(manifest)
		for (const file of [LOCAL_SOURCE_MANIFEST_FILE, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE, LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE]) {
			expect(await readFile(join(first, file))).toEqual(await readFile(join(second, file)))
		}
		expect((await readdir(first)).sort()).toEqual([
			LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE,
			LOCAL_SOURCE_MANIFEST_FILE,
			LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE,
		])
	})

	test('real source tar admission verifies Git PAX identity, descriptors and safe platform symlink', async () => {
		const root = await directory()
		const manifest = await prepareLocalSourceFixtures(root)
		for (const kind of ['platform', 'application'] satisfies ('platform' | 'application')[]) {
			const fixture = manifest[kind]
			const file = kind === 'platform' ? LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE : LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE
			const tar = Bun.gunzipSync(await readFile(join(root, file)))
			const rewrite = createTarRewrite({
				...(kind === 'platform' ? { archiveKind: 'platform' } : {}),
				commitSha: fixture.commitSha,
				descriptorSha256: fixture.descriptorSha256,
			})
			await new Response(new Blob([tar]).stream().pipeThrough(rewrite.transform)).arrayBuffer()
			expect(await rewrite.completed).toMatchObject({ commitSha: fixture.commitSha, descriptorSha256: fixture.descriptorSha256 })
			expect(new TextDecoder().decode(tar)).toContain(`fabrika-local-${kind}-${fixture.commitSha}/`)
		}
		expect(manifest.platform.tree.find(entry => entry.path === 'marker-link')?.mode).toBe('120000')
		expect(manifest.application.tree.every(entry => entry.mode === '100644')).toBe(true)
	})

	test('inherited Git repository, index, config and author settings cannot alter generation', async () => {
		const root = await directory()
		const output = join(root, 'output')
		const child = Bun.spawn([
			process.execPath,
			'-e',
			`import {prepareLocalSourceFixtures} from ${JSON.stringify(join(import.meta.dir, 'fixture.ts'))}; await prepareLocalSourceFixtures(${
				JSON.stringify(output)
			});`,
		], {
			cwd: root,
			env: {
				...process.env,
				GIT_DIR: join(root, 'missing-git'),
				GIT_WORK_TREE: root,
				GIT_INDEX_FILE: join(root, 'must-not-exist'),
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: 'core.autocrlf',
				GIT_CONFIG_VALUE_0: 'true',
				GIT_AUTHOR_NAME: 'not the fixture author',
				GIT_AUTHOR_DATE: '2026-10-05T12:00:00Z',
			},
			stdout: 'pipe',
			stderr: 'pipe',
		})
		const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])
		expect(errors).toBe('')
		expect(code).toBe(0)
		await loadLocalSourceFixtures(output)
		expect((await readdir(root)).sort()).toEqual(['output'])
	})

	const mutations: { name: string; change: (manifest: LocalSourceManifest) => void }[] = [
		{
			name: 'commit',
			change: value => {
				value.platform.commitSha = 'a'.repeat(40)
			},
		},
		{
			name: 'tree identity',
			change: value => {
				value.platform.treeSha = 'a'.repeat(40)
			},
		},
		{
			name: 'tree entries',
			change: value => {
				value.platform.tree = []
			},
		},
		{
			name: 'descriptor bytes and matching digest',
			change: value => {
				value.application.descriptorContents = 'zerops: [{setup: wrong}]\n'
				value.application.descriptorSha256 = sha256(new TextEncoder().encode(value.application.descriptorContents))
			},
		},
		{
			name: 'descriptor digest',
			change: value => {
				value.platform.descriptorSha256 = 'a'.repeat(64)
			},
		},
		{
			name: 'archive digest',
			change: value => {
				value.platform.archiveSha256 = 'a'.repeat(64)
			},
		},
		{
			name: 'tree budget',
			change: value => {
				value.platform.tree = Array.from({ length: 129 }, () => ({ path: 'marker.txt', sha: 'a'.repeat(40), type: 'blob', mode: '100644' }))
			},
		},
	]
	for (const mutation of mutations) {
		test(`rejects changed ${mutation.name} without replacing persisted output`, async () => {
			const root = await directory()
			const manifest = await prepareLocalSourceFixtures(root)
			mutation.change(manifest)
			const bytes = JSON.stringify(manifest)
			await writeFile(join(root, LOCAL_SOURCE_MANIFEST_FILE), bytes)
			await expect(loadLocalSourceFixtures(root)).rejects.toThrow()
			await expect(prepareLocalSourceFixtures(root)).rejects.toThrow()
			expect(await readFile(join(root, LOCAL_SOURCE_MANIFEST_FILE), 'utf8')).toBe(bytes)
		})
	}

	test('rejects corrupted or symlinked archives and incomplete publication', async () => {
		const root = await directory()
		await prepareLocalSourceFixtures(root)
		const path = join(root, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE)
		const archive = await readFile(path)
		archive[0] = 0
		await writeFile(path, archive)
		await expect(loadLocalSourceFixtures(root)).rejects.toThrow('archive mismatch')
		await rm(path)
		await symlink(LOCAL_SOURCE_APPLICATION_ARCHIVE_FILE, path)
		await expect(loadLocalSourceFixtures(root)).rejects.toThrow('file or byte budget')
		await rm(join(root, LOCAL_SOURCE_MANIFEST_FILE))
		await expect(prepareLocalSourceFixtures(root)).rejects.toThrow()
	})

	test('rejects oversized manifest and archive files before reading their contents', async () => {
		const root = await directory()
		await prepareLocalSourceFixtures(root)
		await writeFile(join(root, LOCAL_SOURCE_PLATFORM_ARCHIVE_FILE), new Uint8Array(LOCAL_SOURCE_MAX_COMPRESSED_BYTES + 1))
		await expect(loadLocalSourceFixtures(root)).rejects.toThrow('byte budget')
		await writeFile(join(root, LOCAL_SOURCE_MANIFEST_FILE), new Uint8Array(LOCAL_SOURCE_MAX_MANIFEST_BYTES + 1))
		await expect(loadLocalSourceFixtures(root)).rejects.toThrow('byte budget')
	})
})
