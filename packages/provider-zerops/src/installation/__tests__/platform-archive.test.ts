import { contractProxyTable, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { notesArtifact } from '../../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { renderYaml } from '../../compile'
import { zeropsProxyAcceptsBrand, zeropsProxyManifestCarrier } from '../../proxy-manifest-carrier'
import { archiveWithDataFile } from '../platform-archive'
import { fabrikaZeropsYaml } from '../topology/setups'

const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
const roots: string[] = []
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))

const scratch = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-platform-archive-'))
	roots.push(root)
	return root
}

/** The committed descriptor as `git archive` writes it: a pax global header naming the commit, then the file. */
const committedArchive = async (): Promise<Uint8Array<ArrayBuffer>> =>
	new Uint8Array(await Bun.$`git -C ${REPO_ROOT} archive --format=tar.gz HEAD -- zerops.yaml`.arrayBuffer())

const filesOf = async (archive: Uint8Array<ArrayBuffer>): Promise<Map<string, string>> => {
	const files = new Map<string, string>()
	for (const [path, file] of await new Bun.Archive(archive).files()) files.set(path, await file.text())
	return files
}

/** A manifest past 1 MB: far beyond the ~32 KB a Zerops service variable holds. */
const largeManifest: ProxyManifest = {
	apps: Array.from({ length: 220 }, (_, index) => ({
		id: `app${index}@prod`,
		hosts: [`app${index}.example.test`],
		upstream: `app${index}:3000`,
		scheme: 'https',
		...contractProxyTable(notesArtifact),
	})),
}

describe('the platform proxy archive', () => {
	test('is the commit byte for byte plus the manifest, appended last', async () => {
		const committed = await committedArchive()
		const manifest = JSON.stringify(largeManifest)
		const archived = archiveWithDataFile(committed, { path: 'proxy.manifest.json', contents: manifest })

		// Every byte up to the commit's end-of-archive blocks is unchanged; only that zero padding gives way.
		const before = Bun.gunzipSync(committed)
		const after = Bun.gunzipSync(archived)
		let shared = 0
		while (shared < before.byteLength && before[shared] === after[shared]) shared++
		expect(shared % 512).toBe(0)
		expect(before.subarray(shared).every((byte) => byte === 0)).toBe(true)
		const files = await filesOf(archived)
		expect([...files.keys()]).toEqual(['zerops.yaml', 'proxy.manifest.json'])
		expect(new TextEncoder().encode(files.get('proxy.manifest.json') ?? '').byteLength).toBeGreaterThan(1024 * 1024)
		expect(files.get('proxy.manifest.json')).toBe(manifest)
	})

	test.each([
		{ name: 'a file', entry: 'proxy.manifest.json' },
		{ name: 'a directory', entry: 'proxy.manifest.json/inner' },
	])('refuses a commit that already holds the path as $name', async ({ entry }) => {
		const root = await scratch()
		await mkdir(join(root, 'tree', ...entry.split('/').slice(0, -1)), { recursive: true })
		await writeFile(join(root, 'tree', entry), '{"apps":[]}')
		const archive = new Uint8Array(await Bun.$`tar -czf - -C ${join(root, 'tree')} ${entry.split('/')[0] ?? entry}`.arrayBuffer())
		expect(() => archiveWithDataFile(archive, { path: 'proxy.manifest.json', contents: '{"apps":[]}' })).toThrow('already holds')
	})

	test('the generated proxy build reads the archived manifest and generates its Caddy config', async () => {
		const descriptor = renderYaml(fabrikaZeropsYaml)
		expect(zeropsProxyManifestCarrier(descriptor)).toBe('archive')
		// A namespace pinned to this source may be sent the installation's client logo (ADR-0066).
		expect(zeropsProxyAcceptsBrand(descriptor)).toBe(true)
		const proxy = fabrikaZeropsYaml.zerops.find((setup) => setup.setup === 'proxy')
		const generate = proxy?.build?.buildCommands?.find((command) => command.includes('generate-config.ts'))
		if (generate === undefined) throw new Error('the proxy build generates no Caddy config')

		// The build directory is the unpacked archive; the repository's packages stand in for the commit's.
		const build = await scratch()
		const manifest = JSON.stringify(largeManifest)
		const archived = archiveWithDataFile(await committedArchive(), { path: 'proxy.manifest.json', contents: manifest })
		for (const [path, contents] of await filesOf(archived)) await writeFile(join(build, path), contents)
		await symlink(join(REPO_ROOT, 'packages'), join(build, 'packages'))
		await symlink(join(REPO_ROOT, 'node_modules'), join(build, 'node_modules'))

		const run = Bun.spawnSync(['sh', '-c', generate], { cwd: build, stdout: 'pipe', stderr: 'pipe' })
		expect(run.exitCode).toBe(0)
		const caddy: unknown = await Bun.file(join(build, 'caddy.json')).json()
		expect(JSON.stringify(caddy)).toContain('app219.example.test')
	})
})
