import { AUTH_HANDOFF_CHALLENGE_PARAM, AUTH_HANDOFF_STATE_PARAM, FABRIKA_COOKIE_PREFIX, HANDOFF_COOKIE_PREFIX } from '@fabrika/auth-core'

const HANDOFF_VALUE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

export interface HandoffAttempt {
	state: string
	verifier: string
	challenge: string
}

/** Create the browser-held verifier and the public values IAM carries through the login. */
export async function createHandoffAttempt(): Promise<HandoffAttempt> {
	const state = randomToken(16)
	const verifier = randomToken(32)
	return { state, verifier, challenge: await handoffChallenge(verifier) }
}

/** S256, matching PKCE: the verifier never rides in a URL or reaches IAM through the browser. */
export async function handoffChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
	return base64url(new Uint8Array(digest))
}

/** Return the dynamic `__Host-` cookie name for a validated public state. */
export function handoffCookieName(state: string | null): string | null {
	return state !== null && HANDOFF_VALUE_PATTERN.test(state) ? `${HANDOFF_COOKIE_PREFIX}${state}` : null
}

/** Add the public handoff coordinates to IAM's login URL. */
export function setHandoffParams(url: URL, attempt: HandoffAttempt): void {
	url.searchParams.set(AUTH_HANDOFF_STATE_PARAM, attempt.state)
	url.searchParams.set(AUTH_HANDOFF_CHALLENGE_PARAM, attempt.challenge)
}

/** Keep application cookies, but never expose a Fabrika bearer credential to the upstream app. */
export function stripFabrikaCookies(headers: Headers): void {
	const raw = headers.get('Cookie')
	if (raw === null) return
	const kept = raw.split(';').map((part) => part.trim()).filter((part) => {
		const separator = part.indexOf('=')
		const name = separator === -1 ? part : part.slice(0, separator).trim()
		return !name.startsWith(FABRIKA_COOKIE_PREFIX)
	})
	if (kept.length === 0) {
		headers.delete('Cookie')
	} else {
		headers.set('Cookie', kept.join('; '))
	}
}

function randomToken(bytes: number): string {
	const value = new Uint8Array(bytes)
	crypto.getRandomValues(value)
	return base64url(value)
}

function base64url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
