import { type BrowserIdentityRole, createBrowserIdentity } from '@fabrika/local-stack/browser-support'
import type { Browser, BrowserContext } from 'playwright'

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>

interface AuthResolveContext {
	cached: StorageState | null
	browser: Browser
}

const CONTROL_ORIGIN = process.env['FABRIKA_BROWSER_ORIGIN'] ?? 'http://control.fabrika.localhost:18080'
const APP_ORIGIN = process.env['FABRIKA_BROWSER_APP_ORIGIN'] ?? 'http://notes.fabrika.localhost:18081'
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

async function freshState(role: BrowserIdentityRole): Promise<StorageState> {
	const identity = await createBrowserIdentity(role)
	const cookie = (origin: string): StorageState['cookies'][number] => ({
		name: 'px_session',
		value: identity.session,
		domain: new URL(origin).hostname,
		path: '/',
		expires: identity.expiresAt,
		httpOnly: true,
		secure: false,
		sameSite: 'Lax',
	})
	return {
		cookies: [cookie(CONTROL_ORIGIN), cookie(APP_ORIGIN)],
		origins: [],
	}
}

export async function authenticate(role: string, { cached, browser }: AuthResolveContext): Promise<StorageState | null> {
	if (role === 'anonymous') return EMPTY
	if (role !== 'admin' && role !== 'operations-notes') return null
	if (cached !== null && await sessionIsValid(browser, cached, role)) return cached
	return freshState(role)
}
