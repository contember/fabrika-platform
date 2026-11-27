import type { RpcFetch } from '@fabrika/app'
import type { AppDto, GrantDto } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AdminAccessSection } from '../components/app-detail/AdminAccessSection'
import { readSelfAdmin, selfAdminExpiresAt, selfAdminTargets } from '../lib/self-admin'
import type { ConsoleSession } from '../lib/session'

const NOW = 1_800_000_000
const IAM_APPS: AppDto[] = [
	{ id: 'opice@prod', displayName: null, installation: false },
	{ id: 'opice@stage', displayName: null, installation: false },
	{ id: 'vozka', displayName: 'Console', installation: true },
]

type Grant = Pick<GrantDto, 'id' | 'app' | 'roleKey' | 'scopeType' | 'expiresAt'>
const admin = (app: string, expiresAt: number | null = null, id = `grant-${app}-${expiresAt}`): Grant => ({
	id,
	app,
	roleKey: 'admin',
	scopeType: null,
	expiresAt,
})

describe('the environments offered for a self-granted Admin', () => {
	test('an installation administrator gets every environment IAM knows, none it does not', () => {
		const targets = selfAdminTargets({
			appId: 'opice',
			envs: ['prod', 'stage', 'preview'],
			iamApps: IAM_APPS,
			administration: { kind: 'installation' },
			grants: [],
			now: NOW,
		})
		expect(targets).toEqual([
			{ env: 'prod', app: 'opice@prod', held: null },
			{ env: 'stage', app: 'opice@stage', held: null },
		])
	})

	test('a user administrator gets only the environments in its scope', () => {
		const targets = selfAdminTargets({
			appId: 'opice',
			envs: ['prod', 'stage'],
			iamApps: IAM_APPS,
			administration: { kind: 'users', apps: ['opice@stage'] },
			grants: [],
			now: NOW,
		})
		expect(targets.map((target) => target.app)).toEqual(['opice@stage'])
	})

	test('an installation app is never offered', () => {
		const targets = selfAdminTargets({
			appId: 'opice',
			envs: ['prod'],
			iamApps: [{ id: 'opice@prod', displayName: null, installation: true }],
			administration: { kind: 'installation' },
			grants: [],
			now: NOW,
		})
		expect(targets).toEqual([])
	})

	test('a held Admin carries its grant and expiry; an expired, scoped or other app grant is not held', () => {
		const held = (grants: Grant[]) =>
			selfAdminTargets({ appId: 'opice', envs: ['prod'], iamApps: IAM_APPS, administration: { kind: 'installation' }, grants, now: NOW })[0]?.held
		expect(held([admin('opice@prod', NOW + 10, 'g1')])).toEqual({ grantId: 'g1', until: NOW + 10 })
		expect(held([admin('opice@stage', null, 'g0'), admin('opice@prod', null, 'g1')])).toEqual({ grantId: 'g1', until: null })
		expect(held([admin('opice@prod', NOW - 1)])).toBeNull()
		expect(held([{ ...admin('opice@prod'), scopeType: 'workspace' }])).toBeNull()
		expect(held([admin('opice@stage'), { ...admin('opice@prod'), roleKey: 'editor' }])).toBeNull()
	})
})

describe('revoking a self-granted Admin in place', () => {
	test('a held Admin offers Revoke beside it; one not held offers the grant instead', () => {
		const markup = renderToStaticMarkup(createElement(AdminAccessSection, {
			state: {
				principalId: 'user-1',
				targets: [
					{ env: 'prod', app: 'opice@prod', held: null },
					{ env: 'stage', app: 'opice@stage', held: { grantId: 'g1', until: null } },
				],
			},
			onDone: () => {},
		}))
		expect(markup).toContain('aria-label="Grant me Admin on prod"')
		expect(markup).not.toContain('Revoke my Admin on prod')
		expect(markup).toContain('You hold Admin.')
		expect(markup).toContain('aria-label="Revoke my Admin on stage"')
	})
})

describe('the expiry of a self-granted Admin', () => {
	test('is none by default, or 8 hours or 7 days from now', () => {
		expect(selfAdminExpiresAt('none', NOW)).toBeNull()
		expect(selfAdminExpiresAt('8h', NOW)).toBe(NOW + 8 * 3600)
		expect(selfAdminExpiresAt('7d', NOW)).toBe(NOW + 7 * 86400)
	})
})

describe('reading the self-Admin state', () => {
	const session: Pick<ConsoleSession, 'principal' | 'iam'> = { principal: { id: 'user-1', label: 'ada@example.com' }, iam: { kind: 'installation' } }
	const answering = (byMethod: Record<string, () => Response>): RpcFetch => async (_input, init) => {
		const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
		const method = body !== null && typeof body === 'object' && 'method' in body && typeof body.method === 'string' ? body.method : ''
		const answer = byMethod[method]
		if (answer === undefined) throw new Error(`unexpected ${method}`)
		return answer()
	}
	const apps = () => Response.json({ result: { items: IAM_APPS } })
	const principal = () => Response.json({ result: { grants: [admin('opice@stage', null, 'g-stage')] } })

	test("reads the offered environments and the caller's own Admin from IAM", async () => {
		const state = await readSelfAdmin('opice', ['prod', 'stage'], session, answering({ 'apps.list': apps, 'principals.get': principal }))
		expect(state).toEqual({
			principalId: 'user-1',
			targets: [
				{ env: 'prod', app: 'opice@prod', held: null },
				{ env: 'stage', app: 'opice@stage', held: { grantId: 'g-stage', until: null } },
			],
		})
	})

	test('is null when IAM refuses or is down, and for a caller who administers no people', async () => {
		const forbidden = () => Response.json({ error: { type: 'forbidden', message: 'forbidden' } }, { status: 403 })
		expect(await readSelfAdmin('opice', ['prod'], session, answering({ 'apps.list': forbidden, 'principals.get': principal }))).toBeNull()
		expect(
			await readSelfAdmin(
				'opice',
				['prod'],
				session,
				answering({ 'apps.list': () => new Response('down', { status: 503 }), 'principals.get': principal }),
			),
		)
			.toBeNull()
		expect(await readSelfAdmin('opice', ['prod'], { ...session, iam: false }, answering({}))).toBeNull()
	})
})
