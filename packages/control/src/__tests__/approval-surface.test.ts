// The surface of a published snapshot (ADR-0050): every endpoint under its most exposed caller, most exposed first, in
// the approval's words, with what else opens it to the outside.

import type { EndpointRow, ProcedureArtifact } from '@fabrika/auth-core'
import type { TablePolicyArtifact } from '@fabrika/auth-core-0.5'
import type { SurfaceEndpointDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { type AccessSnapshot, EMPTY_SNAPSHOT } from '../approval/snapshot'
import { snapshotSurface } from '../approval/surface'
import { edited, snapshot05 } from './helpers/contracts'

const INBOX: TablePolicyArtifact = {
	scope: { mode: 'inbox', form: 'apply' },
	actions: { read: 'intake.read', insert: null, update: null, delete: null },
	insert: [],
	update: [],
	version: null,
	createdBy: null,
	columns: {},
}

/** A form is only a 0.5 application's, so the surface is read by that release's reader. */
function snapshot(contract: string): AccessSnapshot {
	return snapshot05(contract, { applications: INBOX })
}

const HEALTH = "health: c.health('/healthz'),"
const GET = "access: { action: 'notes.read', on: 'note', from: 'id' } }),"

/** `BASE` with a public site, a form that appends to an inbox, a webhook, and `api.get` open to machines and other origins. */
function exposed(formOptions: string): string {
	const vocabulary = edited("'notes.delete': 'Delete notes' },", "'notes.delete': 'Delete notes', 'intake.read': 'Read registrations' },")
	const roles = edited('roles: {', "roles: {\n\t\thr: { grants: ['intake.read'] },", vocabulary)
	const mounts = edited(
		HEALTH,
		`${HEALTH}
	site: c.spa('/site', { dir: 'dist/site', access: { public: true } }),
	apply: c.form('/apply', { input: z.strictObject({ name: z.string(), website: z.optional(z.string()) }), appendTo: 'applications'${formOptions} }),
	hook: c.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'app', actions: ['notes.write'], input: z.strictObject({ id: z.uuid() }) }),`,
		roles,
	)
	const machines = edited("c.rpc('/api', { callers: ['human'] }", "c.rpc('/api', { callers: ['human', 'machine'] }", mounts)
	return edited(GET, "access: { action: 'notes.read', on: 'note', from: 'id' }, crossOrigin: true }),", machines)
}

const line = ({ reach, method, path, requirement, notes }: SurfaceEndpointDto): string =>
	[`${reach} ${method} ${path}`, requirement ?? '', ...notes].filter((part) => part !== '').join(' · ')

describe('the surface of a published snapshot', () => {
	test('lists every endpoint under its most exposed caller, anonymous ones first, with what opens it further', () => {
		const surface = snapshotSurface(snapshot(exposed(", rate: { perClient: 6 }, honeypot: 'website'")))
		expect(surface.map(line)).toEqual([
			'anyone POST /apply · at most 6 submissions a minute per client · honeypot field `website`',
			'anyone GET /healthz',
			'anyone POST /hooks/github/:bindingId · verifies a github-sha256 signature',
			'anyone GET /site',
			'anyone GET /site/*',
			'machine POST /api/get · with `notes.read` (on `note`) · callable from a page on an origin the environment lists',
			'machine POST /api/remove · with `notes.delete` (on `note`)',
			'human GET /* · who are members',
		])
		expect(surface.find((endpoint) => endpoint.id === 'api.get')?.callers).toEqual(['human', 'machine'])
	})

	test('a public procedure names its buckets and its challenge, and one with neither says so', () => {
		const cta: EndpointRow = {
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
		const notesOf = (rules: ProcedureArtifact) =>
			snapshotSurface({ version: 1, contract: { ...notesArtifact, endpoints: [cta], procedures: { [cta.id]: rules } }, migrations: [], checker: '' })[0]
				?.notes
		const rate = { perClient: 10, perCaller: null, perEndpoint: 100, bytesPerHour: null }
		expect(notesOf({ rate, challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', action: 'api_stats_cta' }, timeoutMs: 10_000 })).toEqual([
			'at most 10 calls a minute per client (one client on Zerops)',
			'at most 100 calls a minute in all',
			'turnstile challenge',
		])
		expect(notesOf({ rate: { ...rate, perClient: null, perEndpoint: null }, challenge: null, timeoutMs: 10_000 })).toEqual([
			'no rate limit and no challenge',
		])
	})

	test('a form with neither a rate limit nor a challenge says so', () => {
		const form = snapshotSurface(snapshot(exposed(''))).find((endpoint) => endpoint.kind === 'form')
		expect(form?.notes).toEqual(['no rate limit and no challenge'])
	})

	test('an environment with nothing published has no surface', () => {
		expect(snapshotSurface(EMPTY_SNAPSHOT)).toEqual([])
	})
})
