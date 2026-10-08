import { expect } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SourceBytes } from '../archive'
import type { GitHubSourceCredentials } from '../credentials'
import { GitHubMetadataClient } from '../metadata'
import { type RepositoryArchive, type RepositoryArchiveInput, type SourceDownloadFetch, TarballRepositorySource } from '../repository'
import type { SourceArchiveKind } from '../types'

export const DESCRIPTOR = { path: 'zerops.yaml', maxBytes: 256 * 1024 }
export const descriptor = 'zerops:\n  - setup: app\n'
export const descriptorSha256 = new Bun.CryptoHasher('sha256').update(descriptor).digest('hex')
export const repository = { owner: 'contember', name: 'fixture' }
export const codeloadUrl = 'https://codeload.github.com/contember/fixture/tar.gz/refs/heads/main?token=must-not-leak'
export const uploadUrl = 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=private'
export const handCommitSha = 'a'.repeat(40)
export const handPrefix = 'contember-fixture-aaaaaaa/'
const roots: string[] = []

export async function removeFixtureRoots(): Promise<void> {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

interface ArchivedEntry {
	linkpath: string
	path: string
	mode: number
	type: string
	content: SourceBytes
}

export interface ArchiveRun {
	collected: { ok: boolean; bytes: SourceBytes }
	summary: Awaited<RepositoryArchive['completed']> | undefined
	failure: unknown
}

/** An application archive unless the input names another kind. */
export async function runArchive(
	source: TarballRepositorySource,
	input: Omit<RepositoryArchiveInput, 'archive'> & { readonly archive?: SourceArchiveKind },
): Promise<ArchiveRun> {
	const archive = await source.archive({ ...input, archive: input.archive ?? { kind: 'application' } })
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

export function entries(run: ArchiveRun): ArchivedEntry[] {
	return parseTar(run.collected.bytes)
}

export function text(run: ArchiveRun, path: string): string {
	const found = entries(run).find((candidate) => candidate.path === path)
	if (found === undefined) throw new Error(`archive has no ${path}`)
	return new TextDecoder().decode(found.content)
}

/** Parse the rewritten archive the way the destination would, so assertions read real tar bytes. */
export function parseTar(archive: SourceBytes): ArchivedEntry[] {
	const parsed: ArchivedEntry[] = []
	let offset = 0
	let pendingPath: string | undefined
	let pendingLinkpath: string | undefined
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
			for (const match of record.matchAll(/\d+ (path|linkpath)=(.*)\n/g)) {
				if (match[1] === 'path') pendingPath = match[2]
				else pendingLinkpath = match[2]
			}
			continue
		}
		parsed.push({ path: pendingPath ?? name, mode, type, content, linkpath: pendingLinkpath ?? field(block, 157, 100) })
		pendingPath = undefined
		pendingLinkpath = undefined
	}
	return parsed
}

function field(block: SourceBytes, offset: number, length: number): string {
	const slice = block.subarray(offset, offset + length)
	const end = slice.indexOf(0)
	return new TextDecoder().decode(slice.subarray(0, end === -1 ? slice.byteLength : end)).trim()
}

interface FixtureOptions {
	gitlink?: 'markerless' | 'export-ignored-marker'
	agentsLink?: boolean
	longPath?: string
	symlink?: boolean
	exportIgnored?: boolean
}

export interface Fixture {
	commitSha: string
	treeSha: string
	tree: Array<{ path: string; mode: string; type: string; sha: string }>
	tarball: SourceBytes
}

export async function gitFixture(options: FixtureOptions = {}): Promise<Fixture> {
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
	if (options.agentsLink === true) {
		await writeFile(join(working, 'CLAUDE.md'), 'instructions')
		await symlink('CLAUDE.md', join(working, 'AGENTS.md'))
	}
	await command(['git', '-C', working, 'add', '.'])
	if (options.gitlink !== undefined) {
		await command(['git', '-C', working, 'update-index', '--add', '--cacheinfo', `160000,${handCommitSha},vendor`])
		if (options.gitlink === 'export-ignored-marker') {
			await writeFile(join(working, '.gitmodules'), '[submodule "vendor"]\n\tpath = vendor\n\turl = https://github.com/example/vendor\n')
			await writeFile(join(working, '.gitattributes'), '.gitmodules export-ignore\n')
			await command(['git', '-C', working, 'add', '.gitmodules', '.gitattributes'])
		}
	}
	await command(['git', '-C', working, 'update-index', '--chmod=+x', 'bin/run'])
	await command(['git', '-C', working, 'commit', '--quiet', '-m', 'fixture'])
	const commitSha = (await commandText(['git', '-C', working, 'rev-parse', 'HEAD'])).trim()
	const treeSha = (await commandText(['git', '-C', working, 'rev-parse', 'HEAD^{tree}'])).trim()
	const tree = (await commandText(['git', '-C', working, 'ls-tree', '-r', '-t', '-z', 'HEAD'])).split('\0').filter(Boolean).map((line) => {
		const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line)
		const [, mode, type, sha, path] = match ?? []
		if (mode === undefined || type === undefined || sha === undefined || path === undefined) throw new Error('invalid fixture tree')
		return { mode, type, sha, path }
	})
	const tar = await commandBytes([
		'git',
		'-C',
		working,
		'archive',
		'--format=tar',
		`--prefix=contember-fixture-${commitSha.slice(0, 7)}/`,
		commitSha,
	])
	return { commitSha, treeSha, tree, tarball: Bun.gzipSync(tar) }
}

export interface SourceOptions {
	treeResponse?: () => Response
	credentials?: GitHubSourceCredentials
	location?: string
	redirectResponse?: () => Response
	descriptorResponse?: () => Response
	onDownload?: () => void
	onMetadataRequest?: (url: string) => void
	onMetadataAuthorization?: (value: string | null) => void
	onDownloadAuthorization?: (url: string, value: string | null) => void
}

export function sourceFor(fixture: Fixture, options: SourceOptions = {}): TarballRepositorySource {
	return new TarballRepositorySource({
		credentials: options.credentials ?? { repositoryToken: () => Promise.reject(new Error('no credential expected')) },
		descriptor: DESCRIPTOR,
		metadata: new GitHubMetadataClient({
			descriptor: DESCRIPTOR,
			fetch: async (input, init) => {
				const url = input.toString()
				options.onMetadataRequest?.(url)
				options.onMetadataAuthorization?.(new Headers(init?.headers).get('authorization'))
				if (url.includes('/commits/')) return Response.json({ sha: fixture.commitSha, commit: { tree: { sha: fixture.treeSha } } })
				if (url.includes('/git/trees/')) return options.treeResponse?.() ?? Response.json({ sha: fixture.treeSha, truncated: false, tree: fixture.tree })
				if (url.includes('/contents/')) return options.descriptorResponse?.() ?? new Response(descriptor)
				return new Response(null, { status: 404 })
			},
		}),
		downloadFetch: downloadFetchFor(fixture.tarball, options),
	})
}

export function handSource(tarball: SourceBytes, options: SourceOptions = {}): TarballRepositorySource {
	return sourceFor({ commitSha: handCommitSha, treeSha: 'b'.repeat(40), tree: [], tarball: Bun.gzipSync(tarball) }, options)
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

export function entry(options: EntryOptions): SourceBytes {
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

export function file(name: string, contents: string, mode = 0o644): SourceBytes {
	return entry({ name, mode, content: bytes(contents) })
}

export function link(path: string, target: string): SourceBytes {
	return entry({ name: `${handPrefix}${path}`, type: '2', linkname: target })
}

export function platformArchive(parts: SourceBytes[]): Promise<ArchiveRun> {
	return runArchive(handSource(handTarball(parts)), {
		repository,
		commitSha: handCommitSha,
		descriptorSha256,
		signal: new AbortController().signal,
		archive: { kind: 'platform' },
	})
}

export function paxed(payload: string, next: SourceBytes): SourceBytes {
	const record = bytes(`${payload.length + 1 + String(payload.length + 4).length} ${payload}`)
	return concat(entry({ name: 'PaxHeaders/0', type: 'x', size: record.byteLength }), padded(record), next)
}

export function globalHeader(commitSha: string): SourceBytes {
	const body = `comment=${commitSha}\n`
	const record = bytes(`${body.length + 1 + String(body.length + 4).length} ${body}`)
	return concat(entry({ name: 'pax_global_header', type: 'g', size: record.byteLength }), padded(record))
}

export function corrupt(block: SourceBytes): SourceBytes {
	const damaged = block.slice()
	damaged[0] = 0x7a
	return damaged
}

export function handTarball(parts: readonly SourceBytes[], options: { commitSha?: string } = {}): SourceBytes {
	return concat(globalHeader(options.commitSha ?? handCommitSha), ...parts, new Uint8Array(1024))
}

function padded(content: SourceBytes): SourceBytes {
	const padding = (512 - (content.byteLength % 512)) % 512
	return padding === 0 ? content : concat(content, new Uint8Array(padding))
}

function writeField(block: SourceBytes, offset: number, value: string): void {
	block.set(new TextEncoder().encode(value), offset)
}

export function bytes(value: string): SourceBytes {
	return new TextEncoder().encode(value)
}

export function concat(...parts: readonly SourceBytes[]): SourceBytes {
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
