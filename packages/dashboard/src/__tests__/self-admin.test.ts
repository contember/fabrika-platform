import type { AppDto, GrantDto } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { selfAdminExpiresAt, selfAdminTargets } from '../lib/self-admin'

const NOW = 1_800_000_000
const IAM_APPS: AppDto[] = [
	{ id: 'opice@prod', displayName: null, installation: false },
	{ id: 'opice@stage', displayName: null, installation: false },
	{ id: 'vozka', displayName: 'Console', installation: true },
]

type Grant = Pick<GrantDto, 'app' | 'roleKey' | 'scopeType' | 'expiresAt'>
const admin = (app: string, expiresAt: number | null = null): Grant => ({ app, roleKey: 'admin', scopeType: null, expiresAt })

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
			appId: 'vozka',
			envs: [],
			iamApps: IAM_APPS,
			administration: { kind: 'installation' },
			grants: [],
			now: NOW,
		})
		expect(targets).toEqual([])
	})

	test('a held Admin shows its latest expiry; an expired, scoped or other app grant is not held', () => {
		const held = (grants: Grant[]) =>
			selfAdminTargets({ appId: 'opice', envs: ['prod'], iamApps: IAM_APPS, administration: { kind: 'installation' }, grants, now: NOW })[0]?.held
		expect(held([admin('opice@prod', NOW + 10), admin('opice@prod', NOW + 99)])).toEqual({ until: NOW + 99 })
		expect(held([admin('opice@prod', NOW + 10), admin('opice@prod')])).toEqual({ until: null })
		expect(held([admin('opice@prod', NOW - 1)])).toBeNull()
		expect(held([{ ...admin('opice@prod'), scopeType: 'workspace' }])).toBeNull()
		expect(held([admin('opice@stage'), { ...admin('opice@prod'), roleKey: 'editor' }])).toBeNull()
	})
})

describe('the expiry of a self-granted Admin', () => {
	test('is none by default, or 8 hours or 7 days from now', () => {
		expect(selfAdminExpiresAt('none', NOW)).toBeNull()
		expect(selfAdminExpiresAt('8h', NOW)).toBe(NOW + 8 * 3600)
		expect(selfAdminExpiresAt('7d', NOW)).toBe(NOW + 7 * 86400)
	})
})
