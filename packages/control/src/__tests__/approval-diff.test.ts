// The conservative access diff (ADR-0050 §3): each kind of change, its outcome and its plain-language line.

import { schemaFromContract } from '@fabrika/app/contract'
import { appSchemaSchema } from '@fabrika/auth'
import type { AppSchema, ArtifactAccess, TablePolicyArtifact } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { classifyAccess, IAM_SCHEMA_FIELDS, pathsOverlap } from '../approval/diff'
import { type AccessSnapshot, EMPTY_SNAPSHOT, type MigrationEntry } from '../approval/snapshot'
import { BASE, edited } from './helpers/contracts'

const NOTES_TABLE: TablePolicyArtifact = {
	scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
	actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
	insert: ['title'],
	update: ['title'],
	version: null,
	createdBy: null,
	columns: { secret: { read: 'notes.delete' } },
}

function snapshot(
	contract = BASE,
	tables: Readonly<Record<string, TablePolicyArtifact>> = { notes: NOTES_TABLE },
	migrations: MigrationEntry[] = [],
): AccessSnapshot {
	return {
		version: 1,
		contract: readContractSource(new Map([['fabrika.contract.ts', contract]]), tables),
		migrations,
		checker: '0.0.0',
		artifact: null,
	}
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

describe('classifyAccess — the artifact access of an application without a contract', () => {
	const NOTES_SCHEMA: AppSchema = {
		scopes: [{ type: 'workspace', creator: 'owner', members: { manage: 'members.manage', list: 'members.list' } }, { type: 'note', in: 'workspace' }],
		actions: [{ action: 'notes.read' }, { action: 'notes.write' }, { action: 'members.manage' }, { action: 'members.list' }],
		roles: {
			owner: { name: 'Owner', permissions: ['notes.read', 'notes.write', 'members.manage', 'members.list'], member: { scope: 'workspace' } },
			editor: { name: 'Editor', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			reader: { name: 'Reader', permissions: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		},
		links: { share: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.write', maxDays: 7 } },
		delegations: { 'api.invite': { action: 'members.manage', dimension: 'workspace', purpose: 'members' } },
	}
	const GATES = { rules: [{ path: '/*', kind: 'human' as const }] }
	const withAccess = (schema: AppSchema): AccessSnapshot => ({ ...EMPTY_SNAPSHOT, artifact: { gates: GATES, schema } })
	const schemaWith = (change: (schema: AppSchema) => AppSchema): AppSchema => change(structuredClone(NOTES_SCHEMA))

	test('a role that also becomes assignable by another role shows both changes', () => {
		const candidate = schemaWith((schema) => ({
			...schema,
			roles: {
				...schema.roles,
				editor: { name: 'Editor', permissions: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner', 'reader'] } },
			},
		}))
		expect(classifyAccess(withAccess(NOTES_SCHEMA), withAccess(candidate))).toEqual({
			outcome: 'widening',
			changes: [
				{ widens: true, line: 'IAM role `editor` gains `notes.write`' },
				{ widens: true, line: 'IAM role `editor` can be assigned by `reader`' },
			],
		})
	})

	test('every other access-bearing field of the schema shows its own line', () => {
		const cases: readonly [string, (schema: AppSchema) => AppSchema][] = [
			['IAM role `editor` membership scope changes from `"workspace"` to `"note"`', (schema) => ({
				...schema,
				roles: { ...schema.roles, editor: { name: 'Editor', permissions: ['notes.read'], member: { scope: 'note', assignableBy: ['owner'] } } },
			})],
			['IAM role `owner` is no longer a membership role of `workspace`', (schema) => ({
				...schema,
				roles: { ...schema.roles, owner: { name: 'Owner', permissions: ['notes.read', 'notes.write', 'members.manage', 'members.list'] } },
			})],
			['IAM scope `note` creator role changes from `null` to `"owner"`', (schema) => ({
				...schema,
				scopes: schema.scopes.map((scope) => (scope.type === 'note' ? { ...scope, creator: 'owner' } : scope)),
			})],
			['IAM link mount `share` grants `notes.write`', (schema) => ({
				...schema,
				links: { share: { dimension: 'note', grants: ['notes.read', 'notes.write'], issuedBy: 'notes.write', maxDays: 7 } },
			})],
			['IAM link mount `share` longest life in days changes from `7` to `30`', (schema) => ({
				...schema,
				links: { share: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.write', maxDays: 30 } },
			})],
			['New IAM delegation for endpoint `api.create`: `notes.write` on `workspace` (creates)', (schema) => ({
				...schema,
				delegations: { ...schema.delegations, 'api.create': { action: 'notes.write', dimension: 'workspace', purpose: 'creates' } },
			})],
			['IAM delegation for endpoint `api.invite` is removed', (schema) => ({ ...schema, delegations: {} })],
			['The IAM schema contract flag changes from `null` to `false`', (schema) => ({ ...schema, contract: false })],
		]
		for (const [line, change] of cases) {
			expect(classifyAccess(withAccess(NOTES_SCHEMA), withAccess(schemaWith(change)))).toEqual({
				outcome: 'widening',
				changes: [{ widens: true, line }],
			})
		}
	})

	test('reordering a set or a catalog is no change', () => {
		const reordered = schemaWith((schema) => ({
			...schema,
			scopes: [...schema.scopes].reverse(),
			actions: [...schema.actions].reverse(),
			roles: {
				...schema.roles,
				reader: { name: 'Reader', permissions: ['notes.write', 'notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			},
		}))
		expect(classifyAccess(withAccess(NOTES_SCHEMA), withAccess(reordered))).toEqual({ outcome: 'unchanged', changes: [] })
	})

	test('every field IAM reads is classified by a field table', () => {
		const parsed = appSchemaSchema.parse({
			...NOTES_SCHEMA,
			contract: false,
			scopes: NOTES_SCHEMA.scopes.map((scope) => ({ ...scope, label: 'A scope' })),
			actions: NOTES_SCHEMA.actions.map((action) => ({ ...action, description: 'An action' })),
			roles: {
				...NOTES_SCHEMA.roles,
				reader: { name: 'Reader', description: 'Reads', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			},
		})
		const unclassified = (schema: AppSchema): string[] => {
			const missing: string[] = []
			const check = (where: string, entry: object, table: object): void => {
				for (const key of Object.keys(entry)) if (!Object.hasOwn(table, key)) missing.push(`${where}.${key}`)
			}
			check('schema', schema, IAM_SCHEMA_FIELDS.schema)
			for (const scope of schema.scopes) check('scope', scope, IAM_SCHEMA_FIELDS.scope)
			for (const action of schema.actions) check('action', action, IAM_SCHEMA_FIELDS.action)
			for (const role of Object.values(schema.roles)) {
				check('role', role, IAM_SCHEMA_FIELDS.role)
				if (role.member !== undefined) check('role.member', role.member, IAM_SCHEMA_FIELDS.roleMember)
			}
			for (const link of Object.values(schema.links ?? {})) check('link', link, IAM_SCHEMA_FIELDS.link)
			for (const delegation of Object.values(schema.delegations ?? {})) check('delegation', delegation, IAM_SCHEMA_FIELDS.delegation)
			for (const workload of schema.workloads ?? []) check('workload', workload, IAM_SCHEMA_FIELDS.workload)
			return missing
		}
		expect(unclassified(parsed)).toEqual([])
		expect(unclassified(schemaFromContract(notesArtifact))).toEqual([])
	})

	test('gates that start or stop applying are named', () => {
		const access = (gates: ArtifactAccess['gates']): AccessSnapshot => ({ ...EMPTY_SNAPSHOT, artifact: { gates, schema: null } })
		expect(lines(access(null), access({ rules: [] }))).toEqual(['Gates start to apply'])
		expect(lines(access(GATES), access(null))).toEqual(['Gates no longer apply', 'Gate `/* → human` is removed'])
	})
})
