import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { GitHubMetadataClient, type GitHubTreeEntry } from '../github-metadata'
import {
	gitChildEnvironment,
	githubRepositoryUrl,
	GitRepositorySource,
	SOURCE_MAX_EXPANDED_BYTES,
	SOURCE_MAX_TREE_ENTRIES,
	validateGitTree,
} from '../repository'

const objectId = 'a'.repeat(40)
const descriptor = 'zerops:\n  - setup: app\n'
const descriptorSha256 = createHash('sha256').update(descriptor).digest('hex')
const roots: string[] = []

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	)
})

function treeEntry(
	mode: string,
	type: string,
	size: string,
	path: string,
): string {
	return `${mode} ${type} ${objectId} ${size.padStart(7)}\t${path}\0`
}

describe('Git tree preflight', () => {
	test('accepts only ordinary blobs and accounts exact expanded bytes', () => {
		const summary = validateGitTree(
			treeEntry('100644', 'blob', '25', 'zerops.yaml')
				+ treeEntry('100755', 'blob', '9', 'bin/start'),
		)
		expect(summary).toEqual({
			entryCount: 2,
			expandedBytes: 34,
			descriptorSize: 25,
		})
	})

	test.each([
		treeEntry('120000', 'blob', '4', 'link'),
		treeEntry('160000', 'commit', '-', 'module'),
		treeEntry('040000', 'tree', '-', 'folder'),
		treeEntry('100644', 'blob', '4', '/absolute'),
		treeEntry('100644', 'blob', '4', '../escape'),
		treeEntry('100644', 'blob', '4', 'nested/../../escape'),
		treeEntry('100644', 'blob', '4', 'nested//empty'),
		treeEntry('100644', 'blob', '4', 'windows\\path'),
		treeEntry('100644', 'blob', '4', 'line\nbreak'),
	])('rejects special or unsafe tree entry %#', (entry) => {
		expect(() => validateGitTree(treeEntry('100644', 'blob', '25', 'zerops.yaml') + entry)).toThrow('source operation failed')
	})

	test('requires a regular root descriptor and enforces count and byte limits from metadata', () => {
		expect(() => validateGitTree(treeEntry('100644', 'blob', '1', 'nested/zerops.yaml'))).toThrow()
		expect(() =>
			validateGitTree(
				treeEntry(
					'100644',
					'blob',
					String(SOURCE_MAX_EXPANDED_BYTES),
					'zerops.yaml',
				) + treeEntry('100644', 'blob', '1', 'extra'),
			)
		).toThrow()
		const entries = [treeEntry('100644', 'blob', '1', 'zerops.yaml')]
		for (let index = 0; index < SOURCE_MAX_TREE_ENTRIES; index++) {
			entries.push(treeEntry('100644', 'blob', '0', `file-${index}`))
		}
		expect(() => validateGitTree(entries.join(''))).toThrow()
	})
})

describe('Git repository source', () => {
	test('uses a fixed GitHub origin and places a scoped token only in the isolated child environment', () => {
		const token = 'ghs_repository_scoped_secret'
		const url = githubRepositoryUrl({
			owner: 'contember',
			name: 'fabrika-platform',
		})
		expect(url).toBe('https://github.com/contember/fabrika-platform.git')
		expect(url).not.toContain(token)
		const environment = gitChildEnvironment('/usr/bin', token)
		expect(environment.GIT_CONFIG_KEY_1).toBe(
			'http.https://github.com/.extraHeader',
		)
		expect(environment.GIT_CONFIG_VALUE_1).toBe(
			`Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
		)
		expect(environment.GIT_CONFIG_VALUE_0).toBe('false')
	})

	test('mints one repository-scoped token and uses it for private REST metadata', async () => {
		const fixture = await repositoryFixture()
		const token = 'ghs_private_repository'
		const mintCalls: unknown[] = []
		const authorizations: Array<string | null> = []
		const baseMetadata = fixtureMetadata(fixture)
		const metadata = new GitHubMetadataClient({
			fetch: async (input, init) => {
				authorizations.push(new Headers(init?.headers).get('authorization'))
				return baseMetadataResponse(fixture, input.toString())
			},
		})
		const source = new GitRepositorySource({
			repositoryUrl: () => fixture.remoteUrl,
			tempRoot: fixture.root,
			metadata,
			github: {
				mintRepositoryToken: async (input) => {
					mintCalls.push(input)
					return { token, expiresAt: Date.now() + 60_000 }
				},
			},
		})
		const signal = new AbortController().signal
		expect(
			await source.resolve({
				repository: { owner: 'contember', name: 'fixture' },
				requestedRef: fixture.commitSha,
				githubInstallationId: 42,
				descriptorSha256,
				signal,
			}),
		).toEqual({ commitSha: fixture.commitSha, descriptorSha256 })
		expect(mintCalls).toEqual([
			{ installationId: 42, owner: 'contember', repository: 'fixture', signal },
		])
		expect(authorizations).toEqual([`Bearer ${token}`, `Bearer ${token}`])
	})

	test('resolves an exact commit, verifies the root descriptor, and archives Git objects without executing repository code', async () => {
		const fixture = await repositoryFixture()
		const marker = join(fixture.root, 'must-not-exist')
		const source = sourceForFixture(fixture)
		const signal = new AbortController().signal
		const resolved = await source.resolve({
			repository: { owner: 'contember', name: 'fixture' },
			requestedRef: 'main',
			descriptorSha256,
			signal,
		})
		expect(resolved).toEqual({
			commitSha: fixture.commitSha,
			descriptorSha256,
		})

		const archive = await source.prepareArchive({
			repository: { owner: 'contember', name: 'fixture' },
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal,
		})
		try {
			const paths = await commandText(['tar', '-tf', archive.tarPath])
			expect(paths.split('\n')).toContain('zerops.yaml')
			expect(paths.split('\n')).toContain('bin/')
			expect(paths.split('\n')).toContain('bin/run')
			expect(paths.split('\n')).toContain('.gitattributes')
			expect(
				await commandText(['tar', '-xOf', archive.tarPath, 'zerops.yaml']),
			).toBe(descriptor)
			expect(
				await commandText(['tar', '-xOf', archive.tarPath, 'bin/run']),
			).toContain('$Format:%H$')
			expect(await Bun.file(marker).exists()).toBe(false)
			expect(archive.entryCount).toBe(3)
		} finally {
			await archive.cleanup()
		}
	})

	test('rejects descriptor drift before producing an archive', async () => {
		const fixture = await repositoryFixture()
		const source = sourceForFixture(fixture)
		await expect(
			source.prepareArchive({
				repository: { owner: 'contember', name: 'fixture' },
				commitSha: fixture.commitSha,
				descriptorSha256: 'f'.repeat(64),
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'descriptor_mismatch', stage: 'archive' })
	})

	test('rejects REST size drift while streaming the approved blob', async () => {
		const fixture = await repositoryFixture()
		const entries = fixture.entries.map((entry) =>
			entry.type === 'blob' && entry.path === 'bin/run'
				? { ...entry, size: entry.size - 1 }
				: entry
		)
		const source = new GitRepositorySource({
			repositoryUrl: () => fixture.remoteUrl,
			tempRoot: fixture.root,
			metadata: fixtureMetadata({ ...fixture, entries }),
		})
		await expect(
			source.prepareArchive({
				repository: { owner: 'contember', name: 'fixture' },
				commitSha: fixture.commitSha,
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'archive_rejected', stage: 'archive' })
	})

	test('writes a deterministic tar with explicit parents, long paths, and preserved executable modes', async () => {
		const longPath = `${'nested-'.repeat(15)}directory/child/file.txt`
		const fixture = await repositoryFixture({ longPath })
		const source = sourceForFixture(fixture)
		const input = {
			repository: { owner: 'contember', name: 'fixture' },
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		}
		const first = await source.prepareArchive(input)
		const firstBytes = new Uint8Array(
			await Bun.file(first.tarPath).arrayBuffer(),
		)
		const paths = (await commandText(['tar', '-tf', first.tarPath])).split(
			'\n',
		)
		const verbose = await commandText(['tar', '-tvf', first.tarPath])
		expect(paths).toContain(
			`${longPath.slice(0, longPath.lastIndexOf('/child/file.txt'))}/`,
		)
		expect(paths).toContain(longPath)
		expect(
			verbose
				.split('\n')
				.find((line) => line.endsWith(' bin/run'))
				?.startsWith('-rwxr-xr-x'),
		).toBe(true)
		await first.cleanup()

		const shuffledSource = new GitRepositorySource({
			repositoryUrl: () => fixture.remoteUrl,
			tempRoot: fixture.root,
			metadata: fixtureMetadata({ ...fixture, entries: [...fixture.entries].reverse() }),
		})
		const second = await shuffledSource.prepareArchive(input)
		try {
			expect(
				new Uint8Array(await Bun.file(second.tarPath).arrayBuffer()),
			).toEqual(firstBytes)
		} finally {
			await second.cleanup()
		}
	})

	test('hashes and archives descriptor bytes exactly when UTF-8 starts with a BOM', async () => {
		const bomDescriptor = new Uint8Array([
			0xef,
			0xbb,
			0xbf,
			...new TextEncoder().encode(descriptor),
		])
		const bomSha256 = createHash('sha256').update(bomDescriptor).digest('hex')
		const fixture = await repositoryFixture({ descriptor: bomDescriptor })
		const source = sourceForFixture(fixture)
		const archive = await source.prepareArchive({
			repository: { owner: 'contember', name: 'fixture' },
			commitSha: fixture.commitSha,
			descriptorSha256: bomSha256,
			signal: new AbortController().signal,
		})
		try {
			expect(
				await commandBytes(['tar', '-xOf', archive.tarPath, 'zerops.yaml']),
			).toEqual(bomDescriptor)
		} finally {
			await archive.cleanup()
		}
	})

	test('supports repositories and requested commits with 64-hex object ids', async () => {
		const fixture = await repositoryFixture({ objectFormat: 'sha256' })
		expect(fixture.commitSha).toHaveLength(64)
		const source = sourceForFixture(fixture)
		const resolved = await source.resolve({
			repository: { owner: 'contember', name: 'fixture' },
			requestedRef: fixture.commitSha,
			expectedCommitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(resolved.commitSha).toBe(fixture.commitSha)
	})

	test('rejects unsafe metadata before requesting any blob', async () => {
		const fixture = await repositoryFixture({ unsafeSymlink: true })
		let blobReads = 0
		const source = new GitRepositorySource({
			repositoryUrl: () => fixture.remoteUrl,
			tempRoot: fixture.root,
			metadata: fixtureMetadata(fixture),
			onBlobRead: () => blobReads++,
		})
		await expect(
			source.resolve({
				repository: { owner: 'contember', name: 'fixture' },
				requestedRef: fixture.commitSha,
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: 'archive_rejected', stage: 'resolve' })
		expect(blobReads).toBe(0)
	})

	test.each(['timeout', 'caller cancellation'])(
		'bounds Git operations, preserves %s, and removes its temporary repository',
		async (kind) => {
			const tempRoot = await mkdtemp(
				join(tmpdir(), 'source-git-timeout-test-'),
			)
			roots.push(tempRoot)
			const server = Bun.serve({
				hostname: '127.0.0.1',
				port: 0,
				fetch: async () => await new Promise<Response>(() => {}),
			})
			try {
				const controller = new AbortController()
				const source = new GitRepositorySource({
					repositoryUrl: () => `${server.url}repository.git`,
					tempRoot,
					metadata: fixtureMetadata(await repositoryFixture()),
					gitOperationTimeoutMs: kind === 'timeout' ? 50 : 5_000,
				})
				if (kind === 'caller cancellation') {
					setTimeout(() => controller.abort(), 50)
				}
				const failure = source.resolve({
					repository: { owner: 'contember', name: 'fixture' },
					requestedRef: 'main',
					descriptorSha256,
					signal: controller.signal,
				})
				if (kind === 'timeout') {
					await expect(failure).rejects.toMatchObject({
						code: 'internal',
						stage: 'resolve',
						retryable: true,
					})
				} else {
					await expect(failure).rejects.toMatchObject({
						code: 'cancelled',
						stage: 'resolve',
						retryable: false,
					})
				}
				expect(await readdir(tempRoot)).toEqual([])
			} finally {
				await server.stop(true)
			}
		},
	)

	test('requires GitHub App configuration when an installation id is supplied', async () => {
		const source = new GitRepositorySource({})
		await expect(
			source.resolve({
				repository: { owner: 'contember', name: 'private' },
				requestedRef: 'main',
				githubInstallationId: 42,
				descriptorSha256,
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({
			code: 'installation_not_found',
			stage: 'resolve',
		})
	})
})

async function repositoryFixture(
	options: {
		descriptor?: string | Uint8Array
		longPath?: string
		objectFormat?: 'sha1' | 'sha256'
		unsafeSymlink?: boolean
	} = {},
): Promise<{
	root: string
	working: string
	remoteUrl: string
	commitSha: string
	treeSha: string
	entries: GitHubTreeEntry[]
}> {
	const root = await mkdtemp(join(tmpdir(), 'source-repository-test-'))
	roots.push(root)
	const working = join(root, 'working')
	await mkdir(working)
	await command([
		'git',
		'init',
		'--quiet',
		'--initial-branch=main',
		`--object-format=${options.objectFormat ?? 'sha1'}`,
		working,
	])
	await command([
		'git',
		'-C',
		working,
		'config',
		'user.email',
		'source-test@example.test',
	])
	await command(['git', '-C', working, 'config', 'user.name', 'Source Test'])
	await command([
		'git',
		'-C',
		working,
		'config',
		'uploadpack.allowFilter',
		'true',
	])
	await mkdir(join(working, 'bin'))
	await writeFile(
		join(working, 'zerops.yaml'),
		options.descriptor ?? descriptor,
	)
	await writeFile(
		join(working, 'bin/run'),
		`#!/bin/sh\nprintf '$Format:%H$'\ntouch ${join(root, 'must-not-exist')}\n`,
	)
	await writeFile(
		join(working, '.gitattributes'),
		'zerops.yaml export-ignore\nbin/run export-subst\n',
	)
	if (options.longPath !== undefined) {
		const directory = join(
			working,
			options.longPath.slice(0, options.longPath.lastIndexOf('/')),
		)
		await mkdir(directory, { recursive: true })
		await writeFile(join(working, options.longPath), 'long path contents')
	}
	if (options.unsafeSymlink === true) {
		await symlink('zerops.yaml', join(working, 'unsafe-link'))
	}
	await command(['git', '-C', working, 'add', '.'])
	await command([
		'git',
		'-C',
		working,
		'update-index',
		'--chmod=+x',
		'bin/run',
	])
	await command(['git', '-C', working, 'commit', '--quiet', '-m', 'fixture'])
	const commitSha = (
		await commandText(['git', '-C', working, 'rev-parse', 'HEAD'])
	).trim()
	const treeSha = (
		await commandText(['git', '-C', working, 'rev-parse', 'HEAD^{tree}'])
	).trim()
	const entries = parseFixtureEntries(
		await commandBytes([
			'git',
			'-C',
			working,
			'ls-tree',
			'-r',
			'-t',
			'-z',
			'-l',
			'--full-tree',
			'HEAD',
		]),
	)
	return {
		root,
		working,
		remoteUrl: pathToFileURL(working).href,
		commitSha,
		treeSha,
		entries,
	}
}

function sourceForFixture(
	fixture: Awaited<ReturnType<typeof repositoryFixture>>,
): GitRepositorySource {
	return new GitRepositorySource({
		repositoryUrl: () => fixture.remoteUrl,
		tempRoot: fixture.root,
		metadata: fixtureMetadata(fixture),
	})
}

function fixtureMetadata(
	fixture: Awaited<ReturnType<typeof repositoryFixture>>,
): GitHubMetadataClient {
	return new GitHubMetadataClient({
		fetch: async (input) => baseMetadataResponse(fixture, input.toString()),
	})
}

function baseMetadataResponse(
	fixture: Awaited<ReturnType<typeof repositoryFixture>>,
	input: string,
): Response {
	const url = new URL(input)
	if (url.pathname.includes('/commits/')) {
		return Response.json({
			sha: fixture.commitSha,
			commit: { tree: { sha: fixture.treeSha } },
		})
	}
	if (url.pathname.includes('/git/trees/')) {
		return Response.json({
			sha: fixture.treeSha,
			truncated: false,
			tree: fixture.entries.map(restEntry),
		})
	}
	return new Response(null, { status: 404 })
}

function restEntry(entry: GitHubTreeEntry): Record<string, unknown> {
	return entry.type === 'blob'
		? {
			path: entry.path,
			mode: entry.mode,
			type: entry.type,
			sha: entry.objectId,
			size: entry.size,
		}
		: {
			path: entry.path,
			mode: entry.mode,
			type: entry.type,
			sha: entry.objectId,
		}
}

function parseFixtureEntries(bytes: Uint8Array): GitHubTreeEntry[] {
	const output = new TextDecoder().decode(bytes)
	const rawEntries = output.split('\0')
	if (rawEntries.at(-1) === '') rawEntries.pop()
	return rawEntries.map((entry) => {
		const tab = entry.indexOf('\t')
		const match = /^(\d{6}) (blob|tree) ([a-f0-9]+) +(-|\d+)$/.exec(
			entry.slice(0, tab),
		)
		const path = entry.slice(tab + 1)
		if (
			match?.[1] === '040000'
			&& match[2] === 'tree'
			&& match[3] !== undefined
		) {
			return { path, mode: '040000', type: 'tree', objectId: match[3] }
		}
		if (
			(match?.[1] === '100644' || match?.[1] === '100755')
			&& match[2] === 'blob'
			&& match[3] !== undefined
			&& match[4] !== undefined
		) {
			return {
				path,
				mode: match[1],
				type: 'blob',
				objectId: match[3],
				size: Number(match[4]),
			}
		}
		if (
			match?.[1] === '120000'
			&& match[2] === 'blob'
			&& match[3] !== undefined
			&& match[4] !== undefined
		) {
			return {
				path,
				mode: '100644',
				type: 'blob',
				objectId: match[3],
				size: Number(match[4]),
			}
		}
		throw new Error('fixture tree is invalid')
	})
}

async function command(args: string[]): Promise<void> {
	const process = Bun.spawn(args, {
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
	})
	if ((await process.exited) !== 0) throw new Error('fixture command failed')
}

async function commandText(args: string[]): Promise<string> {
	const process = Bun.spawn(args, {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'ignore',
	})
	if (process.stdout === undefined) {
		throw new Error('fixture command stdout missing')
	}
	const output = await new Response(process.stdout).text()
	if ((await process.exited) !== 0) throw new Error('fixture command failed')
	return output
}

async function commandBytes(args: string[]): Promise<Uint8Array> {
	const process = Bun.spawn(args, {
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'ignore',
	})
	if (process.stdout === undefined) {
		throw new Error('fixture command stdout missing')
	}
	const output = new Uint8Array(
		await new Response(process.stdout).arrayBuffer(),
	)
	if ((await process.exited) !== 0) throw new Error('fixture command failed')
	return output
}
