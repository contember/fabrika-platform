import { createZeropsArtifactSourceDescriptor } from '@fabrika/provider-zerops'
import { createHash } from 'node:crypto'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type LocalSourceFixture, localSourceFixtureSchema } from '../local-source-contract'

export const fixtureInputs = fileURLToPath(new URL('../../fixtures/source/', import.meta.url))

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
	const files = ['marker.txt', 'zerops.yaml']
	for (const file of files) {
		await writeFile(join(directory, file), await readFile(join(fixtureInputs, kind, file)), { mode: 0o644 })
	}
	if (kind === 'platform') {
		const target = (await readFile(join(fixtureInputs, kind, 'marker-link.target'), 'utf8')).trim()
		if (target !== 'marker.txt') throw new Error('invalid local source fixture symlink target')
		await symlink(target, join(directory, 'marker-link'))
		files.push('marker-link')
	}
	await git(directory, ['add', '--', ...files])
	await git(directory, ['update-index', '--chmod=-x', '--', 'marker.txt', 'zerops.yaml'])
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
