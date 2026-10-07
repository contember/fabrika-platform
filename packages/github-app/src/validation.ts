import { z } from 'zod'
import { configurationError } from './errors'
import type { GitHubAppIdentity, GitHubAppWebhookConfig } from './types'

const REPOSITORY_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]+$/
export const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/

export const appReferenceSchema = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	slug: z.string().regex(APP_SLUG_PATTERN),
	html_url: z.string(),
})

const appIdentitySchema = appReferenceSchema.extend({
	// Strict for least privilege: an App granted any permission beyond read-only contents is refused.
	permissions: z.object({ contents: z.literal('read'), metadata: z.literal('read').optional() }).strict(),
	events: z.array(z.string().min(1).max(100)).max(100).refine((events) => events.includes('push')),
	owner: z.object({ login: z.string().min(1).max(100).regex(REPOSITORY_COMPONENT_PATTERN), type: z.enum(['Organization', 'User']) }),
})

const webhookConfigSchema = z.object({
	url: z.string(),
	content_type: z.enum(['json', 'form']),
	insecure_ssl: z.union([z.literal('0'), z.literal('1'), z.literal(0), z.literal(1)]),
})

export const installationSchema = z.object({
	id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	app_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	target_type: z.enum(['Organization', 'User']),
	account: z.object({ login: z.string(), type: z.enum(['Organization', 'User']) }),
	repository_selection: z.enum(['all', 'selected']),
})

export const installationTokenSchema = z.object({
	token: z.string().min(1).max(4096).refine((token) => !/\s/.test(token)),
	expires_at: z.string().transform((value) => Date.parse(value)),
})

export function normalizeApiBaseUrl(value: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw configurationError()
	}
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
		throw configurationError()
	}
	return url.toString().replace(/\/$/, '')
}

export function validateRepositoryComponent(value: string): void {
	if (value.length === 0 || value.length > 100 || !REPOSITORY_COMPONENT_PATTERN.test(value) || value === '.' || value === '..') {
		throw configurationError()
	}
}

export function normalizeWebhookUrl(value: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw configurationError()
	}
	if (
		url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname === ''
	) {
		throw configurationError()
	}
	return url.toString()
}

export function validateWebhookSecret(value: string): void {
	if (value.length === 0 || value.length > 4096 || hasAsciiControl(value)) throw configurationError()
}

export function decodeAppIdentity(value: unknown): Omit<GitHubAppIdentity, 'public'> | null {
	const result = appIdentitySchema.safeParse(value)
	if (!result.success) return null
	const { id, slug, html_url: htmlUrl, permissions: { contents }, events, owner: { login, type } } = result.data
	let parsedHtmlUrl: URL
	try {
		parsedHtmlUrl = new URL(htmlUrl)
	} catch {
		return null
	}
	if (
		parsedHtmlUrl.protocol !== 'https:' || parsedHtmlUrl.hostname !== 'github.com' || parsedHtmlUrl.port !== ''
		|| parsedHtmlUrl.username !== '' || parsedHtmlUrl.password !== '' || parsedHtmlUrl.search !== '' || parsedHtmlUrl.hash !== ''
		|| parsedHtmlUrl.pathname !== `/apps/${slug}`
	) {
		return null
	}
	return { id, slug, htmlUrl, permissions: { contents }, events, owner: { login, type } }
}

export function sameAppIdentity(
	left: Omit<GitHubAppIdentity, 'public'>,
	right: Omit<GitHubAppIdentity, 'public'>,
): boolean {
	return left.id === right.id && left.slug === right.slug && left.htmlUrl === right.htmlUrl
		&& left.owner.login === right.owner.login && left.owner.type === right.owner.type
		&& left.events.length === right.events.length && left.events.every((event, index) => event === right.events[index])
}

export function decodeWebhookConfig(value: unknown): GitHubAppWebhookConfig | null {
	const result = webhookConfigSchema.safeParse(value)
	if (!result.success) return null
	const { url, content_type: contentType, insecure_ssl: insecureSsl } = result.data
	let normalized: string
	try {
		normalized = normalizeWebhookUrl(url)
	} catch {
		return null
	}
	if (normalized !== url) return null
	return { url, contentType, insecureSsl: String(insecureSsl) === '0' ? '0' : '1' }
}

export function hasAsciiControl(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 32 || code === 127) return true
	}
	return false
}

export function isPositiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0
}
