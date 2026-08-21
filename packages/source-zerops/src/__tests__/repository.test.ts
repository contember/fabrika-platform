import { buildZeropsSourceUploadRequest } from '@fabrika/provider-zerops'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceGitHubClient, SourceGitHubConnection } from '../github-connection'
import { GitHubMetadataClient } from '../github-metadata'
import { type RepositoryArchive, type SourceDownloadFetch, TarballRepositorySource } from '../repository'
import { ZeropsSourceService } from '../service'
import { createTarRewrite, SOURCE_MAX_EXPANDED_BYTES, SOURCE_MAX_TREE_ENTRIES, type SourceBytes } from '../tar'

const descriptor = 'zerops:\n  - setup: app\n'
const descriptorSha256 = createHash('sha256').update(descriptor).digest('hex')
const repository = { owner: 'contember', name: 'fixture' }
const codeloadUrl = 'https://codeload.github.com/contember/fixture/tar.gz/refs/heads/main?token=must-not-leak'
const uploadUrl = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=private'
const handCommitSha = 'a'.repeat(40)
const handPrefix = 'contember-fixture-aaaaaaa/'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Zerops source resolve', () => {
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

	test('mints one repository-scoped token for the named connection and sends it only to api.github.com', async () => {
		const fixture = await gitFixture()
		const token = 'ghs_private_repository'
		const mintCalls: unknown[] = []
		const metadataAuthorizations: Array<string | null> = []
		const downloadAuthorizations: Array<[string, string | null]> = []
		const client: SourceGitHubClient = {
			getAuthenticatedApp: async () => {
				throw new Error('identity not expected')
			},
			resolveInstallationId: async () => {
				throw new Error('installation lookup not expected')
			},
			mintRepositoryToken: async (input) => {
				mintCalls.push(input)
				return { token, expiresAt: Date.now() + 60_000 }
			},
		}
		let snapshots = 0
		const github: SourceGitHubConnection = {
			snapshotV2: (connectionId) => {
				snapshots++
				return connectionId === 'connection-1' ? { client, appId: '123', credentialSha256: 'a'.repeat(64) } : undefined
			},
			activateV2: async () => {
				throw new Error('activation not expected')
			},
			statusV2: async () => {
				throw new Error('status not expected')
			},
		}
		const source = sourceFor(fixture, {
			github,
			onMetadataAuthorization: (value) => metadataAuthorizations.push(value),
			onDownloadAuthorization: (url, value) => downloadAuthorizations.push([new URL(url).host, value]),
		})
		const signal = new AbortController().signal
		const privateBinding = { connectionId: 'connection-1', installationId: 42 }
		await source.resolve({ repository, requestedRef: fixture.commitSha, privateBinding, descriptorSha256, signal })
		const archived = await runArchive(source, { repository, commitSha: fixture.commitSha, privateBinding, descriptorSha256, signal })

		expect(archived.summary?.commitSha).toBe(fixture.commitSha)
		expect(mintCalls).toEqual([
			{ installationId: 42, owner: 'contember', repository: 'fixture', signal },
			{ installationId: 42, owner: 'contember', repository: 'fixture', signal },
		])
		expect(metadataAuthorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`])
		expect(downloadAuthorizations).toEqual([['api.github.com', `Bearer ${token}`], ['codeload.github.com', null]])
		expect(snapshots).toBe(2)
	})

	test('refuses an unkeyed request that names an installation, because it names no credential', async () => {
		// Since ADR-0039 only a keyed private binding selects a credential; a bare installation id
		// cannot, so the request fails closed instead of falling through to an anonymous fetch.
		const fixture = await gitFixture()
		const github: SourceGitHubConnection = {
			snapshotV2: () => undefined,
			activateV2: async () => {
				throw new Error('activation not expected')
			},
			statusV2: async () => {
				throw new Error('status not expected')
			},
		}
		await expect(
			sourceFor(fixture, { github }).resolve({
				repository,
				requestedRef: 'main',
				githubInstallationId: 42,
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'installation_not_found', status: 404 })
	})

	test('routes concurrent v2 private reads to the exact keyed client', async () => {
		const fixture = await gitFixture()
		const mintCalls: Array<{ connectionId: string; installationId: number }> = []
		const clientFor = (connectionId: string): SourceGitHubClient => ({
			getAuthenticatedApp: async () => {
				throw new Error('identity not expected')
			},
			resolveInstallationId: async () => {
				throw new Error('installation lookup not expected')
			},
			mintRepositoryToken: async (input) => {
				mintCalls.push({ connectionId, installationId: input.installationId })
				return { token: `token-${connectionId}`, expiresAt: Date.now() + 60_000 }
			},
		})
		const clients = new Map([
			['connection-1', clientFor('connection-1')],
			['connection-2', clientFor('connection-2')],
		])
		const github: SourceGitHubConnection = {
			snapshotV2: (connectionId) => {
				const selected = clients.get(connectionId)
				return selected === undefined ? undefined : { client: selected, appId: '123', credentialSha256: 'a'.repeat(64) }
			},
			activateV2: async () => {
				throw new Error('activation not expected')
			},
			statusV2: async () => {
				throw new Error('status not expected')
			},
		}
		const source = sourceFor(fixture, { github })
		const signal = new AbortController().signal
		await Promise.all([
			source.resolve({
				repository,
				requestedRef: 'main',
				privateBinding: { connectionId: 'connection-1', installationId: 41 },
				descriptorSha256,
				signal,
			}),
			source.resolve({
				repository,
				requestedRef: 'main',
				privateBinding: { connectionId: 'connection-2', installationId: 42 },
				descriptorSha256,
				signal,
			}),
			runArchive(source, {
				repository,
				commitSha: fixture.commitSha,
				privateBinding: { connectionId: 'connection-1', installationId: 41 },
				descriptorSha256,
				signal,
			}),
			runArchive(source, {
				repository,
				commitSha: fixture.commitSha,
				privateBinding: { connectionId: 'connection-2', installationId: 42 },
				descriptorSha256,
				signal,
			}),
		])
		expect(mintCalls).toContainEqual({ connectionId: 'connection-1', installationId: 41 })
		expect(mintCalls).toContainEqual({ connectionId: 'connection-2', installationId: 42 })
		expect(mintCalls).toHaveLength(4)
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
		).rejects.toMatchObject({ code: 'commit_mismatch', stage: 'resolve', status: 409 })
	})

	test.each([
		{ name: 'a missing descriptor', descriptorStatus: 404, expected: { code: 'descriptor_missing', status: 422 } },
		{ name: 'a drifted descriptor digest', descriptorStatus: 200, expected: { code: 'descriptor_mismatch', status: 409 } },
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

	test('requires GitHub App configuration when an installation id is supplied', async () => {
		await expect(
			new TarballRepositorySource({}).resolve({
				repository: { owner: 'contember', name: 'private' },
				requestedRef: 'main',
				githubInstallationId: 42,
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'installation_not_found', stage: 'resolve' })
	})
})

describe('Zerops source archive', () => {
	test('streams the tarball into an archive of regular files with fixed modes, each parent directory written once before its first file', async () => {
		const fixture = await gitFixture()
		const archived = await runArchive(sourceFor(fixture), {
			repository,
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(archived.failure).toBeUndefined()
		expect(archived.summary).toEqual({
			commitSha: fixture.commitSha,
			descriptorSha256,
			entryCount: 3,
			expandedBytes: entries(archived).reduce((total, entry) => total + entry.content.byteLength, 0),
		})
		// The Zerops unpacker creates no directory it was not told about, so `bin/` precedes `bin/run`.
		expect(entries(archived).map((entry) => [entry.path, entry.mode, entry.type])).toEqual([
			['.gitattributes', 0o644, '0'],
			['bin/', 0o755, '5'],
			['bin/run', 0o755, '0'],
			['zerops.yaml', 0o644, '0'],
		])
		expect(text(archived, 'zerops.yaml')).toBe(descriptor)
	})

	test('writes nested parent directories outermost first and never twice', async () => {
		const tarball = handTarball([
			file(`${handPrefix}src/app/a.ts`, 'a'),
			file(`${handPrefix}src/app/b.ts`, 'b'),
			file(`${handPrefix}src/lib/c.ts`, 'c'),
			file(`${handPrefix}zerops.yaml`, descriptor),
		])
		const archived = await runArchive(handSource(tarball), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(archived.failure).toBeUndefined()
		expect(archived.summary?.entryCount).toBe(4)
		expect(entries(archived).map((entry) => [entry.path, entry.type])).toEqual([
			['src/', '5'],
			['src/app/', '5'],
			['src/app/a.ts', '0'],
			['src/app/b.ts', '0'],
			['src/lib/', '5'],
			['src/lib/c.ts', '0'],
			['zerops.yaml', '0'],
		])
	})

	test('rejects a repository whose tarball carries a symlink', async () => {
		const fixture = await gitFixture({ symlink: true })
		const archived = await runArchive(sourceFor(fixture), {
			repository,
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(archived.failure).toMatchObject({ code: 'archive_rejected', stage: 'archive', status: 422 })
	})

	test('honours export-ignore and export-subst because the tarball is git archive', async () => {
		const fixture = await gitFixture({ exportIgnored: true })
		const archived = await runArchive(sourceFor(fixture), {
			repository,
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(entries(archived).map((entry) => entry.path)).not.toContain('secrets/local.env')
		expect(text(archived, 'bin/run')).toContain(fixture.commitSha)
		expect(text(archived, 'bin/run')).not.toContain('$Format')
	})

	test('carries a long path through its own pax header', async () => {
		const longPath = `${'nested-'.repeat(15)}directory/child/file.txt`
		const fixture = await gitFixture({ longPath })
		const archived = await runArchive(sourceFor(fixture), {
			repository,
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(entries(archived).map((entry) => entry.path)).toContain(longPath)
		expect(text(archived, longPath)).toBe('long path contents')
		const directory = entries(archived).find((entry) => entry.path === `${'nested-'.repeat(15)}directory/`)
		expect(directory?.type).toBe('5')
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
			.archive({ repository, commitSha: fixture.commitSha, descriptorSha256, signal: new AbortController().signal })
			.then(() => undefined, (error: unknown) => error)

		expect(raised).toMatchObject({ code: 'archive_rejected', stage: 'archive', status: 422 })
		expect(JSON.stringify(raised)).not.toContain('attacker')
		expect(downloads).toBe(0)
	})

	test('maps an unknown commit to ref_not_found', async () => {
		const fixture = await gitFixture()
		const source = sourceFor(fixture, { redirectResponse: () => new Response(null, { status: 404 }) })
		await expect(
			source.archive({ repository, commitSha: fixture.commitSha, descriptorSha256, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: 'ref_not_found', stage: 'archive', status: 404 })
	})

	test('rejects a commit sha that is not an object id before any request', async () => {
		const fixture = await gitFixture()
		let downloads = 0
		const source = sourceFor(fixture, { onDownload: () => downloads++ })
		await expect(
			source.archive({ repository, commitSha: 'main', descriptorSha256, signal: new AbortController().signal }),
		).rejects.toMatchObject({ code: 'commit_mismatch', stage: 'archive', status: 409 })
		expect(downloads).toBe(0)
	})

	test.each([
		{ name: 'a symlink', tarball: () => handTarball([entry({ name: `${handPrefix}link`, type: '2', linkname: 'zerops.yaml' })]) },
		{ name: 'a hard link', tarball: () => handTarball([entry({ name: `${handPrefix}link`, type: '1', linkname: 'zerops.yaml' })]) },
		{ name: 'a character device', tarball: () => handTarball([entry({ name: `${handPrefix}dev`, type: '3' })]) },
		{ name: 'a GNU long-name entry', tarball: () => handTarball([entry({ name: `${handPrefix}long`, type: 'L', content: bytes('x') })]) },
		{ name: 'a submodule marker', tarball: () => handTarball([file(`${handPrefix}.gitmodules`, '[submodule "x"]\n')]) },
		{ name: 'a second path prefix', tarball: () => handTarball([file(`${handPrefix}zerops.yaml`, descriptor), file('other-repo-aaaaaaa/extra', 'x')]) },
		{ name: 'a traversing path', tarball: () => handTarball([file(`${handPrefix}../escape`, 'x')]) },
		{
			name: 'an absolute path',
			tarball: () => handTarball([paxed('path=/absolute\n', entry({ name: `${handPrefix}placeholder`, content: bytes('x') }))]),
		},
		{ name: 'a duplicate path', tarball: () => handTarball([file(`${handPrefix}same`, 'x'), file(`${handPrefix}same`, 'y')]) },
		{ name: 'a pax linkpath record', tarball: () => handTarball([paxed(`linkpath=elsewhere\n`, file(`${handPrefix}zerops.yaml`, descriptor))]) },
		{
			name: 'an oversized pax record',
			tarball: () => handTarball([paxed(`path=${handPrefix}${'x'.repeat(70 * 1024)}\n`, entry({ name: `${handPrefix}placeholder` }))]),
		},
		{
			name: 'a truncated entry',
			tarball: () => concat(globalHeader(handCommitSha), entry({ name: `${handPrefix}zerops.yaml`, size: 4096 }), bytes('short')),
		},
		{ name: 'a missing end-of-archive', tarball: () => concat(globalHeader(handCommitSha), file(`${handPrefix}zerops.yaml`, descriptor)) },
		{ name: 'a missing pax global header', tarball: () => concat(file(`${handPrefix}zerops.yaml`, descriptor), new Uint8Array(1024)) },
		{ name: 'a corrupt header checksum', tarball: () => handTarball([corrupt(file(`${handPrefix}zerops.yaml`, descriptor))]) },
	])('rejects $name', async ({ tarball }) => {
		const archived = await runArchive(handSource(tarball()), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(archived.collected.ok).toBe(false)
		expect(archived.failure).toMatchObject({ stage: 'archive', retryable: false })
		expect(archived.failure).toBeInstanceOf(Error)
	})

	test('rejects a tarball that names a different commit', async () => {
		const archived = await runArchive(handSource(handTarball([file(`${handPrefix}zerops.yaml`, descriptor)], { commitSha: 'c'.repeat(40) })), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(archived.failure).toMatchObject({ code: 'commit_mismatch', stage: 'archive', status: 409 })
	})

	test.each([
		{
			name: 'entry count',
			tarball: () => handTarball(Array.from({ length: SOURCE_MAX_TREE_ENTRIES + 1 }, (_value, index) => entry({ name: `${handPrefix}file-${index}` }))),
		},
		{
			name: 'expanded bytes',
			tarball: () => concat(globalHeader(handCommitSha), entry({ name: `${handPrefix}huge`, size: SOURCE_MAX_EXPANDED_BYTES + 1 })),
		},
	])('refuses a repository over the $name limit while streaming', async ({ tarball }) => {
		const archived = await runArchive(handSource(tarball()), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(archived.failure).toMatchObject({ code: 'archive_rejected', stage: 'archive', status: 413 })
	})

	test.each([
		{ name: 'drifted', entries: [file(`${handPrefix}zerops.yaml`, 'zerops: drifted\n')], expected: { code: 'descriptor_mismatch', status: 409 } },
		{ name: 'missing', entries: [file(`${handPrefix}other.yaml`, descriptor)], expected: { code: 'descriptor_missing', status: 422 } },
		{ name: 'nested only', entries: [file(`${handPrefix}nested/zerops.yaml`, descriptor)], expected: { code: 'descriptor_missing', status: 422 } },
		{
			name: 'oversized',
			entries: [entry({ name: `${handPrefix}zerops.yaml`, size: 512 * 1024 })],
			expected: { code: 'archive_rejected', status: 422 },
		},
	])('rejects a $name root descriptor', async ({ entries: parts, expected }) => {
		const archived = await runArchive(handSource(handTarball(parts)), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(archived.failure).toMatchObject({ ...expected, stage: 'archive' })
	})

	test('rejects a descriptor digest that is not a SHA-256 hex value', async () => {
		await expect(
			handSource(handTarball([file(`${handPrefix}zerops.yaml`, descriptor)])).archive({
				repository,
				commitSha: handCommitSha,
				descriptorSha256: 'not-a-digest',
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'descriptor_mismatch', stage: 'archive', status: 409 })
	})

	test('hands the destination gzip(tar) of exactly the rewritten archive', async () => {
		const fixture = await gitFixture({ longPath: 'deeply/nested/but/quite/short.txt' })
		let uploaded = new Uint8Array()
		const service = new ZeropsSourceService({
			rpcKey: 'source-rpc-key-that-is-at-least-32-characters',
			repository: sourceFor(fixture),
			uploadFetch: async (destination, init) => {
				expect(destination).toBe(uploadUrl)
				expect(init.method).toBe('PUT')
				expect(init.duplex).toBe('half')
				expect(init.redirect).toBe('error')
				uploaded = new Uint8Array(await new Response(init.body).arrayBuffer())
				return new Response(null, { status: 200 })
			},
		})
		const response = await service.fetch(
			new Request('http://source.test/v1/source/upload', {
				method: 'POST',
				headers: { authorization: 'Bearer source-rpc-key-that-is-at-least-32-characters', 'content-type': 'application/json' },
				body: JSON.stringify(buildZeropsSourceUploadRequest({
					runId: 'run-1',
					appVersionId: 'version-1',
					repository,
					commitSha: fixture.commitSha,
					uploadUrl,
					descriptor: { path: 'zerops.yaml', sha256: descriptorSha256 },
					signal: new AbortController().signal,
				})),
			}),
		)
		const delivered = parseTar(new Uint8Array(Bun.gunzipSync(uploaded)))

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			protocolVersion: 1,
			runId: 'run-1',
			appVersionId: 'version-1',
			commitSha: fixture.commitSha,
			descriptorSha256,
		})
		expect(delivered.map((part) => [part.path, part.mode, part.type])).toEqual([
			['.gitattributes', 0o644, '0'],
			['bin/', 0o755, '5'],
			['bin/run', 0o755, '0'],
			['deeply/', 0o755, '5'],
			['deeply/nested/', 0o755, '5'],
			['deeply/nested/but/', 0o755, '5'],
			['deeply/nested/but/quite/', 0o755, '5'],
			['deeply/nested/but/quite/short.txt', 0o644, '0'],
			['zerops.yaml', 0o644, '0'],
		])
		expect(new TextDecoder().decode(delivered.find((part) => part.path === 'zerops.yaml')?.content)).toBe(descriptor)
	})

	test('passes file content through without buffering a whole entry', async () => {
		const chunkBytes = 64 * 1024
		const content: SourceBytes = new Uint8Array(3 * 1024 * 1024).fill(0x61)
		const tarball = handTarball([file(`${handPrefix}zerops.yaml`, descriptor), entry({ name: `${handPrefix}big`, content })])
		const rewrite = createTarRewrite({ commitSha: handCommitSha, descriptorSha256 })
		const observed: number[] = []
		let pushed = 0
		const source = new ReadableStream<SourceBytes>({
			pull(controller) {
				if (pushed >= tarball.byteLength) {
					controller.close()
					return
				}
				const next = tarball.subarray(pushed, Math.min(pushed + chunkBytes, tarball.byteLength))
				pushed += next.byteLength
				controller.enqueue(next.slice())
			},
		})
		const reader = source.pipeThrough(rewrite.transform).getReader()
		let total = 0
		while (true) {
			const result = await reader.read()
			if (result.done) break
			observed.push(result.value.byteLength)
			total += result.value.byteLength
		}
		const summary = await rewrite.completed

		expect(summary.expandedBytes).toBe(descriptor.length + content.byteLength)
		expect(Math.max(...observed)).toBeLessThanOrEqual(chunkBytes)
		expect(observed.length).toBeGreaterThan(content.byteLength / chunkBytes)
		expect(total).toBeGreaterThan(content.byteLength)
	})
})

interface ArchivedEntry {
	path: string
	mode: number
	type: string
	content: SourceBytes
}

interface ArchiveRun {
	collected: { ok: boolean; bytes: SourceBytes }
	summary: Awaited<RepositoryArchive['completed']> | undefined
	failure: unknown
}

async function runArchive(
	source: TarballRepositorySource,
	input: Parameters<TarballRepositorySource['archive']>[0],
): Promise<ArchiveRun> {
	const archive = await source.archive(input)
	const collected = await new Response(archive.body).arrayBuffer().then(
		(value) => ({ ok: true, bytes: new Uint8Array(value) }),
		() => ({ ok: false, bytes: new Uint8Array() }),
	)
	archive.dispose()
	return await archive.completed.then(
		(summary) => ({ collected, summary, failure: undefined }),
		(failure: unknown) => ({ collected, summary: undefined, failure }),
	)
}

function entries(run: ArchiveRun): ArchivedEntry[] {
	return parseTar(run.collected.bytes)
}

function text(run: ArchiveRun, path: string): string {
	const found = entries(run).find((candidate) => candidate.path === path)
	if (found === undefined) throw new Error(`archive has no ${path}`)
	return new TextDecoder().decode(found.content)
}

/** Parse the rewritten archive the way the destination would, so assertions read real tar bytes. */
function parseTar(archive: SourceBytes): ArchivedEntry[] {
	const parsed: ArchivedEntry[] = []
	let offset = 0
	let pendingPath: string | undefined
	while (offset + 512 <= archive.byteLength) {
		const block = archive.subarray(offset, offset + 512)
		offset += 512
		if (block.every((byte) => byte === 0)) break
		const name = field(block, 0, 100)
		const mode = Number.parseInt(field(block, 100, 8), 8)
		const size = Number.parseInt(field(block, 124, 12), 8)
		const type = String.fromCharCode(block[156] ?? 0)
		const content = archive.subarray(offset, offset + size)
		offset += size + ((512 - (size % 512)) % 512)
		if (type === 'x') {
			const record = new TextDecoder().decode(content)
			const match = /^\d+ path=(.*)\n$/.exec(record)
			if (match?.[1] === undefined) throw new Error('unreadable pax record')
			pendingPath = match[1]
			continue
		}
		parsed.push({ path: pendingPath ?? name, mode, type, content })
		pendingPath = undefined
	}
	return parsed
}

function field(block: SourceBytes, offset: number, length: number): string {
	const slice = block.subarray(offset, offset + length)
	const end = slice.indexOf(0)
	return new TextDecoder().decode(slice.subarray(0, end === -1 ? slice.byteLength : end)).trim()
}

interface FixtureOptions {
	longPath?: string
	symlink?: boolean
	exportIgnored?: boolean
}

interface Fixture {
	commitSha: string
	tarball: SourceBytes
}

async function gitFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), 'source-repository-test-'))
	roots.push(root)
	const working = join(root, 'working')
	await mkdir(working)
	await command(['git', 'init', '--quiet', '--initial-branch=main', working])
	await command(['git', '-C', working, 'config', 'user.email', 'source-test@example.test'])
	await command(['git', '-C', working, 'config', 'user.name', 'Source Test'])
	await mkdir(join(working, 'bin'))
	await writeFile(join(working, 'zerops.yaml'), descriptor)
	await writeFile(join(working, 'bin/run'), "#!/bin/sh\nprintf '$Format:%H$'\n")
	await writeFile(
		join(working, '.gitattributes'),
		`bin/run export-subst\n${options.exportIgnored === true ? 'secrets/ export-ignore\n' : ''}`,
	)
	if (options.exportIgnored === true) {
		await mkdir(join(working, 'secrets'))
		await writeFile(join(working, 'secrets/local.env'), 'TOKEN=must-not-ship\n')
	}
	if (options.longPath !== undefined) {
		await mkdir(join(working, options.longPath.slice(0, options.longPath.lastIndexOf('/'))), { recursive: true })
		await writeFile(join(working, options.longPath), 'long path contents')
	}
	if (options.symlink === true) await symlink('zerops.yaml', join(working, 'unsafe-link'))
	await command(['git', '-C', working, 'add', '.'])
	await command(['git', '-C', working, 'update-index', '--chmod=+x', 'bin/run'])
	await command(['git', '-C', working, 'commit', '--quiet', '-m', 'fixture'])
	const commitSha = (await commandText(['git', '-C', working, 'rev-parse', 'HEAD'])).trim()
	const tar = await commandBytes([
		'git',
		'-C',
		working,
		'archive',
		'--format=tar',
		`--prefix=contember-fixture-${commitSha.slice(0, 7)}/`,
		commitSha,
	])
	return { commitSha, tarball: Bun.gzipSync(tar) }
}

interface SourceOptions {
	github?: SourceGitHubConnection
	location?: string
	redirectResponse?: () => Response
	descriptorResponse?: () => Response
	onDownload?: () => void
	onMetadataRequest?: (url: string) => void
	onMetadataAuthorization?: (value: string | null) => void
	onDownloadAuthorization?: (url: string, value: string | null) => void
}

function sourceFor(fixture: Fixture, options: SourceOptions = {}): TarballRepositorySource {
	return new TarballRepositorySource({
		...(options.github === undefined ? {} : { github: options.github }),
		metadata: new GitHubMetadataClient({
			fetch: async (input, init) => {
				const url = input.toString()
				options.onMetadataRequest?.(url)
				options.onMetadataAuthorization?.(new Headers(init?.headers).get('authorization'))
				if (url.includes('/commits/')) return Response.json({ sha: fixture.commitSha })
				if (url.includes('/contents/')) return options.descriptorResponse?.() ?? new Response(descriptor)
				return new Response(null, { status: 404 })
			},
		}),
		downloadFetch: downloadFetchFor(fixture.tarball, options),
	})
}

function handSource(tarball: SourceBytes, options: SourceOptions = {}): TarballRepositorySource {
	return new TarballRepositorySource({ downloadFetch: downloadFetchFor(Bun.gzipSync(tarball), options) })
}

function downloadFetchFor(gzipped: SourceBytes, options: SourceOptions): SourceDownloadFetch {
	return async (input, init) => {
		options.onDownloadAuthorization?.(input, new Headers(init.headers).get('authorization'))
		if (input.startsWith('https://api.github.com/')) {
			expect(init.redirect).toBe('manual')
			return options.redirectResponse?.()
				?? new Response(null, { status: 302, headers: { location: options.location ?? codeloadUrl } })
		}
		expect(input).toBe(codeloadUrl)
		expect(init.redirect).toBe('error')
		options.onDownload?.()
		return new Response(gzipped, { status: 200 })
	}
}

interface EntryOptions {
	name: string
	type?: string
	mode?: number
	size?: number
	content?: SourceBytes
	linkname?: string
}

function entry(options: EntryOptions): SourceBytes {
	const content = options.content ?? new Uint8Array()
	const size = options.size ?? content.byteLength
	const block = new Uint8Array(512)
	writeField(block, 0, options.name)
	writeField(block, 100, (options.mode ?? 0o644).toString(8).padStart(7, '0'))
	writeField(block, 108, '0000000')
	writeField(block, 116, '0000000')
	writeField(block, 124, size.toString(8).padStart(11, '0'))
	writeField(block, 136, '00000000000')
	block.fill(0x20, 148, 156)
	block[156] = (options.type ?? '0').charCodeAt(0)
	if (options.linkname !== undefined) writeField(block, 157, options.linkname)
	writeField(block, 257, 'ustar')
	writeField(block, 263, '00')
	let checksum = 0
	for (const byte of block) checksum += byte
	writeField(block, 148, checksum.toString(8).padStart(6, '0'))
	block[154] = 0
	block[155] = 0x20
	return concat(block, padded(content))
}

function file(name: string, contents: string, mode = 0o644): SourceBytes {
	return entry({ name, mode, content: bytes(contents) })
}

function paxed(payload: string, next: SourceBytes): SourceBytes {
	const record = bytes(`${payload.length + 1 + String(payload.length + 4).length} ${payload}`)
	return concat(entry({ name: 'PaxHeaders/0', type: 'x', size: record.byteLength }), padded(record), next)
}

function globalHeader(commitSha: string): SourceBytes {
	const body = `comment=${commitSha}\n`
	const record = bytes(`${body.length + 1 + String(body.length + 4).length} ${body}`)
	return concat(entry({ name: 'pax_global_header', type: 'g', size: record.byteLength }), padded(record))
}

function corrupt(block: SourceBytes): SourceBytes {
	const damaged = block.slice()
	damaged[0] = 0x7a
	return damaged
}

function handTarball(parts: readonly SourceBytes[], options: { commitSha?: string } = {}): SourceBytes {
	return concat(globalHeader(options.commitSha ?? handCommitSha), ...parts, new Uint8Array(1024))
}

function padded(content: SourceBytes): SourceBytes {
	const padding = (512 - (content.byteLength % 512)) % 512
	return padding === 0 ? content : concat(content, new Uint8Array(padding))
}

function writeField(block: SourceBytes, offset: number, value: string): void {
	block.set(new TextEncoder().encode(value), offset)
}

function bytes(value: string): SourceBytes {
	return new TextEncoder().encode(value)
}

function concat(...parts: readonly SourceBytes[]): SourceBytes {
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
	const output = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		output.set(part, offset)
		offset += part.byteLength
	}
	return output
}

async function command(args: string[]): Promise<void> {
	const process = Bun.spawn(args, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
	if ((await process.exited) !== 0) throw new Error('fixture command failed')
}

async function commandText(args: string[]): Promise<string> {
	return new TextDecoder().decode(await commandBytes(args))
}

async function commandBytes(args: string[]): Promise<SourceBytes> {
	const process = Bun.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
	if (process.stdout === undefined) throw new Error('fixture command stdout missing')
	const output = new Uint8Array(await new Response(process.stdout).arrayBuffer())
	if ((await process.exited) !== 0) throw new Error('fixture command failed')
	return output
}
