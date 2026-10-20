// The installation's client logo (ADR-0065): an installation administrator sets it through `/admin/rpc`, IAM checks it
// on the way in and again on the way out, each change writes `iam.brand.update` in its own statement group, and every
// IAM page draws it in place of the fabrika mark under `img-src data:` and nothing wider. Every suite runs on SQLite and,
// with FABRIKA_TEST_POSTGRES_URL, on Postgres.

import { IAM_APP_ID, IAM_APP_SCHEMA, USER_ADMIN_ROLE } from '@fabrika/iam-contract'
import type { SqlDatabase } from '@fabrika/platform'
import { brandMark } from '@fabrika/proxy-core/page-style'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { handleAuth } from '../auth/routes'
import { createPostgresIamRepositories, type IamRepositories, InstallationBrandRepository, type InstallationBrandRow } from '../db'
import { prop } from '../json'
import { consoleRpc, errorType, result } from './helpers/app-people'
import { PNG_BASE64, SVG_BASE64, TEST_BRAND } from './helpers/brand'
import { createHarness, makeServicesFor, TestSqlDatabase } from './helpers/harness'
import { CALLER_ENV, type MembershipFixture, membershipFixture, ORIGIN, PendingWork } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

const PORTAL = 'portal@prod'
const SERVICES = { authentication: { oidc: false, password: true } }
const MARK = brandMark(160)
const LIGHT_IMG = `<img src="data:image/png;base64,${PNG_BASE64}" alt="">`
const DARK_SOURCE = `<source media="(prefers-color-scheme: dark)" srcset="data:image/svg+xml;base64,${SVG_BASE64}">`

interface Engine {
	readonly repositories: IamRepositories
	/** The database under `repositories`, to write a row no use case would write. */
	readonly db: SqlDatabase
}

async function call(f: MembershipFixture, method: string, input: unknown): Promise<{ status: number; body: unknown }> {
	const response = await f.adminRpc(method, input)
	return { status: response.status, body: await response.json() }
}

async function brandEvents(repositories: IamRepositories) {
	return repositories.audit.listAuditEvents({ action: 'iam.brand.update', limit: 20 })
}

/** A page IAM renders for `path`, as a browser receives it. */
async function page(f: MembershipFixture, path: string): Promise<{ status: number; html: string; csp: string }> {
	const response = await handleAuth(new Request(new URL(path, ORIGIN)), f.services, CALLER_ENV, new PendingWork())
	return { status: response.status, html: await response.text(), csp: response.headers.get('content-security-policy') ?? '' }
}

function brandSuite(label: string, engine: () => Promise<Engine>) {
	describe(`the installation brand (${label})`, () => {
		test('round trip: none, set, read back, cleared; each change writes iam.brand.update without the bytes', async () => {
			const { repositories } = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES })

			expect(result((await call(f, 'brand.get', null)).body)).toEqual({ brand: null, updatedAt: null })

			const set = await call(f, 'brand.set', { brand: TEST_BRAND })
			expect(set.status).toBe(200)
			expect(prop(result(set.body), 'brand')).toEqual(TEST_BRAND)
			expect(typeof prop(result(set.body), 'updatedAt')).toBe('number')
			expect(result((await call(f, 'brand.get', null)).body)).toEqual(result(set.body))

			const lightOnly = { light: TEST_BRAND.light }
			expect(prop(result((await call(f, 'brand.set', { brand: lightOnly })).body), 'brand')).toEqual(lightOnly)

			const cleared = await call(f, 'brand.clear', null)
			expect(cleared.status).toBe(200)
			expect(prop(result(cleared.body), 'brand')).toBeNull()
			expect(typeof prop(result(cleared.body), 'updatedAt')).toBe('number')

			const events = await brandEvents(repositories)
			expect(events.map((event) => [event.resource_type, event.resource_id, event.metadata])).toEqual([
				['installation_brand', null, JSON.stringify({ light: null, dark: null })],
				['installation_brand', null, JSON.stringify({ light: 'image/png', dark: null })],
				['installation_brand', null, JSON.stringify({ light: 'image/png', dark: 'image/svg+xml' })],
			])
			for (const event of events) {
				expect(`${event.metadata}${event.diff}`).not.toContain(PNG_BASE64)
				expect(`${event.metadata}${event.diff}`).not.toContain(SVG_BASE64)
			}
		})

		test('clearing an absent brand changes nothing and writes no record', async () => {
			const { repositories } = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES })
			expect(result((await call(f, 'brand.clear', null)).body)).toEqual({ brand: null, updatedAt: null })
			await call(f, 'brand.set', { brand: TEST_BRAND })
			await call(f, 'brand.clear', null)
			const twice = await call(f, 'brand.clear', null)
			expect(prop(result(twice.body), 'brand')).toBeNull()
			expect((await brandEvents(repositories)).length).toBe(2)
		})

		test('an image of another type, too big, or whose bytes are not its type is refused, and nothing is stored', async () => {
			const { repositories } = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES })
			const oversized = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + 'x'.repeat(33 * 1024))
			const refused = [
				{ light: { type: 'image/gif', base64: PNG_BASE64 } },
				{ light: { type: 'image/png', base64: oversized } },
				{ light: { type: 'image/webp', base64: PNG_BASE64 } },
				{ light: TEST_BRAND.light, dark: { type: 'image/png', base64: SVG_BASE64 } },
				{ light: { type: 'image/png', base64: `${PNG_BASE64.slice(0, -2)}J=` } },
				{ light: TEST_BRAND.light, extra: 'markup' },
			]
			for (const brand of refused) {
				const response = await call(f, 'brand.set', { brand })
				expect([response.status, errorType(response.body)]).toEqual([400, 'validation'])
			}
			expect(result((await call(f, 'brand.get', null)).body)).toEqual({ brand: null, updatedAt: null })
			expect(await brandEvents(repositories)).toEqual([])
		})

		test('a user administrator is refused all three, and the brand stays as it was', async () => {
			const { repositories } = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES })
			const reconciled = await f.putSchema(IAM_APP_SCHEMA, IAM_APP_ID)
			expect(reconciled.status).toBe(200)
			await call(f, 'brand.set', { brand: TEST_BRAND })
			const userAdmin = await repositories.principals.createUser(`sub-brand-${crypto.randomUUID()}`, `brand-${crypto.randomUUID()}@example.test`)
			await repositories.grants.createRoleGrantUnlessHeld({ principalId: userAdmin.id, app: IAM_APP_ID, roleKey: USER_ADMIN_ROLE })
			// It is a user administrator: its own procedures answer.
			expect((await consoleRpc(f, userAdmin.id, 'me', null)).status).toBe(200)

			const procedures: [string, unknown][] = [['brand.get', null], ['brand.set', { brand: { light: TEST_BRAND.light } }], ['brand.clear', null]]
			for (const [method, input] of procedures) {
				const refused = await consoleRpc(f, userAdmin.id, method, input)
				expect([method, refused.status, errorType(refused.body)]).toEqual([method, 403, 'forbidden'])
			}
			expect(prop(result((await call(f, 'brand.get', null)).body), 'brand')).toEqual(TEST_BRAND)
			expect((await brandEvents(repositories)).length).toBe(1)
		})

		test('every page draws the logo when one is set and the fabrika mark otherwise, in both languages', async () => {
			const { repositories } = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES })
			await repositories.appSchema.reconcileAppSchema({
				app: PORTAL,
				scopes: [],
				actions: [{ action: 'portal.read' }],
				roles: [],
				presentation: { locale: 'cs', displayName: 'Portál' },
			})
			await repositories.handoff.setReturnOrigins(PORTAL, ['https://portal.test'])
			// IAM's own sign-in and sign-out speak the installation's language; the forgotten password of the portal Czech.
			const paths = ['/auth/login', '/auth/logout', `/auth/forgot-password?app=${encodeURIComponent(PORTAL)}`]

			for (const path of paths) {
				const { status, html } = await page(f, path)
				expect([path, status, html.includes(MARK), html.includes('<picture>')]).toEqual([path, 200, true, false])
			}
			await call(f, 'brand.set', { brand: TEST_BRAND })
			for (const path of paths) {
				const { html } = await page(f, path)
				expect(html).toContain(`<picture>${DARK_SOURCE}${LIGHT_IMG}</picture>`)
				expect(html).not.toContain(MARK)
				// The footer still names fabrika, with its small mark.
				expect(html).toContain(`${brandMark(12)} fabrika`)
			}
			expect((await page(f, paths[0] ?? '')).html).toContain('<html lang="en">')
			expect((await page(f, paths[2] ?? '')).html).toContain('<html lang="cs">')

			await call(f, 'brand.set', { brand: { light: TEST_BRAND.light } })
			expect((await page(f, '/auth/login')).html).toContain(`<picture>${LIGHT_IMG}</picture>`)
			await call(f, 'brand.clear', null)
			expect((await page(f, '/auth/login')).html).toContain(MARK)
		})

		test('a stored row the brand check now refuses draws the mark and reads back as no brand', async () => {
			const { repositories, db } = await engine()
			const f = await membershipFixture(repositories, { services: SERVICES })
			await db
				.prepare('INSERT INTO installation_brand (id, light_type, light_base64, updated_at) VALUES (1, ?, ?, ?)')
				.bind('image/png', SVG_BASE64, 1_700_000_000)
				.run()
			expect((await page(f, '/auth/login')).html).toContain(MARK)
			expect(result((await call(f, 'brand.get', null)).body)).toEqual({ brand: null, updatedAt: 1_700_000_000 })
		})
	})
}

describe('IAM pages and the brand', () => {
	test('the CSP admits a data: image and nothing else new: no data: in default-src or script-src', async () => {
		const h = createHarness()
		const f = await membershipFixture(h.repositories, { services: SERVICES })
		await f.adminRpc('brand.set', { brand: TEST_BRAND })
		const { csp } = await page(f, '/auth/login')
		const directives = new Map(
			csp.split(';').map((part) => {
				const [name = '', ...values] = part.trim().split(/\s+/)
				return [name, values]
			}),
		)
		expect(directives.get('img-src')).toEqual(['data:'])
		expect(directives.get('default-src')).toEqual(["'none'"])
		expect(directives.get('script-src')).toEqual([expect.stringMatching(/^'nonce-[0-9a-f]{32}'$/)])
		expect(directives.get('style-src')).toEqual([expect.stringMatching(/^'nonce-[0-9a-f]{32}'$/)])
		expect([...directives.entries()].filter(([name, values]) => name !== 'img-src' && values.includes('data:'))).toEqual([])
	})

	test('a brand that cannot be read draws the fabrika mark instead of failing the page', async () => {
		const h = createHarness()
		class Unreadable extends InstallationBrandRepository {
			override get(): Promise<InstallationBrandRow | null> {
				return Promise.reject(new Error('injected fault'))
			}
		}
		const repositories = { ...h.repositories, brand: new Unreadable(new TestSqlDatabase(h.sqlite)) }
		const services = makeServicesFor(repositories, { ...SERVICES, issuer: ORIGIN, environment: 'stage' })
		const response = await handleAuth(new Request(`${ORIGIN}/auth/login`), services, CALLER_ENV, new PendingWork())
		expect(response.status).toBe(200)
		expect(await response.text()).toContain(MARK)
	})
})

brandSuite('SQLite', async () => {
	const h = createHarness()
	return { repositories: h.repositories, db: new TestSqlDatabase(h.sqlite) }
})

if (!hasPostgres) {
	console.warn(`installation-brand.test.ts ${skipReason}`)
}

describe.skipIf(!hasPostgres)('on Postgres', () => {
	let fixture: PostgresFixture | null = null
	beforeAll(async () => {
		fixture = await createPostgres('iam_brand')
	})
	afterAll(async () => {
		await fixture?.close()
	})
	// The brand is one row of the installation, so each test starts from none on the shared schema.
	brandSuite('Postgres', async () => {
		if (fixture === null) throw new Error('fixture')
		await fixture.db.prepare('DELETE FROM installation_brand').run()
		await fixture.db.prepare(`DELETE FROM audit_events WHERE action = 'iam.brand.update'`).run()
		return { repositories: createPostgresIamRepositories(fixture.db), db: fixture.db }
	})
})
