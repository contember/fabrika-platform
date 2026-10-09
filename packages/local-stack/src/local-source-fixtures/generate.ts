import { createZeropsArtifactSourceDescriptor } from '@fabrika/provider-zerops'
import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LocalSourceFixture, localSourceFixtureSchema } from '../local-source-contract'

export const fixtureInputs = fileURLToPath(new URL('../../fixtures/source/', import.meta.url))

/** The application fixture is the Notes example itself, so the contract Control approves is the one the container serves. */
export const applicationFixtureRoot = fileURLToPath(new URL('../../../../examples/zerops-app/', import.meta.url))

/**
 * The example's files a deploy reads at its commit: the descriptor, and what the static contract reader and the
 * snapshot's migration list need. The tree is pinned in `fixtures/source/manifest.json`, so an edit to one of these
 * files moves the pin.
 */
export const APPLICATION_FIXTURE_FILES = [
	'zerops.yaml',
	'package.json',
	'tsconfig.json',
	'fabrika.contract.ts',
	'src/db/tables.ts',
	'src/db/schema.generated.ts',
	'db/migrations/20261009140000_notes.sql',
] as const

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

export async function generateFixture(directory: string, kind: 'platform' | 'application'): Promise<{
	fixture: LocalSourceFixture
	archive: Uint8Array<ArrayBuffer>
}> {
	await mkdir(directory)
	await git(directory, ['init', '--quiet', '--object-format=sha1', '--initial-branch=main', '--template='])
	const root = kind === 'platform' ? join(fixtureInputs, kind) : applicationFixtureRoot
	const files: string[] = kind === 'platform' ? ['marker.txt', 'zerops.yaml'] : [...APPLICATION_FIXTURE_FILES]
	for (const file of files) {
		await mkdir(dirname(join(directory, file)), { recursive: true })
		await writeFile(join(directory, file), await readFile(join(root, file)), { mode: 0o644 })
	}
	if (kind === 'platform') {
		const target = (await readFile(join(fixtureInputs, kind, 'marker-link.target'), 'utf8')).trim()
		if (target !== 'marker.txt') throw new Error('invalid local source fixture symlink target')
		await symlink(target, join(directory, 'marker-link'))
		files.push('marker-link')
	}
	await git(directory, ['add', '--', ...files])
	await git(directory, ['update-index', '--chmod=-x', '--', ...files.filter((file) => file !== 'marker-link')])
	await git(directory, ['commit', '--quiet', '--no-gpg-sign', '-m', `Fabrika local ${kind} source fixture v1`])
	const text = async (args: string[]) => new TextDecoder().decode(await git(directory, args))
	const commitSha = (await text(['rev-parse', 'HEAD'])).trim()
	const treeSha = (await text(['rev-parse', `${commitSha}^{tree}`])).trim()
	const tree = (await text(['ls-tree', '-r', '-t', '-z', commitSha])).split('\0').filter(Boolean).map(line => {
		const [, mode, type, sha, path] = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line) ?? []
		if (!mode || !type || !sha || !path) throw new Error('invalid local source fixture tree')
		return { mode, type, sha, path }
	})
	const descriptorContents = await text(['show', `${commitSha}:zerops.yaml`])
	const descriptor = await createZeropsArtifactSourceDescriptor(descriptorContents)
	const tar = await git(directory, ['archive', '--format=tar', `--prefix=fabrika-local-${kind}-${commitSha}/`, commitSha])
	const archive = Bun.gzipSync(tar)
	return {
		archive,
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
