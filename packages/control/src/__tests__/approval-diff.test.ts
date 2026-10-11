// The conservative access diff (ADR-0050 §3): each kind of change, its outcome and its plain-language line.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import { ContractError, readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess, pathsOverlap } from '../approval/diff'
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

/** `BASE` whose `api.remove` mutation accepts `fields` beside its `id`. */
const removeInput = (fields: string) =>
	snapshot(
		edited('remove: c.mutation({ input: z.strictObject({ id: z.uuid() })', `remove: c.mutation({ input: z.strictObject({ id: z.uuid(), ${fields} })`),
	)

/** The classification of `api.remove`'s extra input `before` changing to `after`, in both directions. */
function inputChange(before: string, after: string) {
	return { forward: classifyAccess(removeInput(before), removeInput(after)), backward: classifyAccess(removeInput(after), removeInput(before)) }
}

describe('classifyAccess compares input domains', () => {
	test('a literal widened to an enum widens and names the value; narrowing it back only removes', () => {
		const { forward, backward } = inputChange(`stage: z.literal('lead')`, `stage: z.enum(['lead', 'won'])`)
		expect(forward).toEqual({ outcome: 'widening', changes: [{ widens: true, line: 'Endpoint `api.remove` input `stage` admits `won`' }] })
		expect(backward).toEqual({ outcome: 'removal', changes: [{ widens: false, line: 'Endpoint `api.remove` input `stage` no longer admits `won`' }] })
	})

	test('an enum that gains a value widens', () => {
		const { forward, backward } = inputChange(`stage: z.enum(['lead', 'won'])`, `stage: z.enum(['lead', 'won', 'lost'])`)
		expect(forward.changes).toEqual([{ widens: true, line: 'Endpoint `api.remove` input `stage` admits `lost`' }])
		expect(backward.outcome).toBe('removal')
	})

	test('an enum that trades one value for another widens', () => {
		expect(inputChange(`stage: z.enum(['lead', 'won'])`, `stage: z.enum(['lead', 'lost'])`).forward).toEqual({
			outcome: 'widening',
			changes: [
				{ widens: true, line: 'Endpoint `api.remove` input `stage` admits `lost`' },
				{ widens: false, line: 'Endpoint `api.remove` input `stage` no longer admits `won`' },
			],
		})
	})

	test('a removed or raised maximum length widens; a lowered one only removes', () => {
		expect(inputChange('title: z.string().max(200)', 'title: z.string()').forward).toEqual({
			outcome: 'widening',
			changes: [{ widens: true, line: 'Endpoint `api.remove` input `title` maximum length changes from 200 to none' }],
		})
		const { forward, backward } = inputChange('title: z.string().max(200)', 'title: z.string().max(300)')
		expect(forward.outcome).toBe('widening')
		expect(backward).toEqual({
			outcome: 'removal',
			changes: [{ widens: false, line: 'Endpoint `api.remove` input `title` maximum length changes from 300 to 200' }],
		})
	})

	test('a removed or lowered minimum widens; a raised one only removes', () => {
		expect(inputChange('title: z.string().min(3)', 'title: z.string().min(1)').forward.changes).toEqual([
			{ widens: true, line: 'Endpoint `api.remove` input `title` minimum length changes from 3 to 1' },
		])
		const { forward, backward } = inputChange('count: z.number().min(0).max(10)', 'count: z.number().max(10)')
		expect(forward.changes).toEqual([{ widens: true, line: 'Endpoint `api.remove` input `count` minimum changes from 0 to none' }])
		expect(backward.outcome).toBe('removal')
		expect(inputChange('count: z.number().min(0)', 'count: z.number().gt(0)').forward.outcome).toBe('removal')
		expect(inputChange('count: z.number().int()', 'count: z.number()').forward.outcome).toBe('widening')
	})

	test('a removed pattern widens; an added one only removes', () => {
		const { forward, backward } = inputChange('code: z.string().regex(/^[a-z]+$/)', 'code: z.string()')
		expect(forward.outcome).toBe('widening')
		expect(backward.outcome).toBe('removal')
	})

	test('a field that becomes optional or nullable widens; the reverse only removes', () => {
		const optional = inputChange('title: z.string()', 'title: z.string().optional()')
		expect(optional.forward.changes).toEqual([{ widens: true, line: 'Endpoint `api.remove` input `title` becomes optional' }])
		expect(optional.backward.changes).toEqual([{ widens: false, line: 'Endpoint `api.remove` input `title` becomes required' }])
		const nullable = inputChange('title: z.string()', 'title: z.string().nullable()')
		expect(nullable.forward.changes).toEqual([{ widens: true, line: 'Endpoint `api.remove` input `title` admits null' }])
		expect(nullable.backward.outcome).toBe('removal')
	})

	test('a new accepted field widens, optional or not; a removed optional field only removes', () => {
		const { forward, backward } = inputChange('title: z.string()', 'title: z.string(), body: z.string().optional()')
		expect(forward).toEqual({ outcome: 'widening', changes: [{ widens: true, line: 'Endpoint `api.remove` input gains field `body`' }] })
		expect(backward).toEqual({ outcome: 'removal', changes: [{ widens: false, line: 'Endpoint `api.remove` input loses field `body`' }] })
		expect(inputChange('title: z.string()', 'title: z.string(), body: z.string()').forward.outcome).toBe('widening')
	})

	test('a removed required field widens: an input without it is admitted that was refused before', () => {
		expect(inputChange('title: z.string(), body: z.string()', 'title: z.string()').forward).toEqual({
			outcome: 'widening',
			changes: [{ widens: true, line: 'Endpoint `api.remove` input loses required field `body`' }],
		})
	})

	test('a changed type widens', () => {
		expect(inputChange('count: z.number()', 'count: z.string()').forward.outcome).toBe('widening')
		expect(inputChange(`stage: z.enum(['lead', 'won'])`, 'stage: z.string()').forward.outcome).toBe('widening')
	})

	test('a nested field is named through arrays and nullable objects', () => {
		const items = inputChange(
			`items: z.array(z.strictObject({ stage: z.literal('lead') })).max(10)`,
			`items: z.array(z.strictObject({ stage: z.enum(['lead', 'won']) })).max(10)`,
		)
		expect(items.forward.changes).toEqual([{ widens: true, line: 'Endpoint `api.remove` input `items[].stage` admits `won`' }])
		const deal = inputChange(
			`deal: z.strictObject({ stage: z.literal('lead') }).nullable()`,
			`deal: z.strictObject({ stage: z.literal('lead'), note: z.string().optional() }).nullable()`,
		)
		expect(deal.forward.changes).toEqual([{ widens: true, line: 'Endpoint `api.remove` input `deal` gains field `note`' }])
		expect(inputChange('tags: z.array(z.string()).max(5)', 'tags: z.array(z.string())').forward.changes).toEqual([
			{ widens: true, line: 'Endpoint `api.remove` input `tags` maximum items changes from 5 to none' },
		])
	})

	test('an unchanged input is unchanged', () => {
		expect(inputChange(`stage: z.enum(['lead', 'won'])`, `stage: z.enum(['won', 'lead'])`).forward).toEqual({ outcome: 'unchanged', changes: [] })
	})
})

describe('classifyAccess compares output shapes', () => {
	const notes = (note: string) =>
		snapshot(
			edited(
				'const Note = z.strictObject({ id: z.uuid(), title: z.string() })',
				`const Note = ${note}`,
				edited('output: Note', 'output: z.strictObject({ notes: z.array(Note), pinned: z.nullable(Note) })'),
			),
		)

	test('an output field gained inside an array or a nullable object widens and is named', () => {
		const wider = notes('z.strictObject({ id: z.uuid(), title: z.string(), body: z.string() })')
		const before = notes('z.strictObject({ id: z.uuid(), title: z.string() })')
		expect(lines(before, wider)).toEqual([
			'Endpoint `api.get` output `notes[]` gains field `body`',
			'Endpoint `api.get` output `pinned` gains field `body`',
		])
		expect(classifyAccess(wider, before).outcome).toBe('removal')
	})

	test('any change of an output union widens: projection takes the first branch that accepts the result', () => {
		const output = (branches: string) => snapshot(edited('output: Note', `output: z.union([${branches}])`))
		const plain = 'z.strictObject({ title: z.string() })'
		const secret = 'z.strictObject({ title: z.string(), secret: z.string() })'
		const reordered = classifyAccess(output(`${plain}, ${secret}`), output(`${secret}, ${plain}`))
		expect(reordered.outcome).toBe('widening')
		expect(reordered.changes).toEqual([{ widens: true, line: expect.stringMatching(/^Endpoint `api.get` output changes from /) }])
		expect(classifyAccess(output(`${plain}, ${secret}`), output(secret)).outcome).toBe('widening')
		expect(classifyAccess(output(`${plain}, ${secret}`), output(plain)).outcome).toBe('widening')
	})

	test('an output default its own schema refuses is refused, since the endpoint would emit a value the shape does not admit', () => {
		const status = (schema: string) => snapshot(edited('output: Note', `output: z.strictObject({ status: ${schema} })`))
		expect(status('z.string().max(4).optional()').contract).not.toBeNull()
		expect(() => status(`z.string().max(4).default('unapproved')`)).toThrow(ContractError)
	})

	test('an output field removed only removes, required or not', () => {
		const before = notes('z.strictObject({ id: z.uuid(), title: z.string() })')
		const fewer = notes('z.strictObject({ id: z.uuid() })')
		expect(classifyAccess(before, fewer).outcome).toBe('removal')
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
