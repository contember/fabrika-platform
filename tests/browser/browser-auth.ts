/**
 * How a scenario becomes a signed-in browser.
 *
 * A role is a REAL IAM principal with a REAL `sessions` row, seeded by
 * `packages/iam/src/node/browser-identity.ts`. The browser then carries that session exactly the way
 * IAM hands it out in the local composition: one `px_session` cookie on the shared `fabrika.localhost`
 * parent, which is the path the proxy takes for every host it fronts. Nothing here is a shortcut past
 * the proxy — every request the suite makes is still authorized by it and answered with an
 * IAM-minted token.
 *
 * The principal's own coordinates ride along in `localStorage`, because a scenario cannot read them off
 * the wire: the browser holds an opaque session, the proxy injects the token server-side, and the
 * console exposes no `me` surface a non-admin role may call.
 */

import { type BrowserIdentity, type BrowserIdentityRole, createBrowserIdentity } from '@fabrika/local-stack/browser-support'
import type { Browser, BrowserContext } from 'playwright'

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

interface AuthResolveContext {
	cached: StorageState | null
	browser: Browser
}

const CONTROL_ORIGIN = process.env['FABRIKA_BROWSER_ORIGIN'] ?? 'http://control.fabrika.localhost:18080'
/** Every local platform and application host hangs off this name; the session cookie is scoped to it. */
const SESSION_COOKIE_DOMAIN = '.fabrika.localhost'
/** Where a scenario reads the principal it is signed in as. Mirrored in `support/fixtures.ts`. */
export const BROWSER_PRINCIPAL_KEY = 'fabrika.browser-principal'
const EMPTY: StorageState = { cookies: [], origins: [] }

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function sessionIsValid(browser: Browser, state: StorageState, role: BrowserIdentityRole): Promise<boolean> {
	const context = await browser.newContext({ storageState: state })
	try {
		const response = await context.request.post(`${CONTROL_ORIGIN}/operations/api/rpc`, {
			data: { method: 'sources' },
			headers: { origin: CONTROL_ORIGIN },
			failOnStatusCode: false,
			// A stale session is a 302 to IAM at the proxy; following it would return the login page as a
			// perfectly good 200 and make an expired session look live.
			maxRedirects: 0,
		})
		if (!response.ok()) return false
		const value: unknown = await response.json()
		if (!isRecord(value) || value['error'] !== undefined || !isRecord(value['result']) || !Array.isArray(value['result']['items'])) return false
		const items = value['result']['items']
		if (role === 'admin') {
			return items.some((item) => isRecord(item) && item['appId'] === 'browser-notes')
				&& items.some((item) => isRecord(item) && item['appId'] === 'browser-hidden')
		}
		return items.length > 0 && items.every((item) => isRecord(item) && item['appId'] === 'browser-notes')
	} catch {
		return false
	} finally {
		await context.close()
	}
}

function stateFor(identity: BrowserIdentity): StorageState {
	return {
		cookies: [{
			name: 'px_session',
			value: identity.session,
			domain: SESSION_COOKIE_DOMAIN,
			path: '/',
			expires: identity.expiresAt,
			httpOnly: true,
			secure: false,
			sameSite: 'Lax',
		}],
		origins: [{
			origin: CONTROL_ORIGIN,
			localStorage: [{
				name: BROWSER_PRINCIPAL_KEY,
				value: JSON.stringify({ id: identity.principalId, label: identity.label }),
			}],
		}],
	}
}

export async function authenticate(role: string, { cached, browser }: AuthResolveContext): Promise<StorageState | null> {
	if (role === 'anonymous') return EMPTY
	if (role !== 'admin' && role !== 'operations-notes') return null
	if (cached !== null && await sessionIsValid(browser, cached, role)) return cached
	return stateFor(await createBrowserIdentity(role))
}
