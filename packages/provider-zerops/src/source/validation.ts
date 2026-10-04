import {
	COMMIT_SHA_PATTERN,
	GITHUB_OWNER_PATTERN,
	GITHUB_REPOSITORY_PATTERN,
	ID_PATTERN,
	MAX_ID_LENGTH,
	MAX_REF_LENGTH,
	MAX_UPLOAD_URL_LENGTH,
	SHA256_PATTERN,
	ZEROPS_SOURCE_PROTOCOL_VERSION,
	ZEROPS_SOURCE_PROTOCOL_VERSION_V2,
} from './constants'
import type { ZeropsSourceDescriptor, ZeropsSourcePrivateBindingV2, ZeropsSourceRepository } from './types'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const record = (value: unknown, label: string): Record<string, unknown> => {
	if (!isRecord(value)) throw new Error(`${label} must be an object`)
	return value
}

export const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
	const allowedKeys = new Set(allowed)
	const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key))
	if (unknownKey !== undefined) throw new Error(`${label} contains an unknown field`)
	const missingKey = allowed.find((key) => !(key in value))
	if (missingKey !== undefined) throw new Error(`${label} is missing field ${missingKey}`)
}

export const protocolVersion = (value: Record<string, unknown>, label: string): typeof ZEROPS_SOURCE_PROTOCOL_VERSION => {
	if (value['protocolVersion'] !== ZEROPS_SOURCE_PROTOCOL_VERSION) throw new Error(`${label} has an unsupported protocolVersion`)
	return ZEROPS_SOURCE_PROTOCOL_VERSION
}

export const protocolVersionV2 = (value: Record<string, unknown>, label: string): typeof ZEROPS_SOURCE_PROTOCOL_VERSION_V2 => {
	if (value['protocolVersion'] !== ZEROPS_SOURCE_PROTOCOL_VERSION_V2) throw new Error(`${label} has an unsupported protocolVersion`)
	return ZEROPS_SOURCE_PROTOCOL_VERSION_V2
}

export const boundedString = (value: unknown, label: string, maximum: number): string => {
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
		throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`)
	}
	return value
}

export const identifier = (value: unknown, label: string): string => {
	const parsed = boundedString(value, label, MAX_ID_LENGTH)
	if (!ID_PATTERN.test(parsed)) throw new Error(`${label} contains invalid characters`)
	return parsed
}

export const ref = (value: unknown, label: string): string => {
	const parsed = boundedString(value, label, MAX_REF_LENGTH)
	if (COMMIT_SHA_PATTERN.test(parsed)) return parsed
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
	) {
		throw new Error(`${label} must be a safe Git ref or lowercase commit digest`)
	}
	return parsed
}

export const commitSha = (value: unknown, label: string): string => {
	if (typeof value !== 'string' || !COMMIT_SHA_PATTERN.test(value)) throw new Error(`${label} must be a lowercase 40- or 64-character hex digest`)
	return value
}

export const sha256 = (value: unknown, label: string): string => {
	if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase 64-character hex digest`)
	return value
}

export const installationId = (value: unknown, label: string): number => {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`)
	return value
}

export const optionalCommitSha = (value: unknown, label: string): string | undefined => value === undefined ? undefined : commitSha(value, label)

export const optionalInstallationId = (value: unknown, label: string): number | undefined =>
	value === undefined ? undefined : installationId(value, label)

const privateBindingV2 = (value: unknown, label: string): ZeropsSourcePrivateBindingV2 => {
	const parsed = record(value, label)
	exactKeys(parsed, ['connectionId', 'installationId'], label)
	return {
		connectionId: identifier(parsed['connectionId'], `${label}.connectionId`),
		installationId: installationId(parsed['installationId'], `${label}.installationId`),
	}
}

export const optionalPrivateBindingV2 = (value: unknown, label: string): ZeropsSourcePrivateBindingV2 | undefined =>
	value === undefined ? undefined : privateBindingV2(value, label)

export const repository = (value: unknown, label: string): ZeropsSourceRepository => {
	const parsed = record(value, label)
	exactKeys(parsed, ['owner', 'name'], label)
	const owner = boundedString(parsed['owner'], `${label}.owner`, 39)
	const name = boundedString(parsed['name'], `${label}.name`, 100)
	if (!GITHUB_OWNER_PATTERN.test(owner)) throw new Error(`${label}.owner must be a normalized lowercase GitHub owner`)
	if (!GITHUB_REPOSITORY_PATTERN.test(name) || name === '.' || name === '..') {
		throw new Error(`${label}.name must be a normalized lowercase GitHub repository name`)
	}
	return { owner, name }
}

export const descriptor = (value: unknown, label: string): ZeropsSourceDescriptor => {
	const parsed = record(value, label)
	exactKeys(parsed, ['path', 'sha256'], label)
	if (parsed['path'] !== 'zerops.yaml') throw new Error(`${label}.path must be zerops.yaml`)
	return { path: 'zerops.yaml', sha256: sha256(parsed['sha256'], `${label}.sha256`) }
}

export const optionalFields = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void => {
	const allowed = [...required, ...optional]
	const unknownKey = Object.keys(value).find((key) => !allowed.includes(key))
	if (unknownKey !== undefined) throw new Error(`${label} contains an unknown field`)
	const missingKey = required.find((key) => !(key in value))
	if (missingKey !== undefined) throw new Error(`${label} is missing field ${missingKey}`)
	for (const key of optional) {
		if (key in value && value[key] === undefined) throw new Error(`${label}.${key} must be omitted instead of undefined`)
	}
}

/** Validate only credential-safe URL structure; the source runtime owns the exact Zerops destination allowlist. */
export const uploadUrl = (value: unknown, label: string): string => {
	const candidate = boundedString(value, label, MAX_UPLOAD_URL_LENGTH)
	if (/\s/u.test(candidate) || candidate.includes('#')) throw new Error(`${label} must be a signed HTTPS URL`)
	let parsed: URL
	try {
		parsed = new URL(candidate)
	} catch {
		throw new Error(`${label} must be a signed HTTPS URL`)
	}
	if (
		parsed.protocol !== 'https:'
		|| parsed.username !== ''
		|| parsed.password !== ''
		|| parsed.hash !== ''
		|| parsed.search === ''
	) {
		throw new Error(`${label} must be a signed HTTPS URL without userinfo or fragment`)
	}
	return candidate
}

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
