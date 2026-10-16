// A public SPA in the conservative access diff (ADR-0050 §3): a new one, and a member SPA that becomes one, widen. A
// removed SPA mount is one line that says who answers its paths now, and it widens only when that admits more callers.

import type { EndpointRow } from '@fabrika/auth-core'
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
		expect(classification.changes).toContainEqual({ effect: 'widens', line: 'New endpoint `site` (GET /site/*) for anyone, without signing in' })
	})

	test('a member SPA that becomes public widens', () => {
		const candidate = snapshot(edited(MEMBER_SPA, "app: c.spa('/', { dir: 'dist/app', access: { public: true } }),"))
		const classification = classifyAccess(snapshot(), candidate)
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toContainEqual({ effect: 'widens', line: 'Endpoint `app` becomes public: anyone opens it without signing in' })
	})

	const PUBLIC_SPA = "app: c.spa('/', { dir: 'dist/app', access: { public: true } }),"
	const withMount = (root: string, mount: string) => snapshot(edited(MEMBER_SPA, `${root}\n\t${mount}`))
	const INTEREST = "interest: c.spa('/interest', { dir: 'dist/interest', access: { public: true } }),"

	test('a public SPA mount removed, its paths falling to a public SPA, changes nothing: one neutral line for the mount', () => {
		expect(classifyAccess(withMount(PUBLIC_SPA, INTEREST), snapshot(edited(MEMBER_SPA, PUBLIC_SPA)))).toEqual({
			outcome: 'removal',
			changes: [{
				effect: 'neutral',
				line: 'Mount `interest` is removed: GET /interest/* and GET /interest now reach `app` for anyone, without signing in, as before',
			}],
		})
	})

	test('a public SPA mount removed, its paths falling to a member SPA, narrows', () => {
		expect(classifyAccess(withMount(MEMBER_SPA, INTEREST), snapshot()).changes).toEqual([{
			effect: 'narrows',
			line:
				'Mount `interest` is removed: GET /interest/* and GET /interest now reach `app` for human callers who are members, where they were for anyone, without signing in',
		}])
	})

	test('a member SPA mount removed, its paths falling to a public SPA, widens', () => {
		const admin = "admin: c.spa('/admin', { dir: 'dist/admin', access: { member: true } }),"
		const classification = classifyAccess(withMount(PUBLIC_SPA, admin), snapshot(edited(MEMBER_SPA, PUBLIC_SPA)))
		expect(classification).toEqual({
			outcome: 'widening',
			changes: [{
				effect: 'widens',
				line:
					'Mount `admin` is removed: GET /admin/* and GET /admin now reach `app` for anyone, without signing in, where they were for human callers who are members',
			}],
		})
	})

	test('a member SPA mount removed, its paths falling to a member SPA of the same requirement, changes nothing', () => {
		const admin = "admin: c.spa('/admin', { dir: 'dist/admin', access: { member: true } }),"
		expect(classifyAccess(withMount(MEMBER_SPA, admin), snapshot()).changes).toEqual([{
			effect: 'neutral',
			line: 'Mount `admin` is removed: GET /admin/* and GET /admin now reach `app` for human callers who are members, as before',
		}])
	})
})

// Rows the contract source cannot spell easily, set on the artifact: what the diff must still classify right.
describe('a removed endpoint whose paths fall through, on rows set by hand', () => {
	const withRows = (
		source: string,
		rows: (endpoints: readonly EndpointRow[]) => readonly EndpointRow[],
	): AccessSnapshot => {
		const base = snapshot(source)
		if (base.contract === null) throw new Error('the base has no contract')
		return { ...base, contract: { ...base.contract, endpoints: rows(base.contract.endpoints) } }
	}
	const PUBLIC = edited(MEMBER_SPA, "app: c.spa('/', { dir: 'dist/app', access: { public: true } }),")
	const INTEREST = edited(
		MEMBER_SPA,
		"app: c.spa('/', { dir: 'dist/app', access: { public: true } }),\n\tinterest: c.spa('/interest', { dir: 'dist/interest', access: { public: true } }),",
	)

	test('routes of one mount worded alike but classified apart keep apart: a widening one is never hidden behind a narrowing one', () => {
		// `interest` admitted any origin and loses it (narrows); `interest.prefix` admitted none and gains the list (widens).
		const baseline = withRows(INTEREST, (rows) => rows.map((row) => (row.id === 'interest' ? { ...row, crossOrigin: 'any' } : row)))
		const candidate = withRows(PUBLIC, (rows) => rows.map((row) => (row.id === 'app' ? { ...row, crossOrigin: 'environment' } : row)))
		const classification = classifyAccess(baseline, candidate)
		expect(classification.outcome).toBe('widening')
		expect(classification.changes.find((change) => change.line.startsWith('Mount `interest`'))?.effect).toBe('widens')
	})

	const linkRow = (rows: readonly EndpointRow[], id: string, path: string, mount: string): EndpointRow => {
		const get = rows.find((row) => row.id === 'api.get')
		if (get === undefined || get.requirement === null) throw new Error('the base has no api.get')
		return { ...get, id, path, source: { kind: 'mount', name: mount }, callers: ['link'] }
	}

	test("a link mount's path falling to another link mount's endpoint widens: a link holder reaches only its own mount", () => {
		const baseline = withRows(PUBLIC, (rows) => [...rows, linkRow(rows, 'a.get', '/x/a', 'a'), linkRow(rows, 'b.all', '/x/*', 'b')])
		const candidate = withRows(PUBLIC, (rows) => [...rows, linkRow(rows, 'b.all', '/x/*', 'b')])
		expect(classifyAccess(baseline, candidate).changes.find((change) => change.line.startsWith('Endpoint `a.get`'))?.effect).toBe('widens')
	})

	test("a link endpoint's path falling to an endpoint of the same link mount changes nothing", () => {
		const baseline = withRows(PUBLIC, (rows) => [...rows, linkRow(rows, 'b.one', '/x/a', 'b'), linkRow(rows, 'b.all', '/x/*', 'b')])
		const candidate = withRows(PUBLIC, (rows) => [...rows, linkRow(rows, 'b.all', '/x/*', 'b')])
		// The rows are set by hand and declare no mount, so each removal is an endpoint's, not a removed mount's.
		expect(classifyAccess(baseline, candidate).changes.find((change) => change.line.startsWith('Endpoint `b.one`'))).toEqual({
			effect: 'neutral',
			line: 'Endpoint `b.one` (POST /x/a) is removed; its paths now reach `b.all` for link callers with `notes.read` (on `note`), as before',
		})
	})

	const anonymous = (rows: readonly EndpointRow[], id: string, kind: 'form' | 'webhook', path: string): EndpointRow => {
		const get = rows.find((row) => row.id === 'api.get')
		if (get === undefined) throw new Error('the base has no api.get')
		return { ...get, id, kind, path, source: { kind: 'mount', name: id }, callers: [], requirement: null, admission: null }
	}

	test('a form whose path falls to another anonymous endpoint widens: a form turns callers away itself', () => {
		const baseline = withRows(
			PUBLIC,
			(rows) => [...rows, anonymous(rows, 'contact', 'form', '/hooks/x'), anonymous(rows, 'hook', 'webhook', '/hooks/:binding')],
		)
		const candidate = withRows(PUBLIC, (rows) => [...rows, anonymous(rows, 'hook', 'webhook', '/hooks/:binding')])
		expect(classifyAccess(baseline, candidate).changes.find((change) => change.line.startsWith('Endpoint `contact`'))?.effect).toBe('widens')
	})

	test('a scope read from a path parameter is never the same on a broader route: it reads another segment', () => {
		const scoped = (rows: readonly EndpointRow[], id: string, path: string): EndpointRow => {
			const get = rows.find((row) => row.id === 'api.get')
			if (get === undefined) throw new Error('the base has no api.get')
			return { ...get, id, path, source: { kind: 'mount', name: 'p' } }
		}
		const baseline = withRows(PUBLIC, (rows) => [...rows, scoped(rows, 'p.one', '/x/:org/:id'), scoped(rows, 'p.all', '/x/:id/*')])
		const candidate = withRows(PUBLIC, (rows) => [...rows, scoped(rows, 'p.all', '/x/:id/*')])
		expect(classifyAccess(baseline, candidate).changes.find((change) => change.line.startsWith('Endpoint `p.one`'))?.effect).toBe('widens')
	})
})

describe('a removed mount takes more than its routes', () => {
	test('an SPA mount that served public variables narrows, and the line names them, though its paths reach the same callers', () => {
		const withSignup = edited(
			MEMBER_SPA,
			"app: c.spa('/', { dir: 'dist/app', access: { public: true } }),\n\tinterest: c.spa('/interest', { dir: 'dist/interest', access: { public: true }, public: ['SIGNUP_URL'] }),",
		)
		expect(classifyAccess(snapshot(withSignup), snapshot(edited(MEMBER_SPA, "app: c.spa('/', { dir: 'dist/app', access: { public: true } }),"))))
			.toEqual({
				outcome: 'removal',
				changes: [{
					effect: 'narrows',
					line:
						'Mount `interest` is removed: GET /interest/* and GET /interest now reach `app` for anyone, without signing in, as before; its pages no longer get the public variable `SIGNUP_URL`',
				}],
			})
	})
})
