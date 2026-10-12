// A public SPA in the conservative access diff (ADR-0050 §3): a new one, and a member SPA that becomes one, widen.

import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { BASE, edited } from './helpers/contracts'

function snapshot(contract = BASE): AccessSnapshot {
	return { version: 1, contract: readContractSource(new Map([['fabrika.contract.ts', contract]]), {}), migrations: [], checker: '0.0.0' }
}

const MEMBER_SPA = "app: c.spa('/', { dir: 'dist/app', access: { member: true } }),"

describe('a public SPA in the approval diff', () => {
	test('a new public SPA widens, and its line says anyone opens it without signing in', () => {
		const candidate = snapshot(edited(MEMBER_SPA, `${MEMBER_SPA}\n\tsite: c.spa('/site', { dir: 'dist/site', access: { public: true } }),`))
		const classification = classifyAccess(snapshot(), candidate)
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toContainEqual({ widens: true, line: 'New endpoint `site` (GET /site/*) for anyone, without signing in' })
	})

	test('a member SPA that becomes public widens', () => {
		const candidate = snapshot(edited(MEMBER_SPA, "app: c.spa('/', { dir: 'dist/app', access: { public: true } }),"))
		const classification = classifyAccess(snapshot(), candidate)
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toContainEqual({ widens: true, line: 'Endpoint `app` becomes public: anyone opens it without signing in' })
	})
})
