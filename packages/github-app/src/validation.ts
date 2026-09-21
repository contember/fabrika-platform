import { configurationError } from './errors'
import type { GitHubAppIdentity, GitHubAppWebhookConfig } from './types'

const REPOSITORY_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]+$/
export const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/

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
	const id = objectField(value, 'id')
	const slug = objectField(value, 'slug')
	const htmlUrl = objectField(value, 'html_url')
	const permissions = objectField(value, 'permissions')
	const contents = objectField(permissions, 'contents')
	const events = objectField(value, 'events')
	const owner = objectField(value, 'owner')
	const login = objectField(owner, 'login')
	const type = objectField(owner, 'type')
	if (
		typeof id !== 'number' || !isPositiveSafeInteger(id) || typeof slug !== 'string' || !APP_SLUG_PATTERN.test(slug)
		|| typeof htmlUrl !== 'string' || typeof login !== 'string' || login.length === 0 || login.length > 100
		|| !REPOSITORY_COMPONENT_PATTERN.test(login) || (type !== 'Organization' && type !== 'User')
		|| contents !== 'read' || !hasExactAppPermissions(permissions) || !isStringArray(events) || !events.includes('push')
	) {
		return null
	}
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
	const url = objectField(value, 'url')
	const contentType = objectField(value, 'content_type')
	const insecureSsl = objectField(value, 'insecure_ssl')
	if (typeof url !== 'string' || (contentType !== 'json' && contentType !== 'form')) return null
	let normalized: string
	try {
		normalized = normalizeWebhookUrl(url)
	} catch {
		return null
	}
	if (normalized !== url) return null
	if (insecureSsl !== '0' && insecureSsl !== '1' && insecureSsl !== 0 && insecureSsl !== 1) return null
	return { url, contentType, insecureSsl: String(insecureSsl) === '0' ? '0' : '1' }
}

export function hasAsciiControl(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 32 || code === 127) return true
	}
	return false
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 100)
}

function hasExactAppPermissions(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || objectField(value, 'contents') !== 'read') return false
	const keys = Object.keys(value)
	if (keys.some((key) => key !== 'contents' && key !== 'metadata')) return false
	const metadata = objectField(value, 'metadata')
	return metadata === undefined || metadata === 'read'
}

export function isPositiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0
}

export function objectField(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}
