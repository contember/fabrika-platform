import { z } from 'zod'
import { configurationError, responseError } from './errors'
import type { GitHubCommit, GitHubComparison, GitHubPullRequestRef, GitHubRef, GitHubTreeEntry } from './repository-types'
import { hasAsciiControl } from './validation'

export const MAX_TREE_ENTRIES = 5000
export const MAX_TREE_RESPONSE_BYTES = 8 * 1024 * 1024
export const MAX_READ_PATHS = 100
export const MAX_FILE_BYTES = 512 * 1024
export const MAX_READ_BYTES = 2 * 1024 * 1024
// Base64 inflates a blob by 4/3 and GitHub wraps it in lines.
export const MAX_BLOB_RESPONSE_BYTES = 1024 * 1024
export const MAX_CHANGED_FILES = 256
export const MAX_CHANGED_BYTES = 2 * 1024 * 1024
export const MAX_COMMIT_MESSAGE_BYTES = 16 * 1024
export const MAX_PULL_REQUEST_TITLE_BYTES = 1024
export const MAX_PULL_REQUEST_BODY_BYTES = 64 * 1024
// A pull request echoes its body plus full head and base repository objects.
export const MAX_PULL_REQUEST_RESPONSE_BYTES = 1024 * 1024
// A commit echoes its message, which existing history does not bound.
export const MAX_COMMIT_RESPONSE_BYTES = 1024 * 1024
export const MAX_PATH_SEGMENTS = 64
/** GitHub's own bound on the files of one comparison. */
export const MAX_COMPARE_FILES = 300
// Each file of a comparison carries its patch.
export const MAX_COMPARE_RESPONSE_BYTES = 8 * 1024 * 1024

const SHA_PATTERN = /^[a-f0-9]{40}$/
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

export function validateSha(value: string): void {
	if (!SHA_PATTERN.test(value)) throw configurationError()
}

/** A subset of `git check-ref-format` that is safe to place in a URL path segment by segment. */
export function validateBranch(value: string): void {
	if (
		value.length === 0 || value.length > 200 || value === '@' || value.startsWith('-') || value.includes('..') || value.includes('@{')
		|| hasAsciiControl(value) || /[\s~^:?*[\\]/.test(value)
		|| value.split('/').some((part) => part.length === 0 || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
	) throw configurationError()
}

/** Repository-relative path: no leading, trailing or doubled slash, no `.`/`..` segment, never inside `.git`. */
export function validatePath(value: string): void {
	if (
		value.length === 0 || value.length > 1024 || hasAsciiControl(value) || value.includes('\\') || LONE_SURROGATE_PATTERN.test(value)
		|| value.split('/').length > MAX_PATH_SEGMENTS
		|| value.split('/').some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')
	) throw configurationError()
}

export function validateText(value: string, maxBytes: number, allowEmpty: boolean): void {
	if (
		(!allowEmpty && value.trim().length === 0) || value.includes('\0') || LONE_SURROGATE_PATTERN.test(value)
		|| utf8Length(value) > maxBytes
	) throw configurationError()
}

export function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

export function encodeBranch(branch: string): string {
	return branch.split('/').map(encodeURIComponent).join('/')
}

const shaSchema = z.string().regex(SHA_PATTERN)

const refSchema = z.object({ ref: z.string(), object: z.object({ type: z.literal('commit'), sha: shaSchema }) })

export function decodeRef(body: unknown, branch: string): GitHubRef {
	const result = refSchema.safeParse(body)
	if (!result.success || result.data.ref !== `refs/heads/${branch}`) throw responseError()
	return { branch, sha: result.data.object.sha }
}

const commitSchema = z.object({
	sha: shaSchema,
	tree: z.object({ sha: shaSchema }),
	parents: z.array(z.object({ sha: shaSchema })).max(100),
})

export function decodeCommit(body: unknown): GitHubCommit {
	const result = commitSchema.safeParse(body)
	if (!result.success) throw responseError()
	return { sha: result.data.sha, treeSha: result.data.tree.sha, parents: result.data.parents.map((parent) => parent.sha) }
}

const treeEntrySchema = z.union([
	z.object({ path: z.string(), sha: shaSchema, type: z.literal('tree'), mode: z.literal('040000') }),
	z.object({
		path: z.string(),
		sha: shaSchema,
		type: z.literal('blob'),
		mode: z.enum(['100644', '100755', '120000']),
		size: z.number().int().nonnegative(),
	}),
	z.object({ path: z.string(), sha: shaSchema, type: z.literal('commit'), mode: z.literal('160000') }),
])

const treeSchema = z.object({ sha: shaSchema, tree: z.array(treeEntrySchema), truncated: z.boolean() })

export interface DecodedTree {
	readonly entries: readonly GitHubTreeEntry[]
	readonly truncated: boolean
}

/** A tree read by `<commit>:<path>`, whose own sha the request did not name. */
export function decodeTreeListing(body: unknown): DecodedTree {
	const result = treeSchema.safeParse(body)
	if (!result.success) throw responseError()
	return { entries: result.data.tree, truncated: result.data.truncated }
}

const createdTreeSchema = z.object({ sha: shaSchema })

export function decodeCreatedTreeSha(body: unknown): string {
	const result = createdTreeSchema.safeParse(body)
	if (!result.success) throw responseError()
	return result.data.sha
}

const blobSchema = z.object({ sha: shaSchema, size: z.number().int().nonnegative(), encoding: z.literal('base64'), content: z.string() })

/** The blob's bytes as UTF-8 text, or null when they are not valid UTF-8. */
export function decodeTextBlob(body: unknown, expectedSha: string, expectedSize: number): string | null {
	const result = blobSchema.safeParse(body)
	if (!result.success || result.data.sha !== expectedSha || result.data.size !== expectedSize) throw responseError()
	let binary: string
	try {
		binary = atob(result.data.content.replace(/\r?\n/g, ''))
	} catch {
		throw responseError()
	}
	if (binary.length !== expectedSize) throw responseError()
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
	} catch {
		return null
	}
}

const comparisonSchema = z.object({
	ahead_by: z.number().int().nonnegative(),
	behind_by: z.number().int().nonnegative(),
	merge_base_commit: z.object({ sha: shaSchema }),
	files: z.array(z.object({
		filename: z.string(),
		previous_filename: z.string().optional(),
		status: z.enum(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']),
		additions: z.number().int().nonnegative(),
		deletions: z.number().int().nonnegative(),
		patch: z.string().optional(),
	})).max(MAX_COMPARE_FILES).optional(),
})

export function decodeComparison(body: unknown, headSha: string): GitHubComparison {
	const result = comparisonSchema.safeParse(body)
	if (!result.success) throw responseError()
	const files = (result.data.files ?? []).map((file) => ({
		path: file.filename,
		previousPath: file.previous_filename ?? null,
		status: file.status,
		additions: file.additions,
		deletions: file.deletions,
		patch: file.patch ?? null,
	}))
	return {
		baseSha: result.data.merge_base_commit.sha,
		headSha,
		aheadBy: result.data.ahead_by,
		behindBy: result.data.behind_by,
		files,
		filesCapped: files.length === MAX_COMPARE_FILES,
	}
}

const pullRequestSchema = z.object({ number: z.number().int().positive(), html_url: z.string().url() })

export function decodePullRequest(body: unknown, created: boolean): GitHubPullRequestRef {
	const result = pullRequestSchema.safeParse(body)
	if (!result.success) throw responseError()
	return { number: result.data.number, url: result.data.html_url, created }
}

export function decodePullRequestList(body: unknown): unknown[] {
	const result = z.array(z.unknown()).max(100).safeParse(body)
	if (!result.success) throw responseError()
	return result.data
}
