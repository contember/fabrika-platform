/**
 * How a scenario becomes a signed-in browser.
 *
 * A role is a REAL IAM principal with a REAL `sessions` row, seeded by
 * `packages/iam/src/node/browser-identity.ts`. The browser then obtains a session on each application
 * host **through the real handoff** — the one and only way a session reaches an app since
 * [ADR-0023](../../docs/decisions/0023-one-session-per-host.md): the seeded login cookie is planted on
 * IAM's own host. A protected request on each app host starts the handoff at that app's proxy, which
 * stores a browser-held verifier, redirects to IAM, redeems the returned code, and sets the app's
 * own `__Host-px_session`.
 *
 * So the suite carries one cookie per host, each a distinct `sessions` row bound to one app, exactly
 * as a human's browser would. Nothing here is a shortcut past the proxy — every request the suite makes
 * is still authorized by it and answered with an IAM-minted token, and the handoff itself is now
 * covered by every run rather than only in production.
 *
 * The one thing that IS a fixture shortcut is planting the IAM cookie instead of typing a password: the
 * browser composition runs with `LOCAL_DEV_LOGIN` off, on purpose, so an anonymous browser stays
 * anonymous and the proxy's refusal is observable.
 *
 * The principal's own coordinates ride along in `localStorage`, because a scenario cannot read them off
 * the wire: the browser holds an opaque session, the proxy injects the token server-side, and the
 * console exposes no `me` surface a non-admin role may call.
 */

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { type BrowserIdentity, type BrowserIdentityRole, createBrowserIdentity } from '@fabrika/local-stack/browser-support'
import type { Browser, BrowserContext } from 'playwright'

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

interface AuthResolveContext {
	cached: StorageState | null
	browser: Browser
}

const CONTROL_ORIGIN = process.env['FABRIKA_BROWSER_ORIGIN'] ?? 'http://control.fabrika.localhost:18080'
const IAM_ORIGIN = process.env['FABRIKA_BROWSER_IAM_ORIGIN'] ?? 'http://iam.fabrika.localhost:18080'
const NOTES_ORIGIN = process.env['FABRIKA_BROWSER_APP_URL'] ?? 'http://notes.fabrika.localhost:18081'

/**
 * Every host a scenario is signed in to, with the app id IAM knows it by. `registerLocalApps` in
 * `@fabrika/local-stack` registers exactly these origins, so a name added here without a registration
 * there is a 400 at sign-in rather than a silent miss.
 */
const APP_HOSTS: readonly { app: string; origin: string }[] = [
	{ app: 'vozka', origin: CONTROL_ORIGIN },
	{ app: 'notes', origin: NOTES_ORIGIN },
]

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

/**
 * Drive the real handoff once per app host and return the resulting storage state.
 *
 * The seeded login is planted on IAM's host only. Each protected app navigation first reaches the
 * proxy, which creates the browser-bound handoff attempt. IAM then takes its "already signed in
 * HERE" path, issues a code, and redirects to the app's reserved callback. The proxy redeems it,
 * writes that app's own host-only session, and returns to the original URL.
 *
 * The chain is followed by a real PAGE rather than by `context.request`. That is partly the point —
 * the browser is what a handoff is designed for — and partly forced: Playwright's Node-side fetch
 * parses `Set-Cookie` against `IncomingMessage.url`, which Node leaves undefined on a client response
 * and Bun sets to the request PATH, so it throws `ERR_INVALID_URL` on any redirect that carries a
 * cookie. A navigation never touches that code.
 */
async function signIn(browser: Browser, identity: BrowserIdentity): Promise<StorageState> {
	const context = await browser.newContext()
	try {
		await context.addCookies([{
			name: SESSION_COOKIE,
			value: identity.session,
			// Host-only, on IAM's host alone. `__Host-` additionally requires `Secure` and `Path=/`;
			// browsers accept a `Secure` cookie over plain HTTP on `*.localhost`, which is a
			// potentially-trustworthy origin.
			domain: new URL(IAM_ORIGIN).hostname,
			path: '/',
			expires: identity.expiresAt,
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
		}])
		const page = await context.newPage()
		for (const { app, origin } of APP_HOSTS) {
			const response = await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' })
			if (response !== null && !response.ok()) {
				throw new Error(`handoff to ${app} failed with status ${response.status()} — is the app registered in IAM?`)
			}
			if (!page.url().startsWith(origin)) {
				throw new Error(`the handoff to ${app} ended on ${page.url()} instead of ${origin}`)
			}
			const cookies = await context.cookies(origin)
			if (!cookies.some((cookie) => cookie.name === SESSION_COOKIE)) {
				throw new Error(`the handoff to ${app} set no session on ${origin}`)
			}
		}
		await page.goto(CONTROL_ORIGIN, { waitUntil: 'domcontentloaded' })
		await page.evaluate(
			({ key, principal }) => window.localStorage.setItem(key, principal),
			{ key: BROWSER_PRINCIPAL_KEY, principal: JSON.stringify({ id: identity.principalId, label: identity.label }) },
		)
		return await context.storageState()
	} finally {
		await context.close()
	}
}

export async function authenticate(role: string, { cached, browser }: AuthResolveContext): Promise<StorageState | null> {
	if (role === 'anonymous') return EMPTY
	if (role !== 'admin' && role !== 'operations-notes') return null
	if (cached !== null && await sessionIsValid(browser, cached, role)) return cached
	return signIn(browser, await createBrowserIdentity(role))
}
