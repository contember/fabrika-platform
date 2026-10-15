import { describe, expect, test } from 'bun:test'
import { archiveCommitSource } from '../commit-archive'
import { GitHubMetadataClient } from '../metadata'
import { TarballRepositorySource } from '../repository'
import { DESCRIPTOR, descriptor, file, handCommitSha, handPrefix, handTarball } from './fixtures'

const CODELOAD = 'https://codeload.github.com/contember/fixture/legacy.tar.gz/aaaaaaa'

/** A commit with a contract, two migrations and a file the snapshot does not want, served as one archive. */
function commitSource(requests: string[]) {
	const tarball = Bun.gzipSync(handTarball([
		file(`${handPrefix}zerops.yaml`, descriptor),
		file(`${handPrefix}fabrika.contract.ts`, 'export const contract = 1\n'),
		file(`${handPrefix}db/migrations/0001.sql`, 'create table notes ();\n'),
		file(`${handPrefix}db/migrations/0002.sql`, 'x'.repeat(2 * 1024 * 1024)),
		file(`${handPrefix}docs/guide.md`, '# guide\n'),
	]))
	const metadata = new GitHubMetadataClient({
		fetch: async (input) => {
			requests.push(String(input))
			return new Response('# guide, read alone\n')
		},
	})
	const source = new TarballRepositorySource({
		credentials: { repositoryToken: () => Promise.reject(new Error('no credential expected')), ownerConnectionToken: async () => undefined },
		descriptor: DESCRIPTOR,
		metadata,
		downloadFetch: async (url) => {
			requests.push(url)
			return url.startsWith('https://api.github.com/')
				? new Response(null, { status: 302, headers: { location: CODELOAD } })
				: new Response(tarball)
		},
	})
	return archiveCommitSource(source, metadata)
}

describe("a run's snapshot read from one archive pass", () => {
	test('serves every wanted file from the archive, with no rate-limited REST read', async () => {
		const requests: string[] = []
		const commit = await commitSource(requests).open({
			repoUrl: 'github.com/contember/fixture',
			commitSha: handCommitSha,
			wanted: (path) => path.endsWith('.ts') || path.startsWith('db/migrations/'),
			signal: new AbortController().signal,
		})

		expect([...commit.paths].sort()).toEqual([
			'db/migrations/0001.sql',
			'db/migrations/0002.sql',
			'docs/guide.md',
			'fabrika.contract.ts',
			'zerops.yaml',
		])
		expect(await commit.read('fabrika.contract.ts', 1024)).toBe('export const contract = 1\n')
		expect(await commit.read('db/migrations/0001.sql', 1024)).toBe('create table notes ();\n')
		expect(requests).toEqual([`https://api.github.com/repos/contember/fixture/tarball/${handCommitSha}`, CODELOAD])
	})

	test('refuses a wanted file above the read bound without fetching it, and reads an unwanted one alone', async () => {
		const requests: string[] = []
		const commit = await commitSource(requests).open({
			repoUrl: 'github.com/contember/fixture',
			commitSha: handCommitSha,
			wanted: (path) => path.startsWith('db/migrations/'),
			signal: new AbortController().signal,
		})

		await expect(commit.read('db/migrations/0002.sql', 1024 * 1024)).rejects.toMatchObject({ code: 'archive_rejected', stage: 'resolve' })
		expect(await commit.read('docs/guide.md', 1024)).toBe('# guide, read alone\n')
		expect(requests.slice(2)).toEqual([`https://api.github.com/repos/contember/fixture/contents/docs/guide.md?ref=${handCommitSha}`])
	})

	test('refuses an archive that names another commit', async () => {
		const requests: string[] = []
		await expect(
			commitSource(requests).open({
				repoUrl: 'github.com/contember/fixture',
				commitSha: 'b'.repeat(40),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'commit_mismatch', stage: 'resolve' })
	})
})
