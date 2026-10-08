// The conservative access diff (ADR-0050 §3): each kind of change, its outcome and its plain-language line.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess, pathsOverlap } from '../approval/diff'
import { type AccessSnapshot, EMPTY_SNAPSHOT, type MigrationEntry } from '../approval/snapshot'

const BASE = `import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

const Note = z.strictObject({ id: z.uuid(), title: z.string() })

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes', 'notes.delete': 'Delete notes' },
	roles: {
		owner: { grants: ['notes.read', 'notes.write', 'notes.delete'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
		remove: c.mutation({ input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ id: z.uuid() }), access: { action: 'notes.delete', on: 'note', from: 'id' } }),
	}),
	health: c.health('/healthz'),
	app: c.spa('/', { dir: 'dist/app', access: { member: true } }),
}))
`

const NOTES_TABLE: TablePolicyArtifact = {
	scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
	actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
	insert: ['title'],
	update: ['title'],
	version: null,
	createdBy: null,
	columns: { secret: { read: 'notes.delete' } },
}

const edited = (search: string, replacement: string, text = BASE): string => {
	if (!text.includes(search)) throw new Error(`the base has no '${search}'`)
	return text.replace(search, replacement)
}

function snapshot(
	contract = BASE,
	tables: Readonly<Record<string, TablePolicyArtifact>> = { notes: NOTES_TABLE },
	migrations: MigrationEntry[] = [],
): AccessSnapshot {
	return { version: 1, contract: readContractSource(new Map([['fabrika.contract.ts', contract]]), tables), migrations, checker: '0.0.0' }
}

const lines = (baseline: AccessSnapshot, candidate: AccessSnapshot) => classifyAccess(baseline, candidate).changes.map((change) => change.line)

describe('classifyAccess', () => {
	test('the same access is unchanged, whatever the checker version', () => {
		expect(classifyAccess(snapshot(), { ...snapshot(), checker: '9.9.9' })).toEqual({ outcome: 'unchanged', changes: [] })
	})

	test('a role that gains an action widens; one that loses it only removes', () => {
		const wider = snapshot(edited(`editor: { grants: ['notes.read', 'notes.write']`, `editor: { grants: ['notes.read', 'notes.write', 'notes.delete']`))
		expect(classifyAccess(snapshot(), wider)).toEqual({
			outcome: 'widening',
			changes: [{ widens: true, line: 'Role `editor` gains `notes.delete`' }],
		})
		expect(classifyAccess(wider, snapshot()).outcome).toBe('removal')
	})

	test('a new endpoint widens and names its callers and requirement', () => {
		const candidate = snapshot(edited(
			'\t}),\n\thealth',
			`\t\texport: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),\n\t}),\n\thealth`,
		))
		expect(lines(snapshot(), candidate)).toEqual(['New endpoint `api.export` (POST /api/export) for human callers with `notes.read` (on `note`)'])
	})

	test('a removed procedure passes when its path is denied: the SPA does not compete under the reserved /api prefix', () => {
		const candidate = snapshot(edited(
			`\t\tremove: c.mutation({ input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ id: z.uuid() }), access: { action: 'notes.delete', on: 'note', from: 'id' } }),\n`,
			'',
		))
		expect(classifyAccess(snapshot(), candidate)).toEqual({
			outcome: 'removal',
			changes: [{ widens: false, line: 'Endpoint `api.remove` (POST /api/remove) is removed; its paths are denied' }],
		})
	})

	test('a removed endpoint that shadowed a broader one widens: its path now reaches the SPA', () => {
		const candidate = snapshot(edited("\thealth: c.health('/healthz'),\n", ''))
		const classification = classifyAccess(snapshot(), candidate)
		expect(classification.outcome).toBe('widening')
		expect(classification.changes.map((change) => change.line)).toContain('Endpoint `health` (GET /healthz) is removed; its paths now reach `app`')
	})

	test('a caller added to an endpoint widens', () => {
		const candidate = snapshot(edited(`c.rpc('/api', { callers: ['human'] }`, `c.rpc('/api', { callers: ['human', 'machine'] }`))
		expect(lines(snapshot(), candidate)).toContain('Endpoint `api.get` gains caller `machine`')
		expect(classifyAccess(snapshot(), candidate).outcome).toBe('widening')
	})

	test('an output field added widens; one removed only removes', () => {
		const wider = snapshot(edited('title: z.string() })', 'title: z.string(), body: z.string() })'))
		expect(lines(snapshot(), wider)).toEqual(['Endpoint `api.get` output gains field `body`'])
		expect(classifyAccess(wider, snapshot()).outcome).toBe('removal')
	})

	test('a column that loses its read policy widens; a removed table only removes', () => {
		const { secret: _secret, ...columns } = NOTES_TABLE.columns
		const fallback = snapshot(BASE, { notes: { ...NOTES_TABLE, columns } })
		expect(classifyAccess(snapshot(), fallback)).toEqual({
			outcome: 'widening',
			changes: [{ widens: true, line: 'Column `notes.secret` loses its read policy `notes.delete` and is read with `notes.read`' }],
		})
		expect(classifyAccess(snapshot(), snapshot(BASE, {}))).toEqual({
			outcome: 'removal',
			changes: [{ widens: false, line: 'Table policy `notes` is removed' }],
		})
	})

	test('a new or changed migration widens; a removed one only removes', () => {
		const one = { name: '20260101000000_init.sql', checksum: 'a'.repeat(64) }
		const two = { name: '20260102000000_more.sql', checksum: 'b'.repeat(64) }
		expect(lines(snapshot(BASE, undefined, [one]), snapshot(BASE, undefined, [one, two]))).toEqual(['New migration `20260102000000_more.sql`'])
		expect(lines(snapshot(BASE, undefined, [one]), snapshot(BASE, undefined, [{ ...one, checksum: 'c'.repeat(64) }]))).toEqual([
			'Migration `20260101000000_init.sql` changes',
		])
		expect(classifyAccess(snapshot(BASE, undefined, [one, two]), snapshot(BASE, undefined, [one])).outcome).toBe('removal')
	})

	test('the first contract is all additions against the empty snapshot', () => {
		const classification = classifyAccess(EMPTY_SNAPSHOT, snapshot())
		expect(classification.outcome).toBe('widening')
		expect(classification.changes.filter((change) => !change.widens)).toEqual([{ widens: false, line: 'Reserved prefix `/api` is added' }])
		expect(classification.changes.map((change) => change.line)).toContain('The application becomes the contract application `notes`')
		expect(classification.changes.map((change) => change.line)).toContain('New role `editor` with `notes.read`, `notes.write`')
	})

	test('dropping the contract widens: the proxy would stop applying an endpoint table', () => {
		expect(classifyAccess(snapshot(), EMPTY_SNAPSHOT)).toEqual({
			outcome: 'widening',
			changes: [{ widens: true, line: 'The contract is removed: the proxy no longer applies an endpoint table to this application' }],
		})
		expect(classifyAccess(EMPTY_SNAPSHOT, EMPTY_SNAPSHOT).outcome).toBe('unchanged')
	})

	test('a membership role that loses its scope widens: it could then be granted globally', () => {
		const candidate = snapshot(
			edited(
				`editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } }`,
				`editor: { grants: ['notes.read', 'notes.write'] }`,
			),
		)
		expect(classifyAccess(snapshot(), candidate).outcome).toBe('widening')
	})
})

describe('pathsOverlap', () => {
	test.each([
		['/healthz', '/*', true],
		['/api/get', '/api/:name', true],
		['/api/get', '/api/list', false],
		['/a/:x', '/a/', false],
		['/a/*', '/a', false],
		['/a/*', '/a/b/c', true],
		['/a/:x', '/a/:y/c', false],
		['/', '/*', true],
		['/', '/a', false],
	])('%s and %s overlap: %p', (a, b, overlap) => {
		expect(pathsOverlap(a, b)).toBe(overlap)
		expect(pathsOverlap(b, a)).toBe(overlap)
	})
})
