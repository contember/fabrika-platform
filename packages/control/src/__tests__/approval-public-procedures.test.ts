// A public procedure and every procedure's admission and time limit in the conservative access diff (ADR-0050): a new
// public endpoint widens with closer review, each procedure shows its effective bounds where the baseline records none,
// and a bound that admits more or runs longer widens.

import type { ContractArtifact, DeclaredReach, EndpointRow, ProcedureArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { AccessSnapshot } from '../approval/snapshot'
import { classifyAccess } from './helpers/access'

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
						'`api.stats.cta` admits calls per minute: 10 per client (one client on Zerops) and 100 in all; it waits at most 30 s for a body of at most 1024 bytes, then runs at most 10 s',
				},
			],
		})
	})

	test("a large body's deadline is named before the handler's time limit, which starts after the last byte", () => {
		const upload: EndpointRow = { ...CTA, admission: { contentTypes: ['multipart/form-data'], maxBytes: 10 * 1024 * 1024 } }
		expect(classifyAccess(snapshot(null, null), snapshot(DEFAULT_RULES, upload)).changes.at(-1)?.line).toEndWith(
			'it waits at most 640 s for a body of at most 10485760 bytes, then runs at most 10 s',
		)
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
		const challenged = { ...DEFAULT_RULES, challenge: { provider: 'turnstile' as const, secret: 'TURNSTILE_SECRET', action: 'api_stats_cta' } }
		expect(classifyAccess(snapshot(challenged), snapshot({ ...DEFAULT_RULES, timeoutMs: 30_000 })).changes).toEqual([
			{ effect: 'widens', line: '`api.stats.cta` no longer asks for a challenge' },
			{ effect: 'widens', line: '`api.stats.cta` time limit changes from 10 s to 30 s' },
		])
	})

	test('a path of its own shows as any route does: on the new endpoint, and as a changed route', () => {
		const own: EndpointRow = { ...CTA, path: '/register' }
		expect(classifyAccess(snapshot(null, null), snapshot(DEFAULT_RULES, own)).changes[0]).toEqual({
			effect: 'widens',
			line: 'New endpoint `api.stats.cta` (POST /register) for anyone, without signing in',
			review: 'closer',
		})
		expect(classifyAccess(snapshot(DEFAULT_RULES), snapshot(DEFAULT_RULES, own)).changes).toEqual([
			{ effect: 'widens', line: 'Endpoint `api.stats.cta` route changes from `"POST /api/stats.cta"` to `"POST /register"`' },
		])
	})

	test('a challenge action of its own shows as a change of the challenge, which widens as every change of it does', () => {
		const challenged = (action: string): ProcedureArtifact => ({
			...DEFAULT_RULES,
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', action },
		})
		expect(classifyAccess(snapshot(challenged('api_stats_cta')), snapshot(challenged('register'))).changes).toEqual([
			{
				effect: 'widens',
				line:
					'`api.stats.cta` challenge changes from `{"action":"api_stats_cta","provider":"turnstile","secret":"TURNSTILE_SECRET"}` to `{"action":"register","provider":"turnstile","secret":"TURNSTILE_SECRET"}`',
			},
		])
	})

	test('a redirect output says where anyone who calls it may be sent, and a new origin widens', () => {
		const redirecting = (origins: readonly string[]): EndpointRow => ({ ...CTA, output: { type: 'redirect', origins } })
		expect(classifyAccess(snapshot(null, null), snapshot(DEFAULT_RULES, redirecting(['https://partner.example']))).changes[0]).toEqual({
			effect: 'widens',
			line:
				'New endpoint `api.stats.cta` (POST /api/stats.cta) for anyone, without signing in, answering a redirect to its own origin or `https://partner.example`',
			review: 'closer',
		})
		expect(classifyAccess(snapshot(DEFAULT_RULES, redirecting([])), snapshot(DEFAULT_RULES, redirecting(['https://partner.example']))).changes).toEqual(
			[
				{ effect: 'widens', line: 'Endpoint `api.stats.cta` redirect may go to `https://partner.example`' },
			],
		)
	})

	test('a kick from a public procedure widens with closer review; from any other site it is shown and widens nothing', () => {
		const kicking = (site: string, kicks: readonly string[], actions?: readonly string[]): AccessSnapshot => {
			const contract: ContractArtifact = {
				...notesArtifact,
				endpoints: [...notesArtifact.endpoints, CTA],
				declared: { [site]: { ...reach, kicks, ...(actions === undefined ? {} : { actions }) } },
				procedures: { [CTA.id]: DEFAULT_RULES },
			}
			return { version: 1, contract, migrations: [], checker: '0.0.0' }
		}
		expect(classifyAccess(kicking('api.stats.cta', [], ['notes.write']), kicking('api.stats.cta', ['digest'], ['notes.write'])).changes).toEqual([
			{ effect: 'widens', line: 'Endpoint `api.stats.cta` starts job `digest` whenever anyone calls it', review: 'closer' },
		])
		expect(classifyAccess(kicking('job:sweep', []), kicking('job:sweep', ['digest'])).changes).toEqual([
			{ effect: 'neutral', line: 'Job `sweep` starts job `digest` after each committed run, beside its schedule' },
		])
		expect(classifyAccess(kicking('job:sweep', ['digest']), kicking('job:sweep', [])).changes).toEqual([
			{ effect: 'narrows', line: 'Job `sweep` no longer starts job `digest`' },
		])
	})

	test('an older release records no rules: the same contract compares as before', () => {
		expect(classifyAccess(snapshot(null), snapshot(null))).toEqual({ outcome: 'none', changes: [] })
	})
})
