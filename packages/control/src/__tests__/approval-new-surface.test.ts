// What the surface revision declares, in the conservative access diff (ADR-0050): a new token purpose, a site that
// starts signing one and a longer lifetime widen; a GET mutation and a new egress origin widen with closer review; a
// mount's promise of backward compatibility and a public query's `http.cache` are shown and widen nothing.

import type {
	ContractArtifact,
	DeclaredEgress,
	DeclaredReach,
	EndpointCache,
	EndpointRow,
	MountArtifact,
	ProcedureArtifact,
	TokenPurposeArtifact,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { classifyAccess, PUBLIC_EGRESS_LINE, snapshotDeviations } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const reach: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }
const UNSUBSCRIBE: TokenPurposeArtifact = { claims: { type: 'object', fields: { email: { type: 'boolean' } } }, maxDays: 400 }

function snapshot(tokens: Readonly<Record<string, TokenPurposeArtifact>> | null, signs: readonly string[] = []): AccessSnapshot {
	const contract: ContractArtifact = {
		...notesArtifact,
		declared: signs.length === 0 ? {} : { 'job:mailing': { ...reach, signs } },
		...(tokens === null ? {} : { tokens }),
	}
	return { version: 1, contract, migrations: [], checker: '0.0.0' }
}

describe('signed tokens in the approval diff', () => {
	test('a new purpose and a job that signs it widen', () => {
		expect(classifyAccess(snapshot(null), snapshot({ unsubscribe: UNSUBSCRIBE }, ['unsubscribe']))).toEqual({
			outcome: 'widening',
			changes: [
				{ effect: 'widens', line: 'New token purpose `unsubscribe`, a token of it valid up to 400 days' },
				{ effect: 'widens', line: 'Job `mailing` signs `unsubscribe` tokens' },
			],
		})
	})

	test('a longer lifetime widens, a shorter one and a dropped signs narrow', () => {
		const longer = { unsubscribe: { ...UNSUBSCRIBE, maxDays: 500 } }
		expect(classifyAccess(snapshot({ unsubscribe: UNSUBSCRIBE }, ['unsubscribe']), snapshot(longer, ['unsubscribe'])).changes).toEqual([
			{ effect: 'widens', line: 'Token purpose `unsubscribe` lifetime changes from 400 to 500 days' },
		])
		expect(classifyAccess(snapshot(longer, ['unsubscribe']), snapshot({ unsubscribe: UNSUBSCRIBE })).changes).toEqual([
			{ effect: 'narrows', line: 'Token purpose `unsubscribe` lifetime changes from 500 to 400 days' },
			{ effect: 'narrows', line: 'Job `mailing` no longer signs `unsubscribe` tokens' },
		])
	})
})

describe('egress in the approval diff', () => {
	const calling = (egress: DeclaredEgress): AccessSnapshot => {
		const contract: ContractArtifact = { ...notesArtifact, declared: { 'job:sync': { ...reach, egress } } }
		return { version: 1, contract, migrations: [], checker: '0.0.0' }
	}

	test('a new origin widens with closer review, and a dropped one narrows', () => {
		expect(classifyAccess(calling(['https://api.example.com']), calling(['https://api.example.com', 'https://hooks.example.com'])).changes)
			.toEqual([{ effect: 'widens', line: 'Job `sync` calls https://hooks.example.com', review: 'closer' }])
		expect(classifyAccess(calling(['https://api.example.com', 'https://hooks.example.com']), calling(['https://api.example.com'])).changes)
			.toEqual([{ effect: 'narrows', line: 'Job `sync` no longer calls https://hooks.example.com' }])
	})

	test("a job that moves to egress: 'public' widens with closer review, once, and moving back narrows", () => {
		const anywhere = `Job \`sync\` ${PUBLIC_EGRESS_LINE}`
		expect(classifyAccess(calling(['https://api.example.com']), calling('public'))).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: anywhere, review: 'closer' }],
		})
		expect(classifyAccess(calling('public'), calling(['https://api.example.com'])).changes).toEqual([
			{ effect: 'narrows', line: 'Job `sync` no longer calls any public website, only https://api.example.com' },
		])
		expect(classifyAccess(calling('public'), calling('public')).changes).toEqual([])
	})

	test("the published snapshot lists a job's egress: 'public' among its steps off the paved road", () => {
		expect(snapshotDeviations(calling('public'))).toEqual([{
			subject: 'Job `sync`',
			steps: [PUBLIC_EGRESS_LINE],
		}])
	})
})

describe('a GET mutation in the approval diff', () => {
	const rules: ProcedureArtifact = {
		rate: { perClient: 10, perCaller: null, perEndpoint: 100, bytesPerHour: null },
		challenge: null,
		timeoutMs: 10_000,
	}
	const withRules = (procedure: ProcedureArtifact): AccessSnapshot => {
		const { contract } = snapshot(null)
		if (contract === null) throw new Error('the snapshot holds a contract')
		return { version: 1, contract: { ...contract, procedures: { 'api.mail.click': procedure } }, migrations: [], checker: '0.0.0' }
	}

	test('a procedure that starts changing state on GET widens with closer review; one that stops narrows', () => {
		expect(classifyAccess(withRules(rules), withRules({ ...rules, changesStateOnGet: true })).changes).toEqual([
			{ effect: 'widens', line: '`api.mail.click` changes state on GET; link scanners may trigger it', review: 'closer' },
		])
		expect(classifyAccess(withRules({ ...rules, changesStateOnGet: true }), withRules(rules)).changes).toEqual([
			{ effect: 'narrows', line: '`api.mail.click` no longer changes state on GET' },
		])
	})
})

describe('a mount promise in the approval diff', () => {
	const mounted = (partners: MountArtifact): AccessSnapshot => ({
		version: 1,
		contract: { ...notesArtifact, mounts: { ...notesArtifact.mounts, partners } },
		migrations: [],
		checker: '0.0.0',
	})
	const unchecked: MountArtifact = { kind: 'rpc', prefix: '/api/v1', callers: ['machine'] }

	test('a promise made or dropped is shown, and widens nothing', () => {
		expect(classifyAccess(mounted(unchecked), mounted({ ...unchecked, compatibility: 'backward' })).changes).toEqual([
			{
				effect: 'neutral',
				line: 'Mount `partners` promises its callers backward compatibility: a deploy that breaks one of its procedures is refused',
			},
		])
		expect(classifyAccess(mounted({ ...unchecked, compatibility: 'backward' }), mounted(unchecked)).changes).toEqual([
			{ effect: 'neutral', line: 'Mount `partners` no longer promises backward compatibility; this deploy is the last one held to it' },
		])
	})
})

describe('http.cache in the approval diff', () => {
	const search = (cache?: EndpointCache): EndpointRow => ({
		id: 'api.catalog.search',
		source: { kind: 'mount', name: 'api' },
		kind: 'public',
		method: 'GET',
		path: '/api/catalog.search',
		admission: null,
		input: null,
		output: { type: 'object', fields: {} },
		callers: [],
		requirement: null,
		...(cache === undefined ? {} : { cache }),
	})
	const serving = (rows: readonly EndpointRow[]): AccessSnapshot => ({
		version: 1,
		contract: { ...notesArtifact, endpoints: [...notesArtifact.endpoints, ...rows] },
		migrations: [],
		checker: '0.0.0',
	})

	test('a new cached endpoint says how long its answers are reused, and a changed lifetime is shown', () => {
		expect(classifyAccess(serving([]), serving([search('immutable')])).changes.map((change) => change.line)).toEqual([
			'New endpoint `api.catalog.search` (GET /api/catalog.search) for anyone, without signing in, whose successful answers a browser or a CDN reuses for a year: its input must name a value that never changes',
		])
		expect(classifyAccess(serving([search({ maxAgeSeconds: 60 })]), serving([search()])).changes).toEqual([
			{ effect: 'neutral', line: 'Endpoint `api.catalog.search` answers are no longer reused' },
		])
		expect(classifyAccess(serving([search()]), serving([search({ maxAgeSeconds: 60 })])).changes).toEqual([
			{ effect: 'neutral', line: 'Endpoint `api.catalog.search`, whose successful answers a browser or a CDN reuses for 60 s' },
		])
	})
})
