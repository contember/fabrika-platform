import { afterEach, describe, expect, test } from 'bun:test'
import type { GitHubSourceCredentialRequest, GitHubSourceCredentials } from '../credentials'
import { SourceFailure } from '../failure'
import {
	descriptor,
	descriptorSha256,
	file,
	gitFixture,
	handCommitSha,
	handPrefix,
	handSource,
	handTarball,
	removeFixtureRoots,
	repository,
	runArchive,
	sourceFor,
} from './fixtures'

afterEach(removeFixtureRoots)

describe('the GitHub tarball repository', () => {
	test('resolves an exact commit and the registered descriptor digest through two bounded REST reads', async () => {
		const fixture = await gitFixture()
		const requests: string[] = []
		const source = sourceFor(fixture, { onMetadataRequest: (url) => requests.push(url) })
		expect(
			await source.resolve({
				repository,
				requestedRef: 'main',
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		).toEqual({ commitSha: fixture.commitSha, descriptorSha256 })
		expect(requests).toEqual([
			'https://api.github.com/repos/contember/fixture/commits/main',
			`https://api.github.com/repos/contember/fixture/contents/zerops.yaml?ref=${fixture.commitSha}`,
		])
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
		await source.resolve({ repository, requestedRef: fixture.commitSha, privateBinding, descriptorSha256, signal })
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
		expect(metadataAuthorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`])
		expect(downloadAuthorizations).toEqual([['api.github.com', `Bearer ${token}`], ['codeload.github.com', null]])
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
		{ name: 'a missing descriptor', descriptorStatus: 404, expected: { code: 'descriptor_missing' } },
		{ name: 'a drifted descriptor digest', descriptorStatus: 200, expected: { code: 'descriptor_mismatch' } },
	])('rejects $name before any archive byte is read', async ({ descriptorStatus, expected }) => {
		const fixture = await gitFixture()
		let downloads = 0
		const source = sourceFor(fixture, {
			descriptorResponse: () => descriptorStatus === 404 ? new Response(null, { status: 404 }) : new Response('zerops: drifted\n'),
			onDownload: () => downloads++,
		})
		await expect(
			source.resolve({ repository, requestedRef: 'main', descriptorSha256, signal: new AbortController().signal }),
		).rejects.toMatchObject({ ...expected, stage: 'resolve' })
		expect(downloads).toBe(0)
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
