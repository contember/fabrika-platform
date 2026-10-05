import { z } from 'zod'
import {
	COMMIT_SHA_PATTERN,
	GITHUB_OWNER_PATTERN,
	GITHUB_REPOSITORY_PATTERN,
	ID_PATTERN,
	MAX_ID_LENGTH,
	MAX_REF_LENGTH,
	MAX_UPLOAD_URL_LENGTH,
	SHA256_PATTERN,
} from './constants'
import type { ZeropsSourceRepository } from './types'

// Default Zod diagnostics can include rejected values and unknown keys, both of which may be secrets.
export function parseSourceWire<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, label: string): T {
	const result = schema.safeParse(value)
	if (result.success) return result.data
	if (result.error.issues.some((issue) => issue.code === 'unrecognized_keys')) throw new Error(`${label} contains an unknown field`)
	const domainIssue = result.error.issues.find((issue) => issue.code === 'custom')
	throw new Error(`${label}: ${domainIssue?.message ?? 'invalid wire value'}`)
}

export const identifierSchema = z.string().min(1).max(MAX_ID_LENGTH).regex(ID_PATTERN)
export const commitShaSchema = z.string().regex(COMMIT_SHA_PATTERN)
export const sha256Schema = z.string().regex(SHA256_PATTERN)
export const installationIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const repositorySchema = z.object({
	owner: z.string().min(1).max(39).regex(GITHUB_OWNER_PATTERN),
	name: z.string().min(1).max(100).regex(GITHUB_REPOSITORY_PATTERN).refine((name) => name !== '.' && name !== '..', 'invalid repository name'),
}).strict()
export const descriptorSchema = z.object({ path: z.literal('zerops.yaml'), sha256: sha256Schema }).strict()
export const privateBindingV2Schema = z.object({ connectionId: identifierSchema, installationId: installationIdSchema }).strict()

export const rejectExplicitUndefined = (value: object, context: z.RefinementCtx): void => {
	if (Object.values(value).some((entry) => entry === undefined)) {
		context.addIssue({ code: 'custom', message: 'optional fields must be omitted instead of undefined' })
	}
}

export const identifier = (value: unknown, label: string): string => parseSourceWire(identifierSchema, value, label)

export const refSchema = z.string().min(1).max(MAX_REF_LENGTH).refine((parsed) => {
	if (COMMIT_SHA_PATTERN.test(parsed)) return true
	const hasForbiddenCharacter = [...parsed].some((character) => {
		const code = character.charCodeAt(0)
		return code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character)
	})
	const components = parsed.split('/')
	if (
		parsed.startsWith('-')
		|| parsed.trim() !== parsed
		|| parsed === '@'
		|| parsed.includes('..')
		|| parsed.includes('@{')
		|| parsed.includes('//')
		|| parsed.endsWith('/')
		|| parsed.endsWith('.')
		|| hasForbiddenCharacter
		|| components.some((component) => component === '' || component.startsWith('.') || component.endsWith('.lock'))
	) return false
	return true
}, 'must be a safe Git ref or lowercase commit digest')

export const repository = (value: unknown, label: string): ZeropsSourceRepository => parseSourceWire(repositorySchema, value, label)

/** Validate only credential-safe URL structure; the source runtime owns the exact Zerops destination allowlist. */
export const uploadUrlSchema = z.string().min(1).max(MAX_UPLOAD_URL_LENGTH).refine((candidate) => {
	if (/\s/u.test(candidate) || candidate.includes('#')) return false
	let parsed: URL
	try {
		parsed = new URL(candidate)
	} catch {
		return false
	}
	if (
		parsed.protocol !== 'https:'
		|| parsed.username !== ''
		|| parsed.password !== ''
		|| parsed.hash !== ''
		|| parsed.search === ''
	) return false
	return true
}, 'must be a signed HTTPS URL without userinfo or fragment')

export const isZeropsUploadDestination = (value: string): boolean => {
	if (!value.startsWith('https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?')) return false
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return false
	}
	return url.protocol === 'https:'
		&& url.hostname === 'proxy.app-prg1.zerops.io'
		&& url.pathname === '/api/rest/object-storage/upload'
		&& url.username === ''
		&& url.password === ''
		&& url.port === ''
		&& url.hash === ''
		&& url.search !== ''
}

export function normalizeZeropsSourceRepository(repoUrl: string): ZeropsSourceRepository {
	if (/\s/u.test(repoUrl) || /\p{Cc}/u.test(repoUrl)) {
		throw new Error('source repository URL must be a canonical GitHub repository URL')
	}
	const candidate = repoUrl.startsWith('github.com/') ? `https://${repoUrl}` : repoUrl
	let parsed: URL
	try {
		parsed = new URL(candidate)
	} catch {
		throw new Error('source repository URL must be a canonical GitHub repository URL')
	}
	if (
		parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port !== '' || parsed.username !== '' || parsed.password !== ''
		|| parsed.search !== '' || parsed.hash !== ''
	) {
		throw new Error('source repository URL must be an HTTPS GitHub URL without credentials, port, query, or fragment')
	}
	const segments = parsed.pathname.split('/')
	if (segments.length !== 3 || segments[0] !== '') throw new Error('source repository URL must identify one GitHub repository')
	const owner = segments[1]
	const rawName = segments[2]
	if (owner === undefined || rawName === undefined) throw new Error('source repository URL must identify one GitHub repository')
	const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName
	return repository({ owner: owner.toLowerCase(), name: name.toLowerCase() }, 'source repository')
}
