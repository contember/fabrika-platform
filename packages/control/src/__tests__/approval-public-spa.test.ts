// A public SPA in the conservative access diff (ADR-0050 §3): a new one, and a member SPA that becomes one, widen. A
// removed SPA mount is one line that says who answers its paths now, and it widens only when that admits more callers.

import type { CredentialedEndpoint, EndpointRow } from '@fabrika/auth-core'
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
			outcome: 'no-widening',
			changes: [{
				effect: 'neutral',
				line: 'Mount `interest` is removed: GET /interest/* and GET /interest now reach `app` for anyone, without signing in, as before',
			}],
		})
	})

	test('a public SPA mount removed while only narrower SPAs remain narrows: they answer their own paths, not its', () => {
		const SITE = "site: c.spa('/site', { dir: 'dist/site', access: { public: true } }),"
		const baseline = snapshot(edited(MEMBER_SPA, `${PUBLIC_SPA}\n\t${SITE}`))
		const candidate = snapshot(edited(MEMBER_SPA, SITE))
		expect(classifyAccess(baseline, candidate)).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'Mount `app` is removed: GET /* is denied' }],
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

	test('paths only some of which reach an endpoint narrow, though it admits the same callers, and the line says the rest are denied', () => {
		// `/:page/x` loses to `/a/*` on `/a/x` while both stand, so it answers that path only once `/a/*` is gone.
		const publicRow = (rows: readonly EndpointRow[], id: string, path: string): EndpointRow => {
			const app = rows.find((row) => row.id === 'app')
			if (app === undefined) throw new Error('the base has no app')
			return { ...app, id, path, source: { kind: 'mount', name: id } }
		}
		const without = (rows: readonly EndpointRow[]) => rows.filter((row) => row.id !== 'app')
		const baseline = withRows(PUBLIC, (rows) => [...without(rows), publicRow(rows, 'area', '/a/*'), publicRow(rows, 'page', '/:page/x')])
		const candidate = withRows(PUBLIC, (rows) => [...without(rows), publicRow(rows, 'page', '/:page/x')])
		expect(classifyAccess(baseline, candidate).changes.find((change) => change.line.startsWith('Endpoint `area`'))).toEqual({
			effect: 'narrows',
			line: 'Endpoint `area` (GET /a/*) is removed; its paths now reach `page` for anyone, without signing in, as before, and are otherwise denied',
		})
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
			"app: c.spa('/', { dir: 'dist/app', access: { public: true } }),\n\tinterest: c.spa('/interest', { dir: 'dist/interest', access: { public: true }, browserConfig: ['SIGNUP_URL'] }),",
		)
		expect(classifyAccess(snapshot(withSignup), snapshot(edited(MEMBER_SPA, "app: c.spa('/', { dir: 'dist/app', access: { public: true } }),"))))
			.toEqual({
				outcome: 'no-widening',
				changes: [{
					effect: 'narrows',
					line:
						'Mount `interest` is removed: GET /interest/* and GET /interest now reach `app` for anyone, without signing in, as before; its pages no longer get the public variable `SIGNUP_URL`',
				}],
			})
	})
})

describe("who answers a removed endpoint's paths, one rule at a time", () => {
	const withRows = (rows: (endpoints: readonly EndpointRow[]) => readonly EndpointRow[]): AccessSnapshot => {
		const base = snapshot(edited(MEMBER_SPA, "app: c.spa('/', { dir: 'dist/app', access: { public: true } }),"))
		if (base.contract === null) throw new Error('the base has no contract')
		return { ...base, contract: { ...base.contract, endpoints: rows(base.contract.endpoints) } }
	}
	const template = (rows: readonly EndpointRow[]): CredentialedEndpoint => {
		const get = rows.find((row) => row.id === 'api.get')
		if (get === undefined || get.requirement === null) throw new Error('the base has no signed-in api.get')
		return get
	}
	const effectOf = (baseline: AccessSnapshot, candidate: AccessSnapshot, id: string) =>
		classifyAccess(baseline, candidate).changes.find((change) => change.line.startsWith(`Endpoint \`${id}\``))?.effect

	test('a webhook whose path falls to another anonymous endpoint widens: a webhook turns callers away itself', () => {
		const anonymous = (rows: readonly EndpointRow[], id: string, kind: 'webhook' | 'form', path: string): EndpointRow => ({
			...template(rows),
			id,
			kind,
			path,
			source: { kind: 'mount', name: id },
			callers: [],
			requirement: null,
			admission: null,
		})
		const baseline = withRows((
			rows,
		) => [...rows, anonymous(rows, 'stripe', 'webhook', '/hooks/stripe'), anonymous(rows, 'any', 'webhook', '/hooks/:binding')])
		const candidate = withRows((rows) => [...rows, anonymous(rows, 'any', 'webhook', '/hooks/:binding')])
		expect(effectOf(baseline, candidate, 'stripe')).toBe('widens')
	})

	test('an answering endpoint open to more origins widens, with the same callers and requirement', () => {
		const at = (rows: readonly EndpointRow[], id: string, path: string, crossOrigin?: 'environment'): EndpointRow => ({
			...template(rows),
			id,
			path,
			source: { kind: 'mount', name: 'x' },
			...(crossOrigin === undefined ? {} : { crossOrigin }),
		})
		const baseline = withRows((rows) => [...rows, at(rows, 'x.one', '/x/one'), at(rows, 'x.all', '/x/*', 'environment')])
		const candidate = withRows((rows) => [...rows, at(rows, 'x.all', '/x/*', 'environment')])
		expect(effectOf(baseline, candidate, 'x.one')).toBe('widens')
		// The paths now open to the environment's list, so the approval names the list beside this line.
		expect(classifyAccess(baseline, candidate).changes.find((change) => change.line.startsWith('Endpoint `x.one`'))?.environmentOrigins).toBe(true)
	})

	test('an answering endpoint that admits a caller kind more widens; one that admits a caller kind fewer narrows', () => {
		const at = (rows: readonly EndpointRow[], id: string, path: string, callers: readonly ['human', ...('human' | 'machine')[]]): EndpointRow => ({
			...template(rows),
			id,
			path,
			source: { kind: 'mount', name: 'x' },
			callers,
		})
		const human = withRows((rows) => [...rows, at(rows, 'x.one', '/x/one', ['human']), at(rows, 'x.all', '/x/*', ['human', 'machine'])])
		const both = withRows((rows) => [...rows, at(rows, 'x.one', '/x/one', ['human', 'machine']), at(rows, 'x.all', '/x/*', ['human'])])
		expect(effectOf(human, withRows((rows) => [...rows, at(rows, 'x.all', '/x/*', ['human', 'machine'])]), 'x.one')).toBe('widens')
		expect(effectOf(both, withRows((rows) => [...rows, at(rows, 'x.all', '/x/*', ['human'])]), 'x.one')).toBe('narrows')
	})

	test('a delegation is compared only after a signed-in endpoint: after one anyone opens, none admits more', () => {
		const creates = (rows: readonly EndpointRow[], id: string, path: string): EndpointRow => ({
			...template(rows),
			id,
			path,
			method: 'GET',
			source: { kind: 'mount', name: 'x' },
			requirement: { kind: 'action', action: 'notes.write', access: { form: 'creates', dimension: 'note' } },
			admission: null,
		})
		const open = (rows: readonly EndpointRow[]): EndpointRow => ({
			...template(rows),
			id: 'probe',
			kind: 'health',
			method: 'GET',
			path: '/files/x',
			source: { kind: 'mount', name: 'probe' },
			callers: [],
			requirement: null,
			admission: null,
		})
		const baseline = withRows((rows) => [...rows, open(rows), creates(rows, 'x.all', '/files/*')])
		const candidate = withRows((rows) => [...rows, creates(rows, 'x.all', '/files/*')])
		expect(effectOf(baseline, candidate, 'probe')).toBe('narrows')
	})

	test('two signed-in endpoints with the same requirement but another delegation are not the same callers', () => {
		const on = (rows: readonly EndpointRow[], id: string, path: string): EndpointRow => ({
			...template(rows),
			id,
			path,
			source: { kind: 'mount', name: 'x' },
			requirement: { kind: 'action', action: 'notes.write', access: { form: 'on', dimension: 'note', from: 'id' } },
		})
		const rows = (endpoints: readonly EndpointRow[]) => [...endpoints, on(endpoints, 'x.one', '/x/one'), on(endpoints, 'x.all', '/x/*')]
		const baseline = withRows(rows)
		const without = withRows(rows)
		if (without.contract === null) throw new Error('the base has no contract')
		const note = without.contract.dimensions['note']
		if (note === undefined) throw new Error('the base has no note dimension')
		// `notes.write` becomes the action that manages the members of `note`: the answering endpoint now delegates.
		const candidate: AccessSnapshot = {
			...without,
			contract: {
				...without.contract,
				endpoints: without.contract.endpoints.filter((row) => row.id !== 'x.one'),
				dimensions: { ...without.contract.dimensions, note: { ...note, members: { manage: 'notes.write', list: 'notes.read' } } },
			},
		}
		expect(effectOf(baseline, candidate, 'x.one')).toBe('widens')
		// The same change without the delegation leaves the callers as they were.
		const unchanged = withRows((endpoints) => rows(endpoints).filter((row) => row.id !== 'x.one'))
		expect(effectOf(baseline, unchanged, 'x.one')).toBe('neutral')
	})
})
