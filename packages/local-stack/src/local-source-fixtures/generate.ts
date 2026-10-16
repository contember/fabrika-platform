import { GENERATED_ENTRY_FILE, generatedEntry } from '@fabrika/app/build'
import { createZeropsArtifactSourceDescriptor } from '@fabrika/provider-zerops'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LocalSourceFixture, type LocalSourceFixtureKind, localSourceFixtureSchema } from '../local-source-contract'

export const fixtureInputs = fileURLToPath(new URL('../../fixtures/source/', import.meta.url))

/** The application fixture is the Notes example itself, so the contract Control approves is the one the container serves. */
export const applicationFixtureRoot = fileURLToPath(new URL('../../../../examples/zerops-app/', import.meta.url))

/** What the example's `.gitignore` keeps out of its repository; the generated entry is added as the build writes it. */
const UNCOMMITTED = new Set(['node_modules', 'fabrika', 'dist', '.env', 'fabrika.manifest.json'])

/**
 * The complete application commit: every file of the example an author pushes, and the entrypoint the platform build
 * writes, so the archive is what a production build checks and what the composed container runs. The tree is pinned in
 * `fixtures/source/manifest.json`; an edit to any of these files moves it (`bun run fixtures:pin`).
 */
export async function applicationFixtureSource(root: string = applicationFixtureRoot): Promise<ReadonlyMap<string, Uint8Array<ArrayBuffer>>> {
	const files = new Map<string, Uint8Array<ArrayBuffer>>()
	const visit = async (directory: string): Promise<void> => {
		for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : 1)) {
			const path = directory === '' ? entry.name : `${directory}/${entry.name}`
			if (UNCOMMITTED.has(path) || entry.name.endsWith('.local')) continue
			if (entry.isDirectory()) await visit(path)
			else if (entry.isFile()) files.set(path, new Uint8Array(await readFile(join(root, path))))
			else throw new Error(`the application fixture holds no ${path}: only regular files are committed`)
		}
	}
	await visit('')
	files.set(GENERATED_ENTRY_FILE, new TextEncoder().encode(generatedEntry('bun')))
	return files
}

export function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

// Deliberately omit the inherited environment: Git overrides, credentials and global config cannot enter a fixture.
const gitEnvironment = {
	PATH: '/usr/bin:/bin',
	HOME: '/nonexistent',
	XDG_CONFIG_HOME: '/nonexistent',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_ATTR_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'Fabrika Local Fixture',
	GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
	GIT_COMMITTER_NAME: 'Fabrika Local Fixture',
	GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
	GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
	LC_ALL: 'C',
	TZ: 'UTC',
}

async function git(directory: string, args: string[]): Promise<Uint8Array<ArrayBuffer>> {
	const child = Bun.spawn([
		'git',
		'-C',
		directory,
		'-c',
		'core.autocrlf=false',
		'-c',
		'core.attributesFile=/dev/null',
		'-c',
		'core.hooksPath=/dev/null',
		'-c',
		'commit.gpgSign=false',
		'-c',
		'tar.umask=0022',
		...args,
	], { env: gitEnvironment, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
	const [stdout, , code] = await Promise.all([
		new Response(child.stdout).bytes(),
		new Response(child.stderr).arrayBuffer(),
		child.exited,
	])
	if (code !== 0) throw new Error('local source fixture Git command failed')
	return stdout
}

async function platformFixtureSource(): Promise<ReadonlyMap<string, Uint8Array<ArrayBuffer>>> {
	const root = join(fixtureInputs, 'platform')
	return new Map(
		await Promise.all(
			['marker.txt', 'zerops.yaml'].map(async (
				file,
			): Promise<[string, Uint8Array<ArrayBuffer>]> => [file, new Uint8Array(await readFile(join(root, file)))]),
		),
	)
}

/** The agent's change to Notes as a patch on the application fixture, written under the fabrika-app skill. */
export const agentChangePatch = join(fixtureInputs, 'notes-agent-change.patch')

const FIXTURE_MESSAGES: Readonly<Record<LocalSourceFixtureKind, string>> = {
	platform: 'Fabrika local platform source fixture v1',
	application: 'Fabrika local application source fixture v1',
	agentChange: 'Rename a note, and give notes a label table',
}

/**
 * One fixture repository and its archive. The agent change commits the application fixture first, so its parent is
 * exactly the pinned application commit, then applies the patch as the agent's commit.
 */
export async function generateFixture(directory: string, kind: LocalSourceFixtureKind): Promise<{
	fixture: LocalSourceFixture
	archive: Uint8Array<ArrayBuffer>
	/** Every regular file of the commit by path. */
	files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>
}> {
	await mkdir(directory)
	await git(directory, ['init', '--quiet', '--object-format=sha1', '--initial-branch=main', '--template='])
	const source = kind === 'platform' ? await platformFixtureSource() : await applicationFixtureSource()
	const files = [...source.keys()]
	for (const [file, bytes] of source) {
		await mkdir(dirname(join(directory, file)), { recursive: true })
		await writeFile(join(directory, file), bytes, { mode: 0o644 })
	}
	if (kind === 'platform') {
		const target = (await readFile(join(fixtureInputs, kind, 'marker-link.target'), 'utf8')).trim()
		if (target !== 'marker.txt') throw new Error('invalid local source fixture symlink target')
		await symlink(target, join(directory, 'marker-link'))
		files.push('marker-link')
	}
	// Forced: the example's own .gitignore names the generated entry, which this commit carries as the build writes it.
	await git(directory, ['add', '--force', '--', ...files])
	await git(directory, ['update-index', '--chmod=-x', '--', ...files.filter((file) => file !== 'marker-link')])
	await git(directory, ['commit', '--quiet', '--no-gpg-sign', '-m', FIXTURE_MESSAGES[kind === 'agentChange' ? 'application' : kind]])
	if (kind === 'agentChange') {
		await git(directory, ['apply', '--index', '--whitespace=nowarn', '--', agentChangePatch])
		await git(directory, ['commit', '--quiet', '--no-gpg-sign', '-m', FIXTURE_MESSAGES[kind]])
	}
	const text = async (args: string[]) => new TextDecoder().decode(await git(directory, args))
	const commitSha = (await text(['rev-parse', 'HEAD'])).trim()
	const treeSha = (await text(['rev-parse', `${commitSha}^{tree}`])).trim()
	const tree = (await text(['ls-tree', '-r', '-t', '-z', commitSha])).split('\0').filter(Boolean).map(line => {
		const [, mode, type, sha, path] = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line) ?? []
		if (!mode || !type || !sha || !path) throw new Error('invalid local source fixture tree')
		return { mode, type, sha, path }
	})
	const committed = new Map<string, Uint8Array<ArrayBuffer>>()
	for (const entry of tree) {
		if (entry.type === 'blob' && entry.mode !== '120000') committed.set(entry.path, new Uint8Array(await readFile(join(directory, entry.path))))
	}
	const descriptorContents = await text(['show', `${commitSha}:zerops.yaml`])
	const descriptor = await createZeropsArtifactSourceDescriptor(descriptorContents)
	const tar = await git(directory, ['archive', '--format=tar', `--prefix=fabrika-local-${archivePrefix(kind)}-${commitSha}/`, commitSha])
	const archive = Bun.gzipSync(tar)
	// The gzip header's OS byte is the compressing zlib's platform (3 on Linux, 19 on macOS), so the pinned archive hash
	// would hold on one platform only. Stamp it Unix, as the pins were made, so every machine builds the same bytes.
	archive[9] = 3
	return {
		archive,
		files: committed,
		fixture: localSourceFixtureSchema.parse({
			commitSha,
			treeSha,
			tree,
			descriptorContents,
			descriptorSha256: descriptor.sha256,
			archiveBytes: archive.byteLength,
			archiveSha256: sha256(archive),
		}),
	}
}

const archivePrefix = (kind: LocalSourceFixtureKind): string => (kind === 'agentChange' ? 'application' : kind)
