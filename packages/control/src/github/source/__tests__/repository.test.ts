import { afterEach, describe, expect, test } from 'bun:test'
import type { GitHubSourceCredentialRequest, GitHubSourceCredentials } from '../../connections/credentials'
import { SourceFailure, SourceRateLimited } from '../failure'
import {
	codeloadUrl,
	descriptor,
	descriptorSha256,
	file,
	gitFixture,
	handCommitSha,
	handPrefix,
	handSource,
	handTarball,
	link,
	removeFixtureRoots,
	repository,
	runArchive,
	sourceFor,
} from './fixtures'

afterEach(removeFixtureRoots)

describe('the GitHub tarball repository', () => {
	test('resolves a ref to the commit its archive names and checks the descriptor digest, with no rate-limited REST read', async () => {
		const fixture = await gitFixture()
		const metadata: string[] = []
		const downloads: string[] = []
		const source = sourceFor(fixture, {
			onMetadataRequest: (url) => metadata.push(url),
			onDownloadAuthorization: (url) => downloads.push(url),
		})
		expect(
			await source.resolve({
				repository,
				requestedRef: 'refs/heads/main',
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		).toEqual({ commitSha: fixture.commitSha, descriptorSha256 })
		expect(metadata).toEqual([])
		expect(downloads).toEqual(['https://api.github.com/repos/contember/fixture/tarball/refs%2Fheads%2Fmain', codeloadUrl])
	})

	test('an exact commit is resolved once per process for one descriptor digest', async () => {
		const fixture = await gitFixture()
		let downloads = 0
		const source = sourceFor(fixture, { onDownload: () => downloads++ })
		const resolve = () => source.resolve({ repository, requestedRef: fixture.commitSha, descriptorSha256, signal: new AbortController().signal })

		expect(await resolve()).toEqual({ commitSha: fixture.commitSha, descriptorSha256 })
		expect(await resolve()).toEqual({ commitSha: fixture.commitSha, descriptorSha256 })
		expect(downloads).toBe(1)
		await expect(source.resolve({ repository, requestedRef: 'main', descriptorSha256, signal: new AbortController().signal })).resolves
			.toMatchObject({ commitSha: fixture.commitSha })
		expect(downloads).toBe(2)
	})

	test('reads a commit once: every regular file, the wanted ones kept, an oversized one only named', async () => {
		const source = handSource(handTarball([
			file(`${handPrefix}zerops.yaml`, descriptor),
			file(`${handPrefix}fabrika.contract.ts`, 'export const contract = 1\n'),
			file(`${handPrefix}db/migrations/0001.sql`, 'create table notes ();\n'),
			file(`${handPrefix}db/migrations/0002.sql`, 'x'.repeat(64)),
			file(`${handPrefix}README.md`, 'not wanted'),
			link('AGENTS.md', 'README.md'),
		]))

		const summary = await source.read({
			repository,
			ref: handCommitSha,
			expectedCommitSha: handCommitSha,
			collect: { keep: (path) => path !== 'README.md', maxFileBytes: 32, maxBytes: 1024 },
			signal: new AbortController().signal,
		})

		expect(summary.commitSha).toBe(handCommitSha)
		expect([...(summary.files?.paths ?? [])].sort()).toEqual([
			'README.md',
			'db/migrations/0001.sql',
			'db/migrations/0002.sql',
			'fabrika.contract.ts',
			'zerops.yaml',
		])
		expect([...(summary.files?.contents.keys() ?? [])].sort()).toEqual(['db/migrations/0001.sql', 'fabrika.contract.ts', 'zerops.yaml'])
		expect(new TextDecoder().decode(summary.files?.contents.get('fabrika.contract.ts'))).toBe('export const contract = 1\n')
		expect([...(summary.files?.oversized ?? [])]).toEqual(['db/migrations/0002.sql'])
	})

	test('a tarball request GitHub refuses for its rate limit is a rate limit, not an internal failure', async () => {
		const fixture = await gitFixture()
		const source = sourceFor(fixture, {
			redirectResponse: () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792101600' } }),
		})

		const resolved = source.resolve({ repository, requestedRef: 'main', descriptorSha256, signal: new AbortController().signal })

		await expect(resolved).rejects.toBeInstanceOf(SourceRateLimited)
		await expect(resolved).rejects.toMatchObject({
			code: 'rate_limited',
			stage: 'resolve',
			message: 'GitHub rate limit for anonymous reads reached; resets at 2026-10-15T22:00:00.000Z; connect the GitHub App to avoid it',
		})
	})

	test('mints a repository-scoped token for the bound connection and sends it only to api.github.com', async () => {
		const fixture = await gitFixture()
		const token = 'ghs_private_repository'
		const requests: GitHubSourceCredentialRequest[] = []
		const metadataAuthorizations: Array<string | null> = []
		const downloadAuthorizations: Array<[string, string | null]> = []
		const credentials: GitHubSourceCredentials = {
			repositoryToken: async (input) => {
				requests.push(input)
				return token
			},
		}
		const source = sourceFor(fixture, {
			credentials,
			onMetadataAuthorization: (value) => metadataAuthorizations.push(value),
			onDownloadAuthorization: (url, value) => downloadAuthorizations.push([new URL(url).host, value]),
		})
		const signal = new AbortController().signal
		const privateBinding = { connectionId: 'connection-1', installationId: 42 }
		await source.resolve({ repository, requestedRef: 'main', privateBinding, descriptorSha256, signal })
		const archived = await runArchive(source, {
			repository,
			commitSha: fixture.commitSha,
			archive: { kind: 'application', privateBinding },
			descriptorSha256,
			signal,
		})

		expect(archived.summary?.commitSha).toBe(fixture.commitSha)
		expect(requests).toEqual([
			{ connectionId: 'connection-1', installationId: 42, repository, signal },
			{ connectionId: 'connection-1', installationId: 42, repository, signal },
		])
		expect(metadataAuthorizations).toEqual([])
		expect(downloadAuthorizations).toEqual([
			['api.github.com', `Bearer ${token}`],
			['codeload.github.com', null],
			['api.github.com', `Bearer ${token}`],
			['codeload.github.com', null],
		])
	})

	test('a public repository and every platform archive ask for no credential', async () => {
		const fixture = await gitFixture()
		let requests = 0
		const source = sourceFor(fixture, {
			credentials: {
				repositoryToken: async () => {
					requests++
					return 'unexpected'
				},
			},
		})
		const signal = new AbortController().signal
		await source.resolve({ repository, requestedRef: 'main', descriptorSha256, signal })
		expect((await runArchive(source, { repository, commitSha: fixture.commitSha, descriptorSha256, signal })).failure).toBeUndefined()
		expect(
			(await runArchive(source, { repository, commitSha: fixture.commitSha, descriptorSha256, archive: { kind: 'platform' }, signal })).failure,
		).toBeUndefined()
		expect(requests).toBe(0)
	})

	test('fails closed without fetching when the bound connection has no credential', async () => {
		const fixture = await gitFixture()
		let metadata = 0
		const source = sourceFor(fixture, {
			credentials: { repositoryToken: () => Promise.reject(new SourceFailure('installation_not_found', 'credentials')) },
			onMetadataRequest: () => metadata++,
		})
		await expect(source.resolve({
			repository,
			requestedRef: 'main',
			privateBinding: { connectionId: 'missing', installationId: 42 },
			descriptorSha256,
			signal: new AbortController().signal,
		})).rejects.toMatchObject({ code: 'installation_not_found' })
		expect(metadata).toBe(0)
	})

	test('rejects a resolved commit that is not the expected one', async () => {
		const fixture = await gitFixture()
		await expect(
			sourceFor(fixture).resolve({
				repository,
				requestedRef: 'main',
				expectedCommitSha: 'b'.repeat(40),
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'commit_mismatch', stage: 'resolve' })
	})

	test.each([
		{ name: 'a missing descriptor', descriptorFile: [], expected: { code: 'descriptor_missing' } },
		{
			name: 'a drifted descriptor digest',
			descriptorFile: [file(`${handPrefix}zerops.yaml`, 'zerops: drifted\n')],
			expected: { code: 'descriptor_mismatch' },
		},
	])('resolution rejects $name', async ({ descriptorFile, expected }) => {
		const source = handSource(handTarball([...descriptorFile, file(`${handPrefix}README.md`, 'readme')]))
		await expect(
			source.resolve({ repository, requestedRef: 'main', descriptorSha256, signal: new AbortController().signal }),
		).rejects.toMatchObject({ ...expected, stage: 'resolve' })
	})

	test.each([
		'https://attacker.test/contember/fixture/tar.gz/main',
		'http://codeload.github.com/contember/fixture/tar.gz/main',
		'https://codeload.github.com:8443/contember/fixture/tar.gz/main',
		'https://user@codeload.github.com/contember/fixture/tar.gz/main',
		'/contember/fixture/tar.gz/main',
	])('refuses redirect target %s without naming it', async (location) => {
		const fixture = await gitFixture()
		let downloads = 0
		const source = sourceFor(fixture, { location, onDownload: () => downloads++ })
		const raised = await source
			.archive({ repository, commitSha: fixture.commitSha, descriptorSha256, archive: { kind: 'application' }, signal: new AbortController().signal })
			.then(() => undefined, (error: unknown) => error)

		expect(raised).toMatchObject({ code: 'archive_rejected', stage: 'archive' })
		expect(JSON.stringify(raised)).not.toContain('attacker')
		expect(downloads).toBe(0)
	})

	test('maps an unknown commit to ref_not_found', async () => {
		const fixture = await gitFixture()
		const source = sourceFor(fixture, { redirectResponse: () => new Response(null, { status: 404 }) })
		await expect(
			source.archive({
				repository,
				commitSha: fixture.commitSha,
				descriptorSha256,
				archive: { kind: 'application' },
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'ref_not_found', stage: 'archive' })
	})

	test('rejects a commit sha that is not an object id before any request', async () => {
		const fixture = await gitFixture()
		let downloads = 0
		const source = sourceFor(fixture, { onDownload: () => downloads++ })
		await expect(
			source.archive({ repository, commitSha: 'main', descriptorSha256, archive: { kind: 'application' }, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: 'commit_mismatch', stage: 'archive' })
		expect(downloads).toBe(0)
	})

	test('rejects a descriptor digest that is not a SHA-256 hex value', async () => {
		await expect(
			handSource(handTarball([file(`${handPrefix}zerops.yaml`, descriptor)])).archive({
				repository,
				commitSha: handCommitSha,
				descriptorSha256: 'not-a-digest',
				archive: { kind: 'application' },
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'descriptor_mismatch', stage: 'archive' })
	})
})
