// The conservative access diff (ADR-0050 §3): each kind of change, its outcome and its plain-language line.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import { ContractError, readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess, probePaths } from '../approval/diff'
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
		expect(classifyAccess(snapshot(), { ...snapshot(), checker: '9.9.9' })).toEqual({ outcome: 'none', changes: [] })
	})

	test('a role that gains an action widens; one that loses it only removes', () => {
		const wider = snapshot(edited(`editor: { grants: ['notes.read', 'notes.write']`, `editor: { grants: ['notes.read', 'notes.write', 'notes.delete']`))
		expect(classifyAccess(snapshot(), wider)).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' }],
		})
		expect(classifyAccess(wider, snapshot()).outcome).toBe('no-widening')
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
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'Endpoint `api.remove` (POST /api/remove) is removed; its paths are denied' }],
		})
	})

	test('a removed endpoint that shadowed a broader one names who answers its path now: an anonymous check falling to the member SPA narrows', () => {
		const candidate = snapshot(edited("\thealth: c.health('/healthz'),\n", ''))
		expect(classifyAccess(snapshot(), candidate)).toEqual({
			outcome: 'no-widening',
			changes: [{
				effect: 'narrows',
				line: 'Mount `health` is removed: GET /healthz now reaches `app` for human callers who are members, where it was for anonymous health requests',
			}],
		})
	})

	test('an anonymous check falling to a public SPA admits the same callers, but a removed health mount still narrows', () => {
		const publicBase = edited('access: { member: true } }),', 'access: { public: true } }),')
		const candidate = snapshot(edited("\thealth: c.health('/healthz'),\n", '', publicBase))
		expect(classifyAccess(snapshot(publicBase), candidate)).toEqual({
			outcome: 'no-widening',
			changes: [{
				effect: 'narrows',
				line: 'Mount `health` is removed: GET /healthz now reaches `app` for anyone, without signing in, where it was for anonymous health requests',
			}],
		})
	})

	test('a caller added to an endpoint widens', () => {
		const candidate = snapshot(edited(`c.rpc('/api', { callers: ['human'] }`, `c.rpc('/api', { callers: ['human', 'machine'] }`))
		expect(lines(snapshot(), candidate)).toContain('Endpoint `api.get` gains caller `machine`')
		expect(classifyAccess(snapshot(), candidate).outcome).toBe('widening')
	})

	test('an output field added widens; one removed only removes', () => {
		const wider = snapshot(edited('title: z.string() })', 'title: z.string(), body: z.string() })'))
		expect(lines(snapshot(), wider)).toEqual(['Endpoint `api.get` output gains field `body`'])
		expect(classifyAccess(wider, snapshot()).outcome).toBe('no-widening')
	})

	test('a column that loses its read policy widens; a removed table only removes', () => {
		const { secret: _secret, ...columns } = NOTES_TABLE.columns
		const fallback = snapshot(BASE, { notes: { ...NOTES_TABLE, columns } })
		expect(classifyAccess(snapshot(), fallback)).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'Column `notes.secret` loses its read policy `notes.delete` and is read with `notes.read`' }],
		})
		expect(classifyAccess(snapshot(), snapshot(BASE, {}))).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'Table policy `notes` is removed' }],
		})
	})

	test('a new column write action widens, and so does a column that moves under one; dropping one only removes', () => {
		const assigned = snapshot(BASE, { notes: { ...NOTES_TABLE, columns: { ...NOTES_TABLE.columns, owner: { write: 'notes.delete' } } } })
		expect(classifyAccess(snapshot(), assigned)).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'Column `notes.owner` is updated with its own write action `notes.delete`' }],
		})
		expect(classifyAccess(assigned, snapshot())).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'Column `notes.owner` is no longer updated with its own write action `notes.delete`' }],
		})

		// `title` leaves the update action's list for an action of its own: one line narrows, the other widens.
		const moved = snapshot(BASE, { notes: { ...NOTES_TABLE, update: [], columns: { ...NOTES_TABLE.columns, title: { write: 'notes.delete' } } } })
		expect(classifyAccess(snapshot(), moved)).toEqual({
			outcome: 'widening',
			changes: [
				{ effect: 'narrows', line: 'Table `notes` no longer accepts updates of `title`' },
				{ effect: 'widens', line: 'Column `notes.title` is updated with its own write action `notes.delete`' },
			],
		})
		const rewritten = snapshot(BASE, { notes: { ...NOTES_TABLE, update: [], columns: { ...NOTES_TABLE.columns, title: { write: 'notes.write' } } } })
		expect(classifyAccess(moved, rewritten).outcome).toBe('widening')
		expect(lines(moved, rewritten)).toEqual(['Column `notes.title` write action changes from `"notes.delete"` to `"notes.write"`'])
		expect(classifyAccess(moved, snapshot()).outcome).toBe('widening')
	})

	test('a new or changed migration widens; a removed one only removes', () => {
		const one = { name: '20260101000000_init.sql', checksum: 'a'.repeat(64) }
		const two = { name: '20260102000000_more.sql', checksum: 'b'.repeat(64) }
		expect(lines(snapshot(BASE, undefined, [one]), snapshot(BASE, undefined, [one, two]))).toEqual(['New migration `20260102000000_more.sql`'])
		expect(lines(snapshot(BASE, undefined, [one]), snapshot(BASE, undefined, [{ ...one, checksum: 'c'.repeat(64) }]))).toEqual([
			'Migration `20260101000000_init.sql` changes',
		])
		expect(classifyAccess(snapshot(BASE, undefined, [one, two]), snapshot(BASE, undefined, [one])).outcome).toBe('no-widening')
	})

	test('the first contract is all additions against the empty snapshot', () => {
		const classification = classifyAccess(EMPTY_SNAPSHOT, snapshot())
		expect(classification.outcome).toBe('widening')
		expect(classification.changes.filter((change) => change.effect !== 'widens')).toEqual([{
			effect: 'narrows',
			line: 'Reserved prefix `/api` is added',
		}])
		expect(classification.changes.map((change) => change.line)).toContain('The application becomes the contract application `notes`')
		expect(classification.changes.map((change) => change.line)).toContain('New role `editor` with `notes.read`, `notes.write`')
	})

	test('dropping the contract widens: the proxy would stop applying an endpoint table', () => {
		expect(classifyAccess(snapshot(), EMPTY_SNAPSHOT)).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'The contract is removed: the proxy no longer applies an endpoint table to this application' }],
		})
		expect(classifyAccess(EMPTY_SNAPSHOT, EMPTY_SNAPSHOT).outcome).toBe('none')
	})

	test('a display name or a locale, declared, changed or dropped, is a line the approver reads', () => {
		const named = snapshot(edited("app: 'notes',", "app: 'notes',\n\tlocale: 'cs',\n\tdisplayName: 'Poznámky',"))
		const renamed = snapshot(edited("app: 'notes',", "app: 'notes',\n\tlocale: 'cs',\n\tdisplayName: 'Notes',"))
		const pages = 'sign-in, password and invitation pages and e-mails'
		expect(classifyAccess(snapshot(), named)).toEqual({
			outcome: 'widening',
			changes: [
				{ effect: 'widens', line: `IAM names the application \`"Poznámky"\` on its ${pages}` },
				{ effect: 'widens', line: `IAM speaks \`cs\` on the application's ${pages}` },
			],
		})
		expect(lines(named, renamed)).toEqual([`IAM names the application \`"Notes"\` on its ${pages}`])
		expect(lines(named, snapshot())).toEqual([
			`IAM no longer names the application on its ${pages}`,
			`IAM speaks \`its default language\` on the application's ${pages}`,
		])
		expect(lines(EMPTY_SNAPSHOT, snapshot()).some((line) => line.startsWith('IAM '))).toBe(false)
	})

	test("a dimension's directory: 'labels' widens for closer review; removing it narrows", () => {
		const members = "workspace: { creator: 'owner', members: { manage: 'notes.delete', list: 'notes.read' } }"
		const listed = snapshot(edited("workspace: { creator: 'owner' }", members))
		const labelled = snapshot(edited("workspace: { creator: 'owner' }", members.replace(' } }', " }, directory: 'labels' }")))
		const line =
			"Holders of the members.list action of `workspace` see each member's label, and every endpoint on, in or below `workspace` reads the label of a member it looks up; a label spells a user's email address"
		expect(classifyAccess(listed, labelled)).toEqual({ outcome: 'widening', changes: [{ effect: 'widens', line, review: 'closer' }] })
		expect(classifyAccess(labelled, listed)).toEqual({
			outcome: 'no-widening',
			changes: [{
				effect: 'narrows',
				line: 'Holders of the members.list action of `workspace` and the endpoints below `workspace` no longer see member labels',
			}],
		})
		expect(classifyAccess(EMPTY_SNAPSHOT, labelled).changes).toContainEqual({ effect: 'widens', line, review: 'closer' })
	})

	test("the application's own people widen for closer review, and so do their labels; removing them narrows", () => {
		const people = snapshot(edited("app: 'notes',", "app: 'notes',\n\tmembers: { manage: 'notes.delete', list: 'notes.read' },"))
		const labelled = snapshot(
			edited("app: 'notes',", "app: 'notes',\n\tmembers: { manage: 'notes.delete', list: 'notes.read' },\n\tdirectory: 'labels',"),
		)
		const declared =
			"Holders of `notes.delete` grant and revoke the application's global roles in IAM's console, and holders of `notes.read` list everyone holding one of its roles"
		expect(classifyAccess(snapshot(), people)).toEqual({ outcome: 'widening', changes: [{ effect: 'widens', line: declared, review: 'closer' }] })
		expect(classifyAccess(people, labelled)).toEqual({
			outcome: 'widening',
			changes: [{
				effect: 'widens',
				line: "Holders of the application's members.list action see each person's label, which spells a user's email address",
				review: 'closer',
			}],
		})
		expect(classifyAccess(people, snapshot()).outcome).toBe('no-widening')
	})

	test('the member directory an endpoint reads is recorded: an approval before it was recorded widens, labels for closer review', () => {
		const members = "workspace: { creator: 'owner', members: { manage: 'notes.delete', list: 'notes.read' } }"
		const listed = snapshot(edited("workspace: { creator: 'owner' }", members))
		const labelled = snapshot(edited("workspace: { creator: 'owner' }", members.replace(' } }', " }, directory: 'labels' }")))
		/** The same contract as a framework compiled it before it recorded any directory reach. */
		const unrecorded = (current: AccessSnapshot): AccessSnapshot => {
			if (current.contract === null) throw new Error('the snapshot has a contract')
			const { directories, ...contract } = current.contract
			expect(directories).toEqual({ 'api.get': { dimension: 'workspace', lists: true }, 'api.remove': { dimension: 'workspace', lists: false } })
			return { ...current, contract }
		}
		expect(classifyAccess(unrecorded(listed), listed)).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'Endpoint `api.get` lists the members of `workspace`' }, {
				effect: 'widens',
				line: 'Endpoint `api.remove` looks up one member of `workspace`',
			}],
		})
		expect(classifyAccess(unrecorded(labelled), labelled).changes).toEqual([
			{
				effect: 'widens',
				line: "Endpoint `api.get` lists the members of `workspace`, with their labels, which spell users' email addresses",
				review: 'closer',
			},
			{
				effect: 'widens',
				line: "Endpoint `api.remove` looks up one member of `workspace`, with their labels, which spell users' email addresses",
				review: 'closer',
			},
		])
		expect(classifyAccess(listed, listed).outcome).toBe('none')
		expect(lines(listed, snapshot())).toContain('Endpoint `api.remove` no longer reads the members of `workspace`')
	})

	test('a role that admits external principals widens; losing it removes; a new external role names it', () => {
		const role = `editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } }`
		const external = snapshot(edited(role, role.replace(' } }', ' }, external: true }')))
		const line = 'Role `editor` may be held by external principals, people from outside the organization'
		expect(classifyAccess(snapshot(), external)).toEqual({ outcome: 'widening', changes: [{ effect: 'widens', line }] })
		expect(classifyAccess(external, snapshot())).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'Role `editor` may no longer be held by external principals' }],
		})
		expect(classifyAccess(EMPTY_SNAPSHOT, external).changes).toContainEqual({ effect: 'widens', line })
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
		expect(forward).toEqual({ outcome: 'widening', changes: [{ effect: 'widens', line: 'Endpoint `api.remove` input `stage` admits `won`' }] })
		expect(backward).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'Endpoint `api.remove` input `stage` no longer admits `won`' }],
		})
	})

	test('an enum that gains a value widens', () => {
		const { forward, backward } = inputChange(`stage: z.enum(['lead', 'won'])`, `stage: z.enum(['lead', 'won', 'lost'])`)
		expect(forward.changes).toEqual([{ effect: 'widens', line: 'Endpoint `api.remove` input `stage` admits `lost`' }])
		expect(backward.outcome).toBe('no-widening')
	})

	test('an enum that trades one value for another widens', () => {
		expect(inputChange(`stage: z.enum(['lead', 'won'])`, `stage: z.enum(['lead', 'lost'])`).forward).toEqual({
			outcome: 'widening',
			changes: [
				{ effect: 'widens', line: 'Endpoint `api.remove` input `stage` admits `lost`' },
				{ effect: 'narrows', line: 'Endpoint `api.remove` input `stage` no longer admits `won`' },
			],
		})
	})

	test('a removed or raised maximum length widens; a lowered one only removes', () => {
		expect(inputChange('title: z.string().max(200)', 'title: z.string()').forward).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'Endpoint `api.remove` input `title` maximum length changes from 200 to none' }],
		})
		const { forward, backward } = inputChange('title: z.string().max(200)', 'title: z.string().max(300)')
		expect(forward.outcome).toBe('widening')
		expect(backward).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'Endpoint `api.remove` input `title` maximum length changes from 300 to 200' }],
		})
	})

	test('a removed or lowered minimum widens; a raised one only removes', () => {
		expect(inputChange('title: z.string().min(3)', 'title: z.string().min(1)').forward.changes).toEqual([
			{ effect: 'widens', line: 'Endpoint `api.remove` input `title` minimum length changes from 3 to 1' },
		])
		const { forward, backward } = inputChange('count: z.number().min(0).max(10)', 'count: z.number().max(10)')
		expect(forward.changes).toEqual([{ effect: 'widens', line: 'Endpoint `api.remove` input `count` minimum changes from 0 to none' }])
		expect(backward.outcome).toBe('no-widening')
		expect(inputChange('count: z.number().min(0)', 'count: z.number().gt(0)').forward.outcome).toBe('no-widening')
		expect(inputChange('count: z.number().int()', 'count: z.number()').forward.outcome).toBe('widening')
	})

	test('a removed pattern widens; an added one only removes', () => {
		const { forward, backward } = inputChange('code: z.string().regex(/^[a-z]+$/)', 'code: z.string()')
		expect(forward.outcome).toBe('widening')
		expect(backward.outcome).toBe('no-widening')
	})

	test('a field that becomes optional or nullable widens; the reverse only removes', () => {
		const optional = inputChange('title: z.string()', 'title: z.string().optional()')
		expect(optional.forward.changes).toEqual([{ effect: 'widens', line: 'Endpoint `api.remove` input `title` becomes optional' }])
		expect(optional.backward.changes).toEqual([{ effect: 'narrows', line: 'Endpoint `api.remove` input `title` becomes required' }])
		const nullable = inputChange('title: z.string()', 'title: z.string().nullable()')
		expect(nullable.forward.changes).toEqual([{ effect: 'widens', line: 'Endpoint `api.remove` input `title` admits null' }])
		expect(nullable.backward.outcome).toBe('no-widening')
	})

	test('a new accepted field widens, optional or not; a removed optional field only removes', () => {
		const { forward, backward } = inputChange('title: z.string()', 'title: z.string(), body: z.string().optional()')
		expect(forward).toEqual({ outcome: 'widening', changes: [{ effect: 'widens', line: 'Endpoint `api.remove` input gains field `body`' }] })
		expect(backward).toEqual({ outcome: 'no-widening', changes: [{ effect: 'narrows', line: 'Endpoint `api.remove` input loses field `body`' }] })
		expect(inputChange('title: z.string()', 'title: z.string(), body: z.string()').forward.outcome).toBe('widening')
	})

	test('a removed required field widens: an input without it is admitted that was refused before', () => {
		expect(inputChange('title: z.string(), body: z.string()', 'title: z.string()').forward).toEqual({
			outcome: 'widening',
			changes: [{ effect: 'widens', line: 'Endpoint `api.remove` input loses required field `body`' }],
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
		expect(items.forward.changes).toEqual([{ effect: 'widens', line: 'Endpoint `api.remove` input `items[].stage` admits `won`' }])
		const deal = inputChange(
			`deal: z.strictObject({ stage: z.literal('lead') }).nullable()`,
			`deal: z.strictObject({ stage: z.literal('lead'), note: z.string().optional() }).nullable()`,
		)
		expect(deal.forward.changes).toEqual([{ effect: 'widens', line: 'Endpoint `api.remove` input `deal` gains field `note`' }])
		expect(inputChange('tags: z.array(z.string()).max(5)', 'tags: z.array(z.string())').forward.changes).toEqual([
			{ effect: 'widens', line: 'Endpoint `api.remove` input `tags` maximum items changes from 5 to none' },
		])
	})

	test('a discriminated union whose discriminator hides a default is refused: as a plain union it would admit `{}`', () => {
		const options = `[z.strictObject({ kind: z.literal('a').default('a').nullable() }), z.strictObject({ kind: z.literal('b') })]`
		expect(() => removeInput(`item: z.discriminatedUnion('kind', ${options})`)).toThrow(ContractError)
		expect(removeInput(`item: z.union(${options})`).contract).not.toBeNull()
	})

	test('an unchanged input is unchanged', () => {
		expect(inputChange(`stage: z.enum(['lead', 'won'])`, `stage: z.enum(['won', 'lead'])`).forward).toEqual({ outcome: 'none', changes: [] })
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
		expect(classifyAccess(wider, before).outcome).toBe('no-widening')
	})

	test('any change of an output union widens: projection takes the first branch that accepts the result', () => {
		const output = (branches: string) => snapshot(edited('output: Note', `output: z.union([${branches}])`))
		const plain = 'z.strictObject({ title: z.string() })'
		const secret = 'z.strictObject({ title: z.string(), secret: z.string() })'
		const reordered = classifyAccess(output(`${plain}, ${secret}`), output(`${secret}, ${plain}`))
		expect(reordered.outcome).toBe('widening')
		expect(reordered.changes).toEqual([{ effect: 'widens', line: expect.stringMatching(/^Endpoint `api.get` output changes from /) }])
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
		expect(classifyAccess(before, fewer).outcome).toBe('no-widening')
	})
})

describe('probePaths', () => {
	// Every path a pattern matches behaves, for each endpoint of both tables, like one of its probes.
	test.each([
		['/*', ['/site', '/site/*'], ['/', '/site', '/site/x', '/site/', '/x']],
		['/api/:name', ['/api/get', '/*'], ['/', '/api', '/api/get', '/api/x']],
		['/a/*', ['/a/', '/a/:x', '/a/:x/*'], ['/', '/a', '/a/', '/a/x', '/a/x/x', '/a/x/']],
		['/', ['/*'], ['/']],
	])('%s among %p', (pattern, patterns, probes) => {
		expect(probePaths(pattern, patterns)).toEqual(probes)
	})

	test('the fresh segment is no literal of any pattern', () => {
		expect(probePaths('/:page', ['/x', '/xx'])).toEqual(['/', '/x', '/xx', '/xxx'])
	})
})
