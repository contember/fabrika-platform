// The source maps of a build, found on disk and uploaded to Operations with the run-scoped credential Control minted
// (backlog 36). The Cloudflare runner uploads what its checkout holds; a Zerops build runs `fabrika-source-maps`.

import {
	OPERATIONS_ARTIFACT_HEADERS,
	type OperationsArtifactUploadConfiguration,
	type OperationsAssetRoot,
	type OperationsSourceMapUploadState,
} from '@fabrika/operations-contract/releases'
import { stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { z } from 'zod'

/** Operations' own limits (`artifact-upload.ts`): a larger map or one past the run's budget is refused there. */
export const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024
export const MAX_SOURCE_MAPS = 256
export const MAX_SOURCE_MAP_TOTAL_BYTES = 64 * 1024 * 1024

/** One upload request may take this long; a build must not wait out its pipeline limit on an unreachable Operations. */
const UPLOAD_TIMEOUT_MS = 30_000

export interface SourceMapArtifact {
	logicalPath: string
	digest: string
	body: ArrayBuffer
}

export interface SourceMapCollection {
	artifacts: SourceMapArtifact[]
	/** A map was skipped: over a limit, or without a logical path. */
	incomplete: boolean
}

export type ArtifactFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface SourceMapUploadResult {
	uploaded: number
	state: OperationsSourceMapUploadState
}

const IGNORED_SEGMENTS = new Set(['node_modules', '.git'])

/** Adds the map at `path` when it fits the limits and has a logical path, else marks the collection incomplete; answers the bytes admitted so far. */
async function admit(
	collection: SourceMapCollection,
	totalBytes: number,
	path: string,
	logicalPath: (raw: string) => string | null,
): Promise<number> {
	if (collection.artifacts.length >= MAX_SOURCE_MAPS) {
		collection.incomplete = true
		return totalBytes
	}
	const file = Bun.file(path)
	if (file.size > MAX_SOURCE_MAP_BYTES || totalBytes + file.size > MAX_SOURCE_MAP_TOTAL_BYTES) {
		collection.incomplete = true
		return totalBytes
	}
	const body = await file.arrayBuffer()
	const logical = logicalPath(new TextDecoder().decode(body))
	if (logical === null) {
		collection.incomplete = true
		return totalBytes
	}
	collection.artifacts.push({ logicalPath: logical, digest: await digest(body), body })
	return totalBytes + file.size
}

async function* mapsUnder(dir: string): AsyncGenerator<string> {
	const glob = new Bun.Glob('**/*.map')
	for await (const relativePath of glob.scan({ cwd: dir, dot: false, onlyFiles: true, followSymlinks: false })) {
		if (relativePath.split('/').some((part) => IGNORED_SEGMENTS.has(part))) continue
		yield relativePath
	}
}

/** Every `*.map` of a checkout, at the logical path its own `file` field names (the Cloudflare runner). */
export async function collectSourceMaps(cwd: string): Promise<SourceMapCollection> {
	const collection: SourceMapCollection = { artifacts: [], incomplete: false }
	let totalBytes = 0
	for await (const relativePath of mapsUnder(cwd)) {
		totalBytes = await admit(collection, totalBytes, `${cwd}/${relativePath}`, (raw) => sourceMapLogicalPath(raw, relativePath))
	}
	return collection
}

/**
 * Every `*.map` under each asset root, at the URL path of the file it maps: `<prefix>/<path under dir>` without its
 * `.map`, as the browser names that file in a stack frame. A root outside `root` is skipped as incomplete.
 */
export async function collectAssetSourceMaps(root: string, assetRoots: readonly OperationsAssetRoot[]): Promise<SourceMapCollection> {
	const collection: SourceMapCollection = { artifacts: [], incomplete: false }
	let totalBytes = 0
	const base = resolve(root)
	for (const assetRoot of assetRoots) {
		const dir = resolve(base, assetRoot.dir)
		if (dir !== base && !dir.startsWith(`${base}${sep}`)) {
			collection.incomplete = true
			continue
		}
		if (!(await directoryExists(dir))) continue
		for await (const relativePath of mapsUnder(dir)) {
			const served = `${assetRoot.prefix.replace(/\/+$/, '')}/${relative(dir, resolve(dir, relativePath)).split(sep).join('/')}`
			const logical = normalizedLogicalPath(served.slice(0, -'.map'.length))
			totalBytes = await admit(collection, totalBytes, resolve(dir, relativePath), () => logical)
		}
	}
	return collection
}

async function directoryExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory()
	} catch {
		return false
	}
}

/**
 * Upload each map with the run's bearer. A refused or failed upload leaves the state incomplete and never throws, so a
 * deploy succeeds without its maps; nothing about the request, the bearer included, is printed.
 */
export async function uploadSourceMaps(
	destination: OperationsArtifactUploadConfiguration,
	collection: SourceMapCollection,
	fetch: ArtifactFetch,
): Promise<SourceMapUploadResult> {
	let uploaded = 0
	let incomplete = collection.incomplete
	try {
		for (const artifact of collection.artifacts) {
			const response = await fetch(destination.url, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${destination.bearer}`,
					'content-type': 'application/json',
					[OPERATIONS_ARTIFACT_HEADERS.appId]: destination.appId,
					[OPERATIONS_ARTIFACT_HEADERS.environment]: destination.environment,
					[OPERATIONS_ARTIFACT_HEADERS.serviceKey]: destination.serviceKey,
					[OPERATIONS_ARTIFACT_HEADERS.release]: destination.release,
					[OPERATIONS_ARTIFACT_HEADERS.runId]: destination.runId,
					[OPERATIONS_ARTIFACT_HEADERS.logicalPath]: artifact.logicalPath,
					[OPERATIONS_ARTIFACT_HEADERS.digest]: artifact.digest,
				},
				body: artifact.body,
				signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			})
			if (response.ok) uploaded++
			else incomplete = true
			await response.body?.cancel().catch(() => {})
		}
	} catch {
		incomplete = true
	}
	return { uploaded, state: incomplete ? 'incomplete' : 'complete' }
}

const sourceMapFileSchema = z.object({ file: z.string().min(1) })

function sourceMapLogicalPath(raw: string, mapPath: string): string | null {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		return null
	}
	const parsed = sourceMapFileSchema.safeParse(value)
	if (!parsed.success) return null
	const { file } = parsed.data
	const explicitlyRooted = file.startsWith('/') || file.startsWith('~/') || URL.canParse(file)
	if (!explicitlyRooted && !file.includes('/') && mapPath.includes('/')) {
		// A nested map with only `file: "app.js"` does not reveal its public build root.
		// Guessing from the filesystem path would reintroduce basename collisions.
		return null
	}
	let path = file
	try {
		path = new URL(file).pathname
	} catch {
		const query = path.indexOf('?')
		if (query !== -1) path = path.slice(0, query)
		const hash = path.indexOf('#')
		if (hash !== -1) path = path.slice(0, hash)
	}
	return normalizedLogicalPath(path)
}

/** Operations' `logicalAssetPath` of a URL path: no leading slash, no empty, `.` or `..` segment. */
function normalizedLogicalPath(path: string): string | null {
	const parts = path.replaceAll('\\', '/').replace(/^~?\//, '').split('/').filter((part) => part !== '' && part !== '.')
	if (parts.length === 0 || parts.some((part) => part === '..')) return null
	return parts.join('/')
}

async function digest(body: ArrayBuffer): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
