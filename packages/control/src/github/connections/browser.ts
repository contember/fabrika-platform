import { GITHUB_SETUP_OUTCOME_PARAM, type GitHubSetupOutcome } from '@fabrika/control-contract'
import { randomToken } from './context'
import { type HandoffOutcome, handoffRefusalHtml, handoffResultCsp, handoffResultHtml } from './handoff-page'

const NONCE_BYTES = 16

/** The console page every GitHub browser route returns to. */
export const SOURCE_SETTINGS_PATH = '/settings/source'

export function consoleRedirect(outcome?: GitHubSetupOutcome): Response {
	return cleanRedirect(outcome === undefined ? SOURCE_SETTINGS_PATH : `${SOURCE_SETTINGS_PATH}?${GITHUB_SETUP_OUTCOME_PARAM}=${outcome}`)
}

export function cleanRedirect(location: string): Response {
	return new Response(null, {
		status: 303,
		headers: {
			'cache-control': 'no-store',
			location,
			'referrer-policy': 'no-referrer',
		},
	})
}

/** What a handoff route answers the owner instead of sending them to a console they cannot open. */
export function handoffResult(outcome: HandoffOutcome, randomBytes?: (length: number) => Uint8Array): Response {
	const nonce = randomToken(NONCE_BYTES, randomBytes)
	return secureHtml(handoffResultHtml(outcome, nonce), handoffResultCsp(nonce))
}

/** A handoff route's refusal, as a page with the refusal's status. */
export function handoffRefusal(status: number, randomBytes?: (length: number) => Uint8Array): Response {
	const nonce = randomToken(NONCE_BYTES, randomBytes)
	const page = secureHtml(handoffRefusalHtml(status, nonce), handoffResultCsp(nonce))
	return new Response(page.body, { status, headers: page.headers })
}

export function secureHtml(body: string, contentSecurityPolicy: string): Response {
	return new Response(body, {
		headers: {
			'cache-control': 'no-store',
			'content-security-policy': contentSecurityPolicy,
			'content-type': 'text/html; charset=utf-8',
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff',
		},
	})
}
