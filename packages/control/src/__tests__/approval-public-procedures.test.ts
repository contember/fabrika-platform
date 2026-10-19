// A public procedure and every procedure's admission and time limit in the conservative access diff (ADR-0050): a new
// public endpoint widens with closer review, each procedure shows its effective bounds where the baseline records none,
// and a bound that admits more or runs longer widens.

import type { ContractArtifact, DeclaredReach, EndpointRow, ProcedureArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const reach: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }

const CTA: EndpointRow = {
	id: 'api.stats.cta',
	source: { kind: 'mount', name: 'api' },
	kind: 'public',
	method: 'POST',
	path: '/api/stats.cta',
	callers: [],
	requirement: null,
	admission: { contentTypes: ['application/json'], maxBytes: 1024 },
	input: { type: 'object', fields: {} },
	output: { type: 'object', fields: {} },
}

const DEFAULT_RULES: ProcedureArtifact = {
	rate: { perClient: 10, perCaller: null, perEndpoint: 100, bytesPerHour: null },
	challenge: null,
	timeoutMs: 10_000,
}

function snapshot(rules: ProcedureArtifact | null, row: EndpointRow | null = CTA): AccessSnapshot {
	const contract: ContractArtifact = {
		...notesArtifact,
		endpoints: row === null ? notesArtifact.endpoints : [...notesArtifact.endpoints, row],
		declared: row === null ? {} : { [row.id]: { ...reach, actions: ['notes.write'] } },
		...(rules === null || row === null ? {} : { procedures: { [row.id]: rules } }),
	}
	return { version: 1, contract, migrations: [], checker: '0.0.0' }
}

describe('a public procedure in the approval diff', () => {
	test('a new one widens with closer review, says who calls it, what it runs with, and its effective bounds', () => {
		expect(classifyAccess(snapshot(null, null), snapshot(DEFAULT_RULES))).toEqual({
			outcome: 'widening',
			changes: [
				{ effect: 'widens', line: 'New endpoint `api.stats.cta` (POST /api/stats.cta) for anyone, without signing in', review: 'closer' },
				{ effect: 'widens', line: 'Endpoint `api.stats.cta` runs as its own workload with `notes.write`, for anyone who calls it', review: 'closer' },
				{
					effect: 'neutral',
					line:
						'`api.stats.cta` admits calls per minute: 10 per client (one client on Zerops) and 100 in all; it runs at most 10 s, with a body of at most 1024 bytes',
				},
			],
		})
	})

	test('a bucket raised or turned off widens, one lowered narrows', () => {
		const raised = { ...DEFAULT_RULES, rate: { ...DEFAULT_RULES.rate, perClient: 300, perEndpoint: null } }
		expect(classifyAccess(snapshot(DEFAULT_RULES), snapshot(raised)).changes).toEqual([
			{ effect: 'widens', line: '`api.stats.cta` bucket per client changes from 10 to 300' },
			{ effect: 'widens', line: '`api.stats.cta` bucket in all changes from 100 to none' },
		])
		expect(classifyAccess(snapshot(raised), snapshot(DEFAULT_RULES)).outcome).toBe('no-widening')
	})

	test('a challenge dropped widens, and a longer time limit widens', () => {
		const challenged = { ...DEFAULT_RULES, challenge: { provider: 'turnstile' as const, secret: 'TURNSTILE_SECRET' } }
		expect(classifyAccess(snapshot(challenged), snapshot({ ...DEFAULT_RULES, timeoutMs: 30_000 })).changes).toEqual([
			{ effect: 'widens', line: '`api.stats.cta` no longer asks for a challenge' },
			{ effect: 'widens', line: '`api.stats.cta` time limit changes from 10 s to 30 s' },
		])
	})

	test('an older release records no rules: the same contract compares as before', () => {
		expect(classifyAccess(snapshot(null), snapshot(null))).toEqual({ outcome: 'none', changes: [] })
	})
})
