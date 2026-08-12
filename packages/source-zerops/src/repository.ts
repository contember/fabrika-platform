import type { GitHubAppClient } from '@fabrika/github-app'
import { ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES, type ZeropsSourceRepository } from '@fabrika/provider-zerops'
import { createHash } from 'node:crypto'
import { type FileHandle, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cancelled, SourceFailure, throwIfAborted } from './failure'
import { GitHubMetadataClient, type GitHubRepositorySnapshot, type GitHubTreeBlob, type GitHubTreeEntry } from './github-metadata'

export const SOURCE_MAX_TREE_ENTRIES = 50_000
export const SOURCE_MAX_EXPANDED_BYTES = 512 * 1024 * 1024
const MAX_GIT_TEXT_BYTES = 32 * 1024 * 1024
const DEFAULT_GIT_OPERATION_TIMEOUT_MS = 2 * 60 * 1000
const MAX_GIT_OPERATION_TIMEOUT_MS = 10 * 60 * 1000
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const TAR_BLOCK_BYTES = 512

export interface RepositoryResolveInput {
	repository: ZeropsSourceRepository
	requestedRef: string
	expectedCommitSha?: string
	githubInstallationId?: number
	descriptorSha256: string
	signal: AbortSignal
}

export interface RepositoryResolveResult {
	commitSha: string
	descriptorSha256: string
}

export interface RepositoryArchiveInput {
	repository: ZeropsSourceRepository
	commitSha: string
	githubInstallationId?: number
	descriptorSha256: string
	signal: AbortSignal
}

export interface PreparedRepositoryArchive {
	tarPath: string
	commitSha: string
	descriptorSha256: string
	entryCount: number
	expandedBytes: number
	cleanup(): Promise<void>
}

export interface RepositorySource {
	resolve(input: RepositoryResolveInput): Promise<RepositoryResolveResult>
	prepareArchive(
		input: RepositoryArchiveInput,
	): Promise<PreparedRepositoryArchive>
}

export interface GitRepositorySourceOptions {
	github?: Pick<GitHubAppClient, 'mintRepositoryToken'>
	metadata?: GitHubMetadataClient
	/** Tests may point at a local filtered remote; production always uses the fixed GitHub origin. */
	repositoryUrl?: (repository: ZeropsSourceRepository) => string
	tempRoot?: string
	gitOperationTimeoutMs?: number
	onBlobRead?: (path: string, objectId: string) => void
}

interface GitCredentials {
	token?: string
}

export interface GitChildEnvironment extends Record<string, string | undefined> {
	PATH: string
	GIT_CONFIG_GLOBAL: string
	GIT_CONFIG_NOSYSTEM: string
	GIT_TERMINAL_PROMPT: string
	GIT_OPTIONAL_LOCKS: string
	GIT_CONFIG_COUNT: string
	GIT_CONFIG_KEY_0: string
	GIT_CONFIG_VALUE_0: string
	GIT_CONFIG_KEY_1?: string
	GIT_CONFIG_VALUE_1?: string
}

interface TreeEntry {
	mode: '100644' | '100755'
	objectId: string
	path: string
	size: number
}

interface TreeSummary {
	entryCount: number
	expandedBytes: number
	descriptorSize: number
}

interface VerifiedDescriptor {
	digest: string
	bytes: Uint8Array
}

type RepositoryStage = 'resolve' | 'archive'

export class GitRepositorySource implements RepositorySource {
	private readonly repositoryUrl: (
		repository: ZeropsSourceRepository,
	) => string
	private readonly tempRoot: string
	private readonly gitOperationTimeoutMs: number
	private readonly metadata: GitHubMetadataClient

	constructor(private readonly options: GitRepositorySourceOptions) {
		this.repositoryUrl = options.repositoryUrl ?? githubRepositoryUrl
		this.tempRoot = options.tempRoot ?? tmpdir()
		this.metadata = options.metadata ?? new GitHubMetadataClient()
		const timeout = options.gitOperationTimeoutMs ?? DEFAULT_GIT_OPERATION_TIMEOUT_MS
		if (
			!Number.isSafeInteger(timeout)
			|| timeout <= 0
			|| timeout > MAX_GIT_OPERATION_TIMEOUT_MS
		) {
			throw new Error('Git operation timeout is invalid')
		}
		this.gitOperationTimeoutMs = timeout
	}

	async resolve(
		input: RepositoryResolveInput,
	): Promise<RepositoryResolveResult> {
		throwIfAborted(input.signal, 'resolve')
		const credentials = await this.credentials(
			input.repository,
			input.githubInstallationId,
			input.signal,
			'resolve',
		)
		const snapshot = validatedSnapshot(
			await this.metadata.snapshot(
				input.repository,
				input.requestedRef,
				credentials.token,
				input.signal,
				'resolve',
			),
			'resolve',
		)
		if (
			input.expectedCommitSha !== undefined
			&& snapshot.commitSha !== input.expectedCommitSha
		) {
			throw new SourceFailure('commit_mismatch', 'resolve', false, 409)
		}
		return this.withBareRepository(
			credentials,
			input.signal,
			'resolve',
			snapshot.commitSha.length === 64 ? 'sha256' : 'sha1',
			async (repositoryDir) => {
				await fetchRevision(
					repositoryDir,
					this.repositoryUrl(input.repository),
					snapshot.commitSha,
					credentials,
					input.signal,
					'resolve',
					this.gitOperationTimeoutMs,
				)
				const commitSha = await resolvedCommit(
					repositoryDir,
					credentials,
					input.signal,
					'resolve',
					this.gitOperationTimeoutMs,
				)
				if (commitSha !== snapshot.commitSha) {
					throw new SourceFailure('commit_mismatch', 'resolve', false, 409)
				}
				await crossCheckGitMetadata(
					repositoryDir,
					snapshot,
					credentials,
					input.signal,
					'resolve',
					this.gitOperationTimeoutMs,
				)
				const entries = orderedBlobs(snapshot.entries)
				const descriptor = await verifyDescriptor(
					repositoryDir,
					entries,
					input.descriptorSha256,
					credentials,
					input.signal,
					'resolve',
					this.gitOperationTimeoutMs,
					this.options.onBlobRead,
				)
				return { commitSha, descriptorSha256: descriptor.digest }
			},
		)
	}

	async prepareArchive(
		input: RepositoryArchiveInput,
	): Promise<PreparedRepositoryArchive> {
		throwIfAborted(input.signal, 'archive')
		if (!OBJECT_ID_PATTERN.test(input.commitSha)) {
			throw new SourceFailure('commit_mismatch', 'archive', false, 409)
		}
		const credentials = await this.credentials(
			input.repository,
			input.githubInstallationId,
			input.signal,
			'archive',
		)
		const directory = await mkdtemp(join(this.tempRoot, 'fabrika-source-'))
		const repositoryDir = join(directory, 'repository.git')
		const tarPath = join(directory, 'source.tar')
		const cleanup = () => rm(directory, { recursive: true, force: true })
		try {
			const snapshot = validatedSnapshot(
				await this.metadata.snapshot(
					input.repository,
					input.commitSha,
					credentials.token,
					input.signal,
					'archive',
				),
				'archive',
			)
			if (snapshot.commitSha !== input.commitSha) {
				throw new SourceFailure('commit_mismatch', 'archive', false, 409)
			}
			await initBare(
				repositoryDir,
				input.signal,
				'archive',
				input.commitSha.length === 64 ? 'sha256' : 'sha1',
				this.gitOperationTimeoutMs,
			)
			await fetchRevision(
				repositoryDir,
				this.repositoryUrl(input.repository),
				input.commitSha,
				credentials,
				input.signal,
				'archive',
				this.gitOperationTimeoutMs,
			)
			const commitSha = await resolvedCommit(
				repositoryDir,
				credentials,
				input.signal,
				'archive',
				this.gitOperationTimeoutMs,
			)
			if (commitSha !== snapshot.commitSha) {
				throw new SourceFailure('commit_mismatch', 'archive', false, 409)
			}
			await crossCheckGitMetadata(
				repositoryDir,
				snapshot,
				credentials,
				input.signal,
				'archive',
				this.gitOperationTimeoutMs,
			)
			const entries = orderedBlobs(snapshot.entries)
			const descriptor = await verifyDescriptor(
				repositoryDir,
				entries,
				input.descriptorSha256,
				credentials,
				input.signal,
				'archive',
				this.gitOperationTimeoutMs,
				this.options.onBlobRead,
			)
			await writeDeterministicTar(
				repositoryDir,
				tarPath,
				entries,
				credentials,
				input.signal,
				this.gitOperationTimeoutMs,
				this.options.onBlobRead,
				descriptor,
			)
			const summary = treeSummary(entries)
			return {
				tarPath,
				commitSha,
				descriptorSha256: descriptor.digest,
				entryCount: summary.entryCount,
				expandedBytes: summary.expandedBytes,
				cleanup,
			}
		} catch (error) {
			await cleanup()
			if (input.signal.aborted) throw cancelled('archive')
			throw error
		}
	}

	private async withBareRepository<T>(
		credentials: GitCredentials,
		signal: AbortSignal,
		stage: RepositoryStage,
		objectFormat: 'sha1' | 'sha256',
		operation: (
			repositoryDir: string,
			credentials: GitCredentials,
		) => Promise<T>,
	): Promise<T> {
		throwIfAborted(signal, stage)
		const directory = await mkdtemp(join(this.tempRoot, 'fabrika-source-'))
		const repositoryDir = join(directory, 'repository.git')
		try {
			await initBare(
				repositoryDir,
				signal,
				stage,
				objectFormat,
				this.gitOperationTimeoutMs,
			)
			return await operation(repositoryDir, credentials)
		} catch (error) {
			if (signal.aborted) throw cancelled(stage)
			throw error
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	}

	private async credentials(
		repository: ZeropsSourceRepository,
		githubInstallationId: number | undefined,
		signal: AbortSignal,
		stage: RepositoryStage,
	): Promise<GitCredentials> {
		if (githubInstallationId === undefined) return {}
		if (this.options.github === undefined) {
			throw new SourceFailure('installation_not_found', stage, false, 404)
		}
		try {
			const token = await this.options.github.mintRepositoryToken({
				installationId: githubInstallationId,
				owner: repository.owner,
				repository: repository.name,
				signal,
			})
			return { token: token.token }
		} catch (error) {
			if (
				signal.aborted
				|| (error instanceof Error && error.name === 'AbortError')
			) {
				throw cancelled(stage)
			}
			throw new SourceFailure('internal', stage, true, 502)
		}
	}
}

/** Validate already-sized ls-tree output; production uses the stricter metadata-first preflight below. */
export function validateGitTree(
	output: string,
	stage: RepositoryStage = 'archive',
): TreeSummary {
	const rawEntries = splitNull(output)
	let expandedBytes = 0
	let descriptorSize: number | undefined
	for (const rawEntry of rawEntries) {
		const tab = rawEntry.indexOf('\t')
		if (tab <= 0) throw archiveRejected(stage)
		const metadata = /^(\d{6}) (blob|tree|commit) ([a-f0-9]+) +(-|\d+)$/.exec(
			rawEntry.slice(0, tab),
		)
		const path = rawEntry.slice(tab + 1)
		const mode = metadata?.[1]
		const type = metadata?.[2]
		const objectId = metadata?.[3]
		const sizeText = metadata?.[4]
		if (
			mode === undefined
			|| type !== 'blob'
			|| objectId === undefined
			|| !OBJECT_ID_PATTERN.test(objectId)
			|| sizeText === undefined
			|| (mode !== '100644' && mode !== '100755')
			|| !/^(?:0|[1-9][0-9]*)$/.test(sizeText)
			|| !safeRepositoryPath(path)
		) {
			throw archiveRejected(stage)
		}
		const size = Number(sizeText)
		if (!Number.isSafeInteger(size)) throw archiveRejected(stage)
		expandedBytes += size
		if (expandedBytes > SOURCE_MAX_EXPANDED_BYTES) {
			throw new SourceFailure('archive_rejected', stage, false, 413)
		}
		if (path === 'zerops.yaml') descriptorSize = size
	}
	if (rawEntries.length > SOURCE_MAX_TREE_ENTRIES) {
		throw new SourceFailure('archive_rejected', stage, false, 413)
	}
	if (descriptorSize === undefined) {
		throw new SourceFailure('descriptor_missing', stage, false, 422)
	}
	return { entryCount: rawEntries.length, expandedBytes, descriptorSize }
}

export function githubRepositoryUrl(
	repository: ZeropsSourceRepository,
): string {
	return `https://github.com/${repository.owner}/${repository.name}.git`
}

function validatedSnapshot(
	snapshot: GitHubRepositorySnapshot,
	stage: RepositoryStage,
): GitHubRepositorySnapshot {
	if (snapshot.entries.length > SOURCE_MAX_TREE_ENTRIES) {
		throw new SourceFailure('archive_rejected', stage, false, 413)
	}
	const paths = new Set<string>()
	let expandedBytes = 0
	let hasDescriptor = false
	for (const entry of snapshot.entries) {
		if (paths.has(entry.path)) throw archiveRejected(stage)
		paths.add(entry.path)
		if (entry.type === 'blob') {
			expandedBytes += entry.size
			if (expandedBytes > SOURCE_MAX_EXPANDED_BYTES) {
				throw new SourceFailure('archive_rejected', stage, false, 413)
			}
			if (entry.path === 'zerops.yaml') hasDescriptor = true
		}
	}
	if (!hasDescriptor) {
		throw new SourceFailure('descriptor_missing', stage, false, 422)
	}
	return snapshot
}

async function crossCheckGitMetadata(
	repositoryDir: string,
	snapshot: GitHubRepositorySnapshot,
	credentials: GitCredentials,
	signal: AbortSignal,
	stage: RepositoryStage,
	timeoutMs: number,
): Promise<void> {
	const rootTree = (
		await gitText(
			repositoryDir,
			['rev-parse', '--verify', `${snapshot.commitSha}^{tree}`],
			credentials,
			signal,
			128,
			stage,
			timeoutMs,
		)
	).trim()
	if (rootTree !== snapshot.treeSha) {
		throw new SourceFailure('commit_mismatch', stage, false, 409)
	}
	const output = await gitText(
		repositoryDir,
		['ls-tree', '-r', '-t', '-z', '--full-tree', snapshot.commitSha],
		credentials,
		signal,
		MAX_GIT_TEXT_BYTES,
		stage,
		timeoutMs,
	)
	const gitEntries = parseGitEntries(output, stage)
	if (gitEntries.length !== snapshot.entries.length) {
		throw archiveRejected(stage)
	}
	const expected = new Map(
		snapshot.entries.map((entry) => [entry.path, entry]),
	)
	for (const entry of gitEntries) {
		const rest = expected.get(entry.path)
		if (
			rest === undefined
			|| rest.mode !== entry.mode
			|| rest.type !== entry.type
			|| rest.objectId !== entry.objectId
		) {
			throw archiveRejected(stage)
		}
	}
	const missingOutput = await gitText(
		repositoryDir,
		['rev-list', '--objects', '--missing=print', snapshot.commitSha],
		credentials,
		signal,
		MAX_GIT_TEXT_BYTES,
		stage,
		timeoutMs,
	)
	const missing = new Set(
		missingOutput
			.split('\n')
			.filter((line) => line.startsWith('?'))
			.map((line) => line.slice(1)),
	)
	if (
		snapshot.entries.some(
			(entry) => entry.type === 'blob' && !missing.has(entry.objectId),
		)
	) {
		throw archiveRejected(stage)
	}
}

function parseGitEntries(
	output: string,
	stage: RepositoryStage,
): GitHubTreeEntry[] {
	const entries: GitHubTreeEntry[] = []
	for (const rawEntry of splitNull(output)) {
		const tab = rawEntry.indexOf('\t')
		if (tab <= 0) throw archiveRejected(stage)
		const metadata = /^(\d{6}) (blob|tree|commit) ([a-f0-9]+)$/.exec(
			rawEntry.slice(0, tab),
		)
		const mode = metadata?.[1]
		const type = metadata?.[2]
		const objectId = metadata?.[3]
		const path = rawEntry.slice(tab + 1)
		if (
			!safeRepositoryPath(path)
			|| objectId === undefined
			|| !OBJECT_ID_PATTERN.test(objectId)
		) {
			throw archiveRejected(stage)
		}
		if (mode === '040000' && type === 'tree') {
			entries.push({ path, mode, type, objectId })
			continue
		}
		if ((mode !== '100644' && mode !== '100755') || type !== 'blob') {
			throw archiveRejected(stage)
		}
		entries.push({ path, mode, type, objectId, size: 0 })
	}
	return entries
}

function isBlob(entry: GitHubTreeEntry): entry is GitHubTreeBlob {
	return entry.type === 'blob'
}

/** Canonicalize archive order independently of the GitHub REST response order. */
function orderedBlobs(entries: GitHubTreeEntry[]): GitHubTreeBlob[] {
	return entries.filter(isBlob).sort((left, right) => compareUtf8Paths(left.path, right.path))
}

function compareUtf8Paths(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function treeSummary(entries: TreeEntry[]): TreeSummary {
	const descriptor = entries.find((entry) => entry.path === 'zerops.yaml')
	if (descriptor === undefined) {
		throw new SourceFailure('descriptor_missing', 'archive', false, 422)
	}
	return {
		entryCount: entries.length,
		expandedBytes: entries.reduce((total, entry) => total + entry.size, 0),
		descriptorSize: descriptor.size,
	}
}

function safeRepositoryPath(path: string): boolean {
	if (
		path === ''
		|| path.startsWith('/')
		|| path.includes('\\')
		|| [...path].some(
			(character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
		)
	) {
		return false
	}
	const segments = path.split('/')
	return segments.every(
		(segment) => segment !== '' && segment !== '.' && segment !== '..',
	)
}

async function verifyDescriptor(
	repositoryDir: string,
	entries: TreeEntry[],
	expectedSha256: string,
	credentials: GitCredentials,
	signal: AbortSignal,
	stage: RepositoryStage,
	timeoutMs: number,
	onBlobRead: GitRepositorySourceOptions['onBlobRead'],
): Promise<VerifiedDescriptor> {
	if (!SHA256_PATTERN.test(expectedSha256)) {
		throw new SourceFailure('descriptor_mismatch', stage, false, 409)
	}
	const descriptor = entries.find((entry) => entry.path === 'zerops.yaml')
	if (descriptor === undefined) {
		throw new SourceFailure('descriptor_missing', stage, false, 422)
	}
	if (descriptor.size > ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES) {
		throw new SourceFailure('archive_rejected', stage, false, 422)
	}
	onBlobRead?.(descriptor.path, descriptor.objectId)
	const contents = await gitBytes(
		repositoryDir,
		['cat-file', 'blob', descriptor.objectId],
		credentials,
		signal,
		descriptor.size,
		stage,
		timeoutMs,
	)
	if (contents.byteLength !== descriptor.size) throw archiveRejected(stage)
	const actual = createHash('sha256').update(contents).digest('hex')
	if (actual !== expectedSha256) {
		throw new SourceFailure('descriptor_mismatch', stage, false, 409)
	}
	return { digest: actual, bytes: contents }
}

async function writeDeterministicTar(
	repositoryDir: string,
	tarPath: string,
	entries: TreeEntry[],
	credentials: GitCredentials,
	signal: AbortSignal,
	timeoutMs: number,
	onBlobRead: GitRepositorySourceOptions['onBlobRead'],
	descriptor: VerifiedDescriptor,
): Promise<void> {
	const tar = await open(tarPath, 'wx')
	let paxIndex = 0
	try {
		for (const directory of parentDirectories(entries)) {
			paxIndex = await writeTarHeader(
				tar,
				`${directory}/`,
				0o755,
				0,
				'5',
				paxIndex,
			)
		}
		for (const entry of entries) {
			throwIfAborted(signal, 'archive')
			paxIndex = await writeTarHeader(
				tar,
				entry.path,
				entry.mode === '100755' ? 0o755 : 0o644,
				entry.size,
				'0',
				paxIndex,
			)
			if (entry.path === 'zerops.yaml') {
				if (descriptor.bytes.byteLength !== entry.size) {
					throw archiveRejected('archive')
				}
				await writeAll(tar, descriptor.bytes)
			} else {
				onBlobRead?.(entry.path, entry.objectId)
				await writeBlobToTar(
					repositoryDir,
					tar,
					entry,
					credentials,
					signal,
					timeoutMs,
				)
			}
			await writePadding(tar, entry.size)
		}
		await writeAll(tar, new Uint8Array(TAR_BLOCK_BYTES * 2))
	} finally {
		await tar.close()
	}
}

function parentDirectories(entries: TreeEntry[]): string[] {
	const directories = new Set<string>()
	for (const entry of entries) {
		const segments = entry.path.split('/')
		segments.pop()
		let current = ''
		for (const segment of segments) {
			current = current === '' ? segment : `${current}/${segment}`
			directories.add(current)
		}
	}
	return [...directories].sort((left, right) => {
		const depth = left.split('/').length - right.split('/').length
		return depth === 0 ? compareUtf8Paths(left, right) : depth
	})
}

async function writeTarHeader(
	tar: FileHandle,
	path: string,
	mode: number,
	size: number,
	type: '0' | '5',
	paxIndex: number,
): Promise<number> {
	const pathBytes = new TextEncoder().encode(path)
	let headerPath = path
	let nextIndex = paxIndex
	if (pathBytes.byteLength > 100) {
		const payload = paxPathRecord(path)
		const paxName = `PaxHeaders/${paxIndex}`
		await writeAll(tar, tarHeader(paxName, 0o644, payload.byteLength, 'x'))
		await writeAll(tar, payload)
		await writePadding(tar, payload.byteLength)
		headerPath = type === '5' ? `PaxEntry/${paxIndex}/` : `PaxEntry/${paxIndex}`
		nextIndex++
	}
	await writeAll(tar, tarHeader(headerPath, mode, size, type))
	return nextIndex
}

function paxPathRecord(path: string): Uint8Array {
	const body = `path=${path}\n`
	let length = new TextEncoder().encode(body).byteLength + 3
	while (true) {
		const record = `${length} ${body}`
		const bytes = new TextEncoder().encode(record)
		if (bytes.byteLength === length) return bytes
		length = bytes.byteLength
	}
}

function tarHeader(
	path: string,
	mode: number,
	size: number,
	type: '0' | '5' | 'x',
): Uint8Array {
	const header = new Uint8Array(TAR_BLOCK_BYTES)
	writeTarText(header, 0, 100, path)
	writeTarOctal(header, 100, 8, mode)
	writeTarOctal(header, 108, 8, 0)
	writeTarOctal(header, 116, 8, 0)
	writeTarOctal(header, 124, 12, size)
	writeTarOctal(header, 136, 12, 0)
	header.fill(0x20, 148, 156)
	header[156] = type.charCodeAt(0)
	writeTarText(header, 257, 6, 'ustar')
	writeTarText(header, 263, 2, '00')
	let checksum = 0
	for (const byte of header) checksum += byte
	const checksumText = checksum.toString(8).padStart(6, '0')
	writeTarText(header, 148, 6, checksumText)
	header[154] = 0
	header[155] = 0x20
	return header
}

function writeTarText(
	target: Uint8Array,
	offset: number,
	length: number,
	value: string,
): void {
	const bytes = new TextEncoder().encode(value)
	if (bytes.byteLength > length) {
		throw new SourceFailure('archive_rejected', 'archive', false, 422)
	}
	target.set(bytes, offset)
}

function writeTarOctal(
	target: Uint8Array,
	offset: number,
	length: number,
	value: number,
): void {
	const encoded = value.toString(8).padStart(length - 1, '0')
	if (encoded.length >= length) {
		throw new SourceFailure('archive_rejected', 'archive', false, 413)
	}
	writeTarText(target, offset, length - 1, encoded)
	target[offset + length - 1] = 0
}

async function writeBlobToTar(
	repositoryDir: string,
	tar: FileHandle,
	entry: TreeEntry,
	credentials: GitCredentials,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<void> {
	const operation = boundedOperation(signal, timeoutMs)
	const process = spawnGit(
		repositoryDir,
		['cat-file', 'blob', entry.objectId],
		credentials,
		operation.signal,
		'pipe',
		'ignore',
	)
	if (process.stdout === undefined) throw archiveRejected('archive')
	let written = 0
	const reader = process.stdout.getReader()
	try {
		while (true) {
			const result = await reader.read()
			if (result.done) break
			written += result.value.byteLength
			if (written > entry.size) {
				process.kill()
				throw archiveRejected('archive')
			}
			await writeAll(tar, result.value)
		}
		const code = await process.exited
		const interruption = gitInterruption(
			signal,
			operation.timedOut(),
			'archive',
		)
		if (interruption !== undefined) throw interruption
		if (code !== 0 || written !== entry.size) throw archiveRejected('archive')
	} catch (error) {
		process.kill()
		await process.exited
		throw gitFailure(error, signal, operation.timedOut(), 'archive')
	} finally {
		reader.releaseLock()
		operation.close()
	}
}

async function writePadding(tar: FileHandle, size: number): Promise<void> {
	const padding = (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
	if (padding > 0) await writeAll(tar, new Uint8Array(padding))
}

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
	let offset = 0
	while (offset < bytes.byteLength) {
		const result = await file.write(bytes, offset, bytes.byteLength - offset)
		if (result.bytesWritten <= 0) {
			throw new SourceFailure('archive_rejected', 'archive', false, 500)
		}
		offset += result.bytesWritten
	}
}

async function initBare(
	repositoryDir: string,
	signal: AbortSignal,
	stage: RepositoryStage,
	objectFormat: 'sha1' | 'sha256',
	timeoutMs: number,
): Promise<void> {
	await gitFile(
		'',
		[
			'init',
			'--bare',
			'--quiet',
			`--object-format=${objectFormat}`,
			repositoryDir,
		],
		{},
		signal,
		stage,
		timeoutMs,
	)
}

async function fetchRevision(
	repositoryDir: string,
	repositoryUrl: string,
	requestedRef: string,
	credentials: GitCredentials,
	signal: AbortSignal,
	stage: RepositoryStage,
	timeoutMs: number,
): Promise<void> {
	try {
		await gitFile(
			repositoryDir,
			['remote', 'add', 'origin', repositoryUrl],
			credentials,
			signal,
			stage,
			timeoutMs,
		)
		await gitFile(
			repositoryDir,
			['config', 'remote.origin.promisor', 'true'],
			credentials,
			signal,
			stage,
			timeoutMs,
		)
		await gitFile(
			repositoryDir,
			['config', 'remote.origin.partialclonefilter', 'blob:none'],
			credentials,
			signal,
			stage,
			timeoutMs,
		)
		await gitFile(
			repositoryDir,
			[
				'fetch',
				'--quiet',
				'--no-tags',
				'--depth=1',
				'--filter=blob:none',
				'origin',
				requestedRef,
			],
			credentials,
			signal,
			stage,
			timeoutMs,
		)
	} catch (error) {
		if (signal.aborted) throw cancelled(stage)
		if (error instanceof SourceFailure && error.code === 'internal') {
			throw error
		}
		throw new SourceFailure('ref_not_found', stage, false, 404)
	}
}

async function resolvedCommit(
	repositoryDir: string,
	credentials: GitCredentials,
	signal: AbortSignal,
	stage: RepositoryStage,
	timeoutMs: number,
): Promise<string> {
	const value = (
		await gitText(
			repositoryDir,
			['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
			credentials,
			signal,
			128,
			stage,
			timeoutMs,
		)
	).trim()
	if (!OBJECT_ID_PATTERN.test(value)) {
		throw new SourceFailure('ref_not_found', stage, false, 404)
	}
	return value
}

async function gitText(
	repositoryDir: string,
	args: string[],
	credentials: GitCredentials,
	signal: AbortSignal,
	maximumBytes: number,
	stage: RepositoryStage,
	timeoutMs: number,
	stdin: Blob | 'ignore' = 'ignore',
): Promise<string> {
	const bytes = await gitBytes(
		repositoryDir,
		args,
		credentials,
		signal,
		maximumBytes,
		stage,
		timeoutMs,
		stdin,
	)
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw archiveRejected(stage)
	}
}

async function gitBytes(
	repositoryDir: string,
	args: string[],
	credentials: GitCredentials,
	signal: AbortSignal,
	maximumBytes: number,
	stage: RepositoryStage,
	timeoutMs: number,
	stdin: Blob | 'ignore' = 'ignore',
): Promise<Uint8Array> {
	const operation = boundedOperation(signal, timeoutMs)
	const process = spawnGit(
		repositoryDir,
		args,
		credentials,
		operation.signal,
		'pipe',
		stdin,
	)
	if (process.stdout === undefined) throw archiveRejected(stage)
	try {
		const bytes = await readBounded(
			process.stdout,
			maximumBytes,
			() => process.kill(),
			stage,
		)
		const code = await process.exited
		const interruption = gitInterruption(signal, operation.timedOut(), stage)
		if (interruption !== undefined) throw interruption
		if (code !== 0) throw archiveRejected(stage)
		return bytes
	} catch (error) {
		process.kill()
		await process.exited
		throw gitFailure(error, signal, operation.timedOut(), stage)
	} finally {
		operation.close()
	}
}

async function gitFile(
	repositoryDir: string,
	args: string[],
	credentials: GitCredentials,
	signal: AbortSignal,
	stage: RepositoryStage,
	timeoutMs: number,
): Promise<void> {
	const operation = boundedOperation(signal, timeoutMs)
	const process = spawnGit(
		repositoryDir,
		args,
		credentials,
		operation.signal,
		'ignore',
		'ignore',
	)
	try {
		const code = await process.exited
		const interruption = gitInterruption(signal, operation.timedOut(), stage)
		if (interruption !== undefined) throw interruption
		if (code !== 0) throw archiveRejected(stage)
	} catch (error) {
		process.kill()
		await process.exited
		throw gitFailure(error, signal, operation.timedOut(), stage)
	} finally {
		operation.close()
	}
}

function spawnGit(
	repositoryDir: string,
	args: string[],
	credentials: GitCredentials,
	signal: AbortSignal,
	stdout: 'pipe' | 'ignore',
	stdin: Blob | 'ignore',
) {
	const { PATH: configuredPath } = process.env
	const path = configuredPath ?? '/usr/local/bin:/usr/bin:/bin'
	return Bun.spawn(
		[
			'git',
			...(repositoryDir === '' ? [] : ['--git-dir', repositoryDir]),
			...args,
		],
		{
			stdin,
			stdout,
			stderr: 'ignore',
			signal,
			env: gitChildEnvironment(path, credentials.token),
		},
	)
}

/** Build the isolated child environment; repository tokens have no other transport. */
export function gitChildEnvironment(
	path: string,
	token?: string,
): GitChildEnvironment {
	return {
		PATH: path,
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_TERMINAL_PROMPT: '0',
		GIT_OPTIONAL_LOCKS: '0',
		GIT_CONFIG_COUNT: token === undefined ? '1' : '2',
		GIT_CONFIG_KEY_0: 'http.followRedirects',
		GIT_CONFIG_VALUE_0: 'false',
		...(token === undefined
			? {}
			: {
				GIT_CONFIG_KEY_1: 'http.https://github.com/.extraHeader',
				GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`,
			}),
	}
}

function boundedOperation(
	signal: AbortSignal,
	timeoutMs: number,
): { signal: AbortSignal; timedOut(): boolean; close(): void } {
	const timeout = AbortSignal.timeout(timeoutMs)
	const controller = new AbortController()
	for (const source of [signal, timeout]) {
		if (source.aborted) controller.abort()
		else {
			source.addEventListener('abort', () => controller.abort(), {
				once: true,
				signal: controller.signal,
			})
		}
	}
	return {
		signal: controller.signal,
		timedOut: () => timeout.aborted,
		close: () => controller.abort(),
	}
}

function gitInterruption(
	signal: AbortSignal,
	timedOut: boolean,
	stage: RepositoryStage,
): SourceFailure | undefined {
	if (signal.aborted) return cancelled(stage)
	if (timedOut) return new SourceFailure('internal', stage, true, 504)
	return undefined
}

function gitFailure(
	error: unknown,
	signal: AbortSignal,
	timedOut: boolean,
	stage: RepositoryStage,
): SourceFailure {
	const interruption = gitInterruption(signal, timedOut, stage)
	if (interruption !== undefined) return interruption
	if (error instanceof SourceFailure) return error
	return new SourceFailure('internal', stage, true, 500)
}

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	maximumBytes: number,
	stop: () => void,
	stage: RepositoryStage,
): Promise<Uint8Array> {
	const reader = stream.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const result = await reader.read()
			if (result.done) break
			total += result.value.byteLength
			if (total > maximumBytes) {
				stop()
				throw new SourceFailure('archive_rejected', stage, false, 413)
			}
			chunks.push(result.value)
		}
	} finally {
		reader.releaseLock()
	}
	const output = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		output.set(chunk, offset)
		offset += chunk.byteLength
	}
	return output
}

function splitNull(output: string): string[] {
	const entries = output.split('\0')
	if (entries.at(-1) === '') entries.pop()
	return entries
}

function archiveRejected(stage: RepositoryStage): SourceFailure {
	return new SourceFailure('archive_rejected', stage, false, 422)
}
