// The surface of a published snapshot (ADR-0050): every endpoint under its most exposed caller, most exposed first, in
// the approval's words, with what else opens it to the outside.

import type { TablePolicyArtifact } from '@fabrika/auth-core-0.5'
import { readContractSource } from '@fabrika/check/contract'
import type { SurfaceEndpointDto } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
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

const WORKSPACES: TablePolicyArtifact = {
	scope: { mode: 'dimension', dimension: 'workspace', key: 'id', container: null },
	actions: { read: 'notes.read', insert: null, update: null, delete: null },
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

	test('a form with neither a rate limit nor a challenge says so', () => {
		const form = snapshotSurface(snapshot(exposed(''))).find((endpoint) => endpoint.kind === 'form')
		expect(form?.notes).toEqual(['no rate limit and no challenge'])
	})

	test('an endpoint that takes a value of an opaque root says that an application-wide grant admits any value', () => {
		const listed = edited(
			'\t}),\n\thealth',
			"\t\tlist: c.query({ input: z.strictObject({ workspaceId: z.uuid() }), output: z.strictObject({ ok: z.boolean() }), access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' } }),\n\t}),\n\thealth",
		)
		const surface = (tables: Readonly<Record<string, TablePolicyArtifact>>) =>
			snapshotSurface({ version: 1, contract: readContractSource(new Map([['fabrika.contract.ts', listed]]), tables), migrations: [], checker: '0.0.0' })
		const note = 'takes any `workspace` value under an application-wide grant: an opaque root, unchecked'
		expect(surface({}).find((endpoint) => endpoint.id === 'api.list')?.notes).toEqual([note])
		expect(surface({}).find((endpoint) => endpoint.id === 'api.get')?.notes).toEqual([])
		expect(surface({ workspaces: WORKSPACES }).find((endpoint) => endpoint.id === 'api.list')?.notes).toEqual([])
	})

	test('an environment with nothing published has no surface', () => {
		expect(snapshotSurface(EMPTY_SNAPSHOT)).toEqual([])
	})
})
