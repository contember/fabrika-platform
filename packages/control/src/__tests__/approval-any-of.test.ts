// An `anyOf` endpoint in the conservative access diff (ADR-0050 §3), read from `@fabrika/app`'s `any-of-fixture/`: a new
// one says it admits a global holder of any listed action, a list compares by action (gained widens, lost narrows), and
// `action` becoming `anyOf` widens by the actions added. The removal comparison admits a narrower list or one of its actions.

import type { EndpointRequirement } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { accessMap } from '../approval/access-map'
import { requirementAdmitsNoMore } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { classifyAccess } from './helpers/access'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'any-of-fixture')
const ENDPOINTS = 'src/cash/endpoints.ts'
const DETAIL = "access: { anyOf: ['cash.read', 'cash.audit'], app: true }"

const fixture = (): Map<string, string> => {
	const files = new Map<string, string>()
	for (const entry of readdirSync(ROOT, { recursive: true, withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
			const path = join(entry.parentPath, entry.name)
			files.set(relative(ROOT, path), readFileSync(path, 'utf8'))
		}
	}
	return files
}

/** The fixture with the detail endpoint's access replaced. */
const withDetail = (access: string): Map<string, string> => {
	const files = fixture()
	const source = files.get(ENDPOINTS) ?? ''
	expect(source).toContain(DETAIL)
	files.set(ENDPOINTS, source.replace(DETAIL, access))
	return files
}

function snapshot(files: ReadonlyMap<string, string> | null): AccessSnapshot {
	return { version: 1, contract: files === null ? null : readContractSource(files), migrations: [], checker: '0.0.0' }
}

describe('an anyOf endpoint in the approval diff', () => {
	test('a new anyOf endpoint names every listed action, each held globally', () => {
		const { changes } = classifyAccess(snapshot(null), snapshot(fixture()))
		expect(changes).toContainEqual({
			effect: 'widens',
			line: 'New endpoint `api.cash.list` (POST /api/cash.list) for human callers holding any of `cash.audit`, `cash.manage`, `cash.read` globally',
		})
	})

	test('the app form of one action becoming anyOf widens by the actions added, and the way back narrows', () => {
		const single = withDetail("access: { action: 'cash.read', app: true }")
		const widened = classifyAccess(snapshot(single), snapshot(fixture()))
		expect(widened.outcome).toBe('widening')
		expect(widened.changes).toEqual([{ effect: 'widens', line: 'Endpoint `api.cash.detail` admits callers holding `cash.audit` globally' }])
		const narrowed = classifyAccess(snapshot(fixture()), snapshot(single))
		expect(narrowed.outcome).toBe('no-widening')
		expect(narrowed.changes).toEqual([{ effect: 'narrows', line: 'Endpoint `api.cash.detail` no longer admits callers holding `cash.audit` globally' }])
	})

	test('an action a list gains widens and one it loses narrows; a swap does both', () => {
		const wider = withDetail("access: { anyOf: ['cash.read', 'cash.audit', 'cash.manage'], app: true }")
		const gained = classifyAccess(snapshot(fixture()), snapshot(wider))
		expect(gained.outcome).toBe('widening')
		expect(gained.changes).toEqual([{ effect: 'widens', line: 'Endpoint `api.cash.detail` admits callers holding `cash.manage` globally' }])
		const lost = classifyAccess(snapshot(wider), snapshot(fixture()))
		expect(lost.outcome).toBe('no-widening')
		expect(lost.changes).toEqual([{ effect: 'narrows', line: 'Endpoint `api.cash.detail` no longer admits callers holding `cash.manage` globally' }])
		const swapped = classifyAccess(snapshot(fixture()), snapshot(withDetail("access: { anyOf: ['cash.read', 'cash.manage'], app: true }")))
		expect(swapped.outcome).toBe('widening')
		expect(swapped.changes).toEqual([
			{ effect: 'narrows', line: 'Endpoint `api.cash.detail` no longer admits callers holding `cash.audit` globally' },
			{ effect: 'widens', line: 'Endpoint `api.cash.detail` admits callers holding `cash.manage` globally' },
		])
	})

	test('the order of the list in the source changes nothing', () => {
		const reordered = withDetail("access: { anyOf: ['cash.audit', 'cash.read'], app: true }")
		expect(classifyAccess(snapshot(fixture()), snapshot(reordered))).toEqual({ outcome: 'none', changes: [] })
	})

	test('a scoped form becoming anyOf reads as the requirement change it is, and widens', () => {
		const over = withDetail("access: { action: 'cash.read', over: 'branch' }")
		const changed = classifyAccess(snapshot(over), snapshot(fixture()))
		expect(changed.outcome).toBe('widening')
		expect(changed.changes.map((change) => change.line)).toEqual([
			'Endpoint `api.cash.detail` requirement changes from `{"access":{"dimension":"branch","form":"over"},"action":"cash.read","kind":"action"}` to `{"access":{"form":"app"},"actions":["cash.audit","cash.read"],"kind":"anyOf"}`',
		])
	})

	test('the access map lists an anyOf endpoint under each listed action, naming the others that stand in for it', () => {
		const contract = snapshot(fixture()).contract
		if (contract === null) throw new Error('the fixture has a contract')
		const endpoint = accessMap(contract).actions.find((action) => action.action === 'cash.audit')?.endpoints.find((row) => row.id === 'api.cash.list')
		expect(endpoint).toEqual({
			id: 'api.cash.list',
			method: 'POST',
			path: '/api/cash.list',
			access: 'app-wide, or with cash.manage or cash.read instead',
			callers: ['human'],
		})
	})
})

describe('the removal comparison of an anyOf requirement', () => {
	const anyOf = (first: string, second: string, ...rest: string[]): EndpointRequirement => ({
		kind: 'anyOf',
		actions: [first, second, ...rest],
		access: { form: 'app' },
	})
	const app = (action: string): EndpointRequirement => ({ kind: 'action', action, access: { form: 'app' } })
	const listed = anyOf('cash.audit', 'cash.read')

	test('admits a superset of an app-form action exactly when it lists that action', () => {
		expect(requirementAdmitsNoMore(app('cash.read'), listed)).toBe(true)
		expect(requirementAdmitsNoMore(app('cash.manage'), listed)).toBe(false)
		expect(requirementAdmitsNoMore({ kind: 'action', action: 'cash.read', access: { form: 'over', dimension: 'branch' } }, listed)).toBe(false)
		expect(requirementAdmitsNoMore({ kind: 'member' }, listed)).toBe(false)
	})

	test('admits a superset of another anyOf exactly when its list contains the other one', () => {
		expect(requirementAdmitsNoMore(listed, anyOf('cash.audit', 'cash.manage', 'cash.read'))).toBe(true)
		expect(requirementAdmitsNoMore(anyOf('cash.audit', 'cash.manage', 'cash.read'), listed)).toBe(false)
		expect(requirementAdmitsNoMore(anyOf('cash.audit', 'cash.manage'), listed)).toBe(false)
		expect(requirementAdmitsNoMore(listed, listed)).toBe(true)
	})

	test('an anyOf in place of the app form of one of its actions admits more', () => {
		expect(requirementAdmitsNoMore(listed, app('cash.read'))).toBe(false)
	})
})
