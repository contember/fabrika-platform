// Relation grants in the approval diff and at publication: a role holding actions through a relation, a table that
// confers it and an action's condition are read from source, shown with their effect, and refused for a framework
// release that would not enforce them.

import { sha256Hex } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { relationFields, relationGrantsRefusal } from '../approval/enforcement'
import { readAccessSnapshot, SnapshotRefused } from '../approval/read'
import type { AccessSnapshot } from '../approval/snapshot'
import { classifyAccess } from './helpers/access'
import { memoryCommits } from './helpers/commits'
import { kitFiles } from './helpers/kit-contract'

interface RelationOptions {
	readonly via?: string
	readonly confers?: string
	readonly when?: string
	readonly relationWhen?: string
	readonly reveals?: string
	readonly admits?: string
	readonly partition?: boolean
}

const ROLES = "roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },"
const NOTE_TABLE = "insert: ['title'],\n\t\tupdate: ['title'],\n\t},"

function files(options: RelationOptions = {}): Map<string, string> {
	const base = kitFiles()
	const vocabulary = (base['src/vocabulary.ts'] ?? '')
		.replace(
			"workspace: { creator: 'owner' }",
			options.partition === true ? "workspace: { creator: 'owner', partition: true }" : "workspace: { creator: 'owner' }",
		)
		.replace("'notes.write': 'Write notes' }", "'notes.write': 'Write notes', 'notes.share': 'Share a note' }")
		.replace(
			ROLES,
			`${ROLES.slice(0, -3)}, editor: { grants: ['notes.share'], via: { member: [${
				options.via ?? "'notes.read'"
			}] } } },\n\trelations: { member: { dimension: 'note' } },`,
		)
	const schema = (base['src/db/schema.generated.ts'] ?? '')
		.replace(
			'export interface DB {\n\taudit: AuditTable',
			'export interface NoteMembersTable {\n\tid: string\n\tnote_id: string\n\tworkspace_id: string\n\tprincipal_id: string\n\tperson_id: string | null\n\texpires_at: Date | null\n}\n\nexport interface PeopleTable {\n\tid: string\n\tprincipal_id: string\n}\n\nexport interface DB {\n\taudit: AuditTable\n\tnote_members: NoteMembersTable\n\tpeople: PeopleTable',
		)
		.replace(
			"\tnotes: { columns: ['id', 'workspace_id', 'title'], foreignKeys: [] },",
			"\tnote_members: {\n\t\tcolumns: ['id', 'note_id', 'workspace_id', 'principal_id', 'person_id', 'expires_at'],\n\t\tforeignKeys: [{ columns: ['note_id', 'workspace_id'], table: 'notes', references: ['id', 'workspace_id'] }, { columns: ['person_id'], table: 'people', references: ['id'] }],\n\t\ttimestamps: ['expires_at'],\n\t},\n\tnotes: { columns: ['id', 'workspace_id', 'title'], foreignKeys: [] },\n\tpeople: { columns: ['id', 'principal_id'], foreignKeys: [] },",
		)
	const tables = (base['src/db/tables.ts'] ?? '').replace(
		NOTE_TABLE,
		`${NOTE_TABLE.slice(0, -3)}${options.when === undefined ? '' : `\n\t\twhen: ${options.when},`}${
			options.relationWhen === undefined ? '' : `\n\t\trelationWhen: ${options.relationWhen},`
		}${options.reveals === undefined ? '' : `\n\t\treveals: ${options.reveals},`}${
			options.admits === undefined ? '' : `\n\t\tadmits: ${options.admits},`
		}\n\t},
	note_members: {
		scope: { child: 'notes' },
		actions: { read: 'notes.read', insert: 'notes.share', delete: 'notes.share' },
		insert: ['principal_id', 'expires_at'],
		confers: { member: ${options.confers ?? "{ principal: 'principal_id', expires: 'expires_at', assign: { maxDays: 30 } }"} },
	},
	people: { scope: { app: 'the directory a member row may name its person from' }, actions: { read: 'notes.read' } },`,
	)
	return new Map(Object.entries({ ...base, 'src/vocabulary.ts': vocabulary, 'src/db/schema.generated.ts': schema, 'src/db/tables.ts': tables }))
}

const snapshot = (source: Map<string, string>, framework = '0.9.0'): AccessSnapshot => ({
	version: 1,
	contract: readContractSource(source),
	migrations: [],
	checker: '0.0.0',
	framework,
})
const plain: AccessSnapshot = { version: 1, contract: readContractSource(new Map(Object.entries(kitFiles()))), migrations: [], checker: '0.0.0' }

describe('the static reader', () => {
	test('reads the relation, the role that holds actions through it and the table that confers it', () => {
		const contract = readContractSource(files({ when: "{ 'notes.write': { title: { notEq: 'locked' } } }" }))
		expect(contract.relations).toEqual({ member: { dimension: 'note' } })
		expect(contract.roles['editor']?.via).toEqual({ member: ['notes.read'] })
		expect(contract.tables['note_members']?.confers).toEqual({
			member: { principal: 'principal_id', node: 'note_id', expires: 'expires_at', assign: { maxDays: 30, self: false } },
		})
		expect(contract.tables['notes']?.when).toEqual({ 'notes.write': { title: { notEq: 'locked' } } })
	})

	test('reads a principal reached through a foreign key as its dotted text', () => {
		const contract = readContractSource(files({ confers: "{ principal: 'person_id.principal_id', expires: 'expires_at', assign: { maxDays: 30 } }" }))
		expect(contract.tables['note_members']?.confers?.['member']?.principal).toBe('person_id.principal_id')
		expect(() => readContractSource(files({ confers: "{ principal: 'person_id.principal_id.id', assign: { maxDays: 30 } }" }))).toThrow(
			'follows more than one foreign key',
		)
	})

	test('refuses a role that would delegate the relation onward', () => {
		expect(() => readContractSource(files({ via: "'notes.share'" }))).toThrow()
	})
})

describe('relation grants in the approval diff', () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))

	test('introducing a relation widens through the source table and the role, never through the relation itself', () => {
		const changes = lines(plain, snapshot(files()))
		expect(changes).toContainEqual({ effect: 'neutral', line: 'New relation `member` at a note' })
		expect(changes).toContainEqual({ effect: 'widens', line: 'Role `editor` through relation `member` gains `notes.read`' })
		expect(changes).toContainEqual({
			effect: 'widens',
			line: 'Table `note_members` confers relation `member` on `principal_id` at `note_id`; an insert delegates it for at most 30 days',
		})
	})

	test('a via action widens; a longer delegation and a self-delegation widen; a removed one narrows', () => {
		const before = snapshot(files())
		expect(lines(before, snapshot(files({ via: "'notes.read', 'notes.write'" })))).toContainEqual({
			effect: 'widens',
			line: 'Role `editor` through relation `member` gains `notes.write`',
		})
		const longer = snapshot(files({ confers: "{ principal: 'principal_id', expires: 'expires_at', assign: { maxDays: 90, self: true } }" }))
		expect(lines(before, longer)).toEqual(expect.arrayContaining([
			{ effect: 'widens', line: 'Table `note_members` relation `member` delegation days changes from 30 to 90' },
			{ effect: 'widens', line: 'Table `note_members` relation `member` may be delegated by a writer to itself' },
		]))
		expect(classifyAccess(longer, before).outcome).toBe('no-widening')
	})

	test('a principal reached through a foreign key is shown on introduction, and a changed principal widens either way', () => {
		const direct = snapshot(files())
		const through = snapshot(files({ confers: "{ principal: 'person_id.principal_id', expires: 'expires_at', assign: { maxDays: 30 } }" }))
		expect(lines(plain, through)).toContainEqual({
			effect: 'widens',
			line: 'Table `note_members` confers relation `member` on `person_id.principal_id` at `note_id`; an insert delegates it for at most 30 days',
		})
		expect(classifyAccess(direct, through).outcome).toBe('widening')
		expect(classifyAccess(through, direct).outcome).toBe('widening')
		expect(lines(direct, through).some(({ effect, line }) => effect === 'widens' && line.includes('`member` principal'))).toBe(true)
	})

	test("an action's condition narrows when added and widens when removed or changed", () => {
		const open = snapshot(files())
		const locked = snapshot(files({ when: "{ 'notes.write': { title: { notEq: 'locked' } } }" }))
		expect(lines(open, locked)).toContainEqual({ effect: 'narrows', line: '`notes.write` holds a row of `notes` only under its condition' })
		expect(classifyAccess(open, locked).outcome).toBe('no-widening')
		expect(classifyAccess(locked, open).outcome).toBe('widening')
		expect(classifyAccess(locked, snapshot(files({ when: "{ 'notes.write': { title: { notEq: 'frozen' } } }" }))).outcome).toBe('widening')
	})
})

describe("a table's reveals in the approval diff", () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))
	const reveal = (actions: string) => snapshot(files({ reveals: `{ member: { to: 'workspace', actions: [${actions}] } }` }))

	test('are read from source, widen when added or given an action, and narrow when removed', () => {
		expect(readContractSource(files({ reveals: "{ member: { to: 'workspace', actions: ['notes.read'] } }" })).tables['notes']?.reveals).toEqual({
			member: { to: 'workspace', actions: ['notes.read'] },
		})
		const none = snapshot(files())
		const read = reveal("'notes.read'")
		expect(lines(none, read)).toContainEqual({ effect: 'widens', line: 'Table `notes` reveals to relation `member` its `workspace` for `notes.read`' })
		expect(lines(read, reveal("'notes.read', 'notes.write'"))).toContainEqual({
			effect: 'widens',
			line: 'Table `notes` reveals to relation `member` its `workspace` also for `notes.write`',
		})
		expect(classifyAccess(read, none).outcome).toBe('no-widening')
	})

	test('an insert bound widens when added or given self, and narrows when removed', () => {
		const read = reveal("'notes.read'")
		const bound = (assign: { self: boolean } | undefined): AccessSnapshot => {
			const contract = read.contract
			const notes = contract?.tables['notes']
			const member = notes?.reveals?.['member']
			if (contract === null || notes === undefined || member === undefined) throw new Error('the kit reveals notes')
			const revealed = assign === undefined ? { to: member.to, actions: member.actions } : { ...member, assign }
			return { ...read, contract: { ...contract, tables: { ...contract.tables, notes: { ...notes, reveals: { member: revealed } } } } }
		}
		const subject = 'Table `notes` reveals to relation `member`'
		expect(lines(bound(undefined), bound({ self: false }))).toContainEqual({
			effect: 'widens',
			line: `${subject} at a node an insert into \`notes\` picks, never its writer's own`,
		})
		expect(lines(bound({ self: false }), bound({ self: true }))).toContainEqual({
			effect: 'widens',
			line: `${subject} at a node an insert into \`notes\` picks, its writer's own included`,
		})
		expect(lines(bound({ self: true }), bound(undefined))).toContainEqual({
			effect: 'narrows',
			line: `${subject} no longer at a node an insert into \`notes\` picks`,
		})
	})
})

describe("a table's read path in the approval diff", () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))
	const none = snapshot(files())
	const through = (readThrough: Readonly<Record<string, string>>): AccessSnapshot => {
		const contract = none.contract
		const notes = contract?.tables['notes']
		if (contract === null || notes === undefined) throw new Error('the kit has a notes table')
		return { ...none, contract: { ...contract, tables: { ...contract.tables, notes: { ...notes, readThrough } } } }
	}

	test('widens when added or moved to another column, and narrows when removed', () => {
		expect(lines(none, through({ label: 'label_id' }))).toContainEqual({
			effect: 'widens',
			line: 'A read of `label` reaches table `notes` through `label_id`',
		})
		expect(lines(through({ label: 'label_id' }), through({ label: 'other_id' }))).toContainEqual({
			effect: 'widens',
			line: 'A read of `label` reaches table `notes` through `other_id` instead of `label_id`',
		})
		expect(lines(through({ label: 'label_id' }), none)).toContainEqual({
			effect: 'narrows',
			line: 'A read of `label` reaches table `notes` no longer: its path through `label_id` is removed',
		})
		expect(classifyAccess(through({ label: 'label_id' }), none).outcome).toBe('no-widening')
	})

	test("widens when added through the row's container, or moved between its own column and its container's", () => {
		expect(lines(none, through({ label: 'project_id.label_id' }))).toContainEqual({
			effect: 'widens',
			line: 'A read of `label` reaches table `notes` through `project_id.label_id`',
		})
		expect(lines(through({ label: 'label_id' }), through({ label: 'project_id.label_id' }))).toContainEqual({
			effect: 'widens',
			line: 'A read of `label` reaches table `notes` through `project_id.label_id` instead of `label_id`',
		})
		expect(classifyAccess(through({ label: 'project_id.label_id' }), through({ label: 'label_id' })).outcome).toBe('widening')
	})
})

describe("a table's write path in the approval diff", () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))
	const none = snapshot(files())
	const writing = (writeThrough: Readonly<Record<string, readonly string[]>> | undefined): AccessSnapshot => {
		const contract = none.contract
		const notes = contract?.tables['notes']
		if (contract === null || notes === undefined) throw new Error('the kit has a notes table')
		const table = { ...notes, readThrough: { label: 'label_id' }, ...(writeThrough === undefined ? {} : { writeThrough }) }
		return { ...none, contract: { ...contract, tables: { ...contract.tables, notes: table } } }
	}
	const subject = "A grant at a `label` that table `notes`'s path `label_id` names"

	test('widens when an action is held through the path, naming the bound on its writer, and narrows when one goes', () => {
		const read = writing(undefined)
		const write = writing({ label: ['notes.write'] })
		expect(lines(read, write)).toEqual([{
			effect: 'widens',
			line:
				`${subject} also holds \`notes.write\` on its rows, writes included; whoever inserts the path's column must hold each there, and rows written before keep the node they name`,
		}])
		expect(lines(write, writing({ label: ['notes.write', 'notes.read'] }))).toContainEqual({
			effect: 'widens',
			line:
				`${subject} also holds \`notes.read\` on its rows, writes included; whoever inserts the path's column must hold each there, and rows written before keep the node they name`,
		})
		expect(lines(write, read)).toEqual([{ effect: 'narrows', line: `${subject} no longer holds \`notes.write\` on its rows` }])
		expect(classifyAccess(write, read).outcome).toBe('no-widening')
		expect(classifyAccess(read, write).outcome).toBe('widening')
	})

	test('a path declared with its write actions states the write as a widening', () => {
		expect(lines(none, writing({ label: ['notes.write'] }))).toContainEqual({
			effect: 'widens',
			line:
				`${subject} also holds \`notes.write\` on its rows, writes included; whoever inserts the path's column must hold each there, and rows written before keep the node they name`,
		})
	})
})

describe("a table's member reveals in the approval diff", () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))
	const none = snapshot(files())
	const revealing = (memberReveals: Readonly<Record<string, { to: string; actions: string[]; when?: { title: { eq: string } } }>>): AccessSnapshot => {
		const contract = none.contract
		const notes = contract?.tables['notes']
		if (contract === null || notes === undefined) throw new Error('the kit has a notes table')
		return { ...none, contract: { ...contract, tables: { ...contract.tables, notes: { ...notes, memberReveals } } } }
	}
	const subject = 'Table `notes` reveals to a member of its `note`'

	test('widens when added or given an action, and narrows when an action, the reveal or the condition goes', () => {
		const read = revealing({ note: { to: 'workspace', actions: ['notes.read'] } })
		const both = revealing({ note: { to: 'workspace', actions: ['notes.read', 'notes.write'] } })
		expect(lines(none, read)).toContainEqual({ effect: 'widens', line: `${subject} its \`workspace\` for \`notes.read\`` })
		expect(lines(read, both)).toContainEqual({ effect: 'widens', line: `${subject} its \`workspace\` also for \`notes.write\`` })
		expect(lines(both, read)).toContainEqual({ effect: 'narrows', line: `${subject} its \`workspace\` no longer for \`notes.write\`` })
		expect(lines(read, revealing({ note: { to: 'workspace', actions: ['notes.read'], when: { title: { eq: 'x' } } } }))).toContainEqual({
			effect: 'narrows',
			line: `${subject} only a row its condition holds`,
		})
		expect(lines(read, none)).toContainEqual({ effect: 'narrows', line: `${subject} nothing any more` })
		expect(classifyAccess(read, none).outcome).toBe('no-widening')
	})

	test("through a path, names the path and the insert's pick, and widens when the writer may pick its own", () => {
		const through = (assign: { readonly self: boolean }): AccessSnapshot => {
			const contract = none.contract
			const notes = contract?.tables['notes']
			if (contract === null || notes === undefined) throw new Error('the kit has a notes table')
			const table = { ...notes, readThrough: { label: 'label_id' }, memberReveals: { label: { to: 'workspace', actions: ['notes.read'], assign } } }
			return { ...none, contract: { ...contract, tables: { ...contract.tables, notes: table } } }
		}
		const pathSubject = 'Table `notes` reveals to a member of the `label` its path `label_id` names'
		const others = through({ self: false })
		expect(lines(none, others)).toContainEqual({ effect: 'widens', line: `${pathSubject} its \`workspace\` for \`notes.read\`` })
		expect(lines(none, others)).toContainEqual({
			effect: 'widens',
			line: `${pathSubject} at a node an insert into \`notes\` picks, never its writer's own`,
		})
		expect(lines(others, through({ self: true }))).toEqual([{
			effect: 'widens',
			line: `${pathSubject} at a node an insert into \`notes\` picks, its writer's own included`,
		}])
		expect(classifyAccess(through({ self: true }), others).outcome).toBe('no-widening')
	})
})

describe('a condition that reads the rows naming a row a path reaches', () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))
	const none = snapshot(files())
	const conditioned = (when: NonNullable<NonNullable<AccessSnapshot['contract']>['tables'][string]['when']>): AccessSnapshot => {
		const contract = none.contract
		const notes = contract?.tables['notes']
		if (contract === null || notes === undefined) throw new Error('the kit has a notes table')
		return { ...none, contract: { ...contract, tables: { ...contract.tables, notes: { ...notes, when } } } }
	}
	const later = conditioned({ 'notes.write': { workspace_id: { none: { notes: { title: { eq: 'locked' } } } } } })

	test('narrows when added, widens when changed, and counts as a when at publication', () => {
		expect(lines(none, later)).toEqual([{ effect: 'narrows', line: '`notes.write` holds a row of `notes` only under its condition' }])
		const changed = conditioned({ 'notes.write': { workspace_id: { some: { notes: { title: { eq: 'locked' } } } } } })
		expect(classifyAccess(later, changed).outcome).toBe('widening')
		expect(later.contract === null ? [] : relationFields(later.contract)).toContain('when of table notes')
		expect(relationGrantsRefusal(later.contract, '0.9.0-dev.12')).toContain('4 relation grant fields')
	})
})

describe("a relation's condition on the row its source names", () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))
	const plain = snapshot(files())
	type SourceWhen = NonNullable<NonNullable<NonNullable<AccessSnapshot['contract']>['tables'][string]['confers']>[string]['when']>
	const sourced = (when: SourceWhen): AccessSnapshot => {
		const contract = plain.contract
		const members = contract?.tables['note_members']
		const member = members?.confers?.['member']
		if (contract === null || members === undefined || member === undefined) throw new Error('the fixture confers member')
		return {
			...plain,
			contract: { ...contract, tables: { ...contract.tables, note_members: { ...members, confers: { member: { ...member, when } } } } },
		}
	}
	const titled = sourced({ 'note_id.title': { eq: 'shared' } })

	test('narrows when added, widens when changed, and counts as a confers at publication', () => {
		expect(lines(plain, titled)).toEqual([{
			effect: 'narrows',
			line: 'Table `note_members` relation `member` is conferred only by a row its condition holds',
		}])
		expect(classifyAccess(titled, sourced({ 'note_id.title': { eq: 'open' } })).outcome).toBe('widening')
		expect(titled.contract === null ? [] : relationFields(titled.contract)).toContain('confers of table note_members')
	})
})

describe("a relation's condition on the table it reads", () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))
	const open = snapshot(files())
	const titled = snapshot(files({ relationWhen: "{ member: { 'notes.read': { title: { notEq: 'locked' } } } }" }))

	test('is read from source, narrows when added, and widens when removed or changed', () => {
		expect(titled.contract?.tables['notes']?.relationWhen).toEqual({ member: { 'notes.read': { title: { notEq: 'locked' } } } })
		expect(lines(open, titled)).toEqual([{
			effect: 'narrows',
			line: '`notes.read` through relation `member` holds a row of `notes` only under its condition',
		}])
		expect(classifyAccess(open, titled).outcome).toBe('no-widening')
		expect(lines(titled, open)).toEqual([{
			effect: 'widens',
			line: '`notes.read` through relation `member` holds every row of `notes` the relation reaches: its condition is removed',
		}])
		const frozen = snapshot(files({ relationWhen: "{ member: { 'notes.read': { title: { notEq: 'frozen' } } } }" }))
		expect(classifyAccess(titled, frozen).outcome).toBe('widening')
	})

	test('is shown on a new table', () => {
		const contract = open.contract
		if (contract === null) throw new Error('the fixture has a contract')
		const { notes: _, ...tables } = contract.tables
		const without: AccessSnapshot = { ...open, contract: { ...contract, tables } }
		expect(lines(without, titled)).toContainEqual({
			effect: 'narrows',
			line: '`notes.read` through relation `member` holds a row of `notes` only under its condition',
		})
	})

	test('publishes only to a release from its own floor, which the refusal names', () => {
		const contract = titled.contract
		expect(relationGrantsRefusal(contract, '0.9.0-dev.13')).toContain('relationWhen of table notes')
		expect(relationGrantsRefusal(contract, '0.9.0-dev.13')).toContain('enforces from 0.9.0-dev.14')
		expect(relationGrantsRefusal(contract, '0.9.0-dev.12')).toContain('enforces from 0.9.0-dev.14')
		expect(relationGrantsRefusal(contract, '0.9.0-dev.12')).toContain('relation member')
		expect(relationGrantsRefusal(contract, '0.9.0-dev.14')).toBeNull()
		expect(relationGrantsRefusal(open.contract, '0.9.0-dev.13')).toBeNull()
	})
})

describe('a widening condition in a tenant partition', () => {
	const lines = (before: AccessSnapshot, after: AccessSnapshot) => classifyAccess(before, after).changes.map(({ effect, line }) => ({ effect, line }))
	const partitioned = snapshot(files({ partition: true }))
	const titled = snapshot(files({ partition: true, admits: "{ 'notes.read': { title: { eq: 'public' } } }" }))

	test('is read from source, widens when added or changed, and narrows when removed', () => {
		expect(titled.contract?.tables['notes']?.admits).toEqual({ 'notes.read': { title: { eq: 'public' } } })
		expect(titled.contract?.dimensions['workspace']?.partition).toBe(true)
		expect(lines(partitioned, titled)).toEqual([{
			effect: 'widens',
			line: '`notes.read` held through a relation in a tenant partition lists every row of `notes` in it its widening condition admits',
		}])
		expect(classifyAccess(partitioned, titled).outcome).toBe('widening')
		expect(lines(titled, partitioned)).toEqual([{
			effect: 'narrows',
			line: '`notes.read` held through a relation in a tenant partition no longer lists the rows of `notes` its widening condition admitted',
		}])
		const shared = snapshot(files({ partition: true, admits: "{ 'notes.read': { title: { eq: 'shared' } } }" }))
		expect(classifyAccess(titled, shared).outcome).toBe('widening')
	})

	test('a partition is a neutral line of its dimension; the table states the widening', () => {
		expect(lines(snapshot(files()), partitioned)).toEqual([{ effect: 'neutral', line: 'Dimension `workspace` is a tenant partition' }])
		expect(lines(partitioned, snapshot(files()))).toEqual([{ effect: 'neutral', line: 'Dimension `workspace` is no longer a tenant partition' }])
	})

	test('needs no floor: a release that does not read it refuses the field', () => {
		expect(titled.contract === null ? [] : relationFields(titled.contract)).not.toContain('admits of table notes')
	})
})

describe('publication refuses relation grants an older release would not enforce', () => {
	test('a release before the first that enforces them is refused, naming the fields', () => {
		const contract = readContractSource(files())
		expect(relationGrantsRefusal(contract, '0.8.4')).toContain('relation member, via of role editor, confers of table note_members')
		expect(relationGrantsRefusal(contract, undefined)).toContain('an older release')
		expect(relationGrantsRefusal(contract, '0.9.0')).toBeNull()
		expect(relationGrantsRefusal(plain.contract, '0.8.4')).toBeNull()
	})

	test('a prerelease of the enforcing version counts by its precedence, never as that version', () => {
		const contract = readContractSource(files())
		expect(relationGrantsRefusal(contract, '0.9.0-dev.11')).toContain('enforces from 0.9.0-dev.13')
		expect(relationGrantsRefusal(contract, '0.9.0-dev.12')).toContain('enforces from 0.9.0-dev.13')
		expect(relationGrantsRefusal(contract, '0.9.0-cloudflare.3')).toContain('enforces from 0.9.0-dev.13')
		expect(relationGrantsRefusal(contract, '0.9.0-dev.13')).toBeNull()
		expect(relationGrantsRefusal(contract, '0.9.0-dev.100')).toBeNull()
		expect(relationGrantsRefusal(contract, '0.9.1-dev.0')).toBeNull()
	})
})

describe('access tables in the migrations', () => {
	const writer = (table: string) =>
		`CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$\nBEGIN\n\tINSERT INTO ${table} (id) VALUES (NEW.id);\n\tRETURN NEW;\nEND\n$$;\n`
	const read = async (source: Map<string, string>, sql: string, applied?: string) => {
		const migrations: Record<string, string> = { 'db/migrations/20261012110000_touch.sql': sql }
		if (applied !== undefined) migrations['db/migrations/20261012100000_applied.sql'] = applied
		const commit = await memoryCommits({ ...Object.fromEntries(source), ...migrations }).open({
			repoUrl: 'github.com/acme/notes',
			commitSha: 'c'.repeat(40),
			signal: new AbortController().signal,
		})
		const settled = applied === undefined ? [] : [{ name: '20261012100000_applied.sql', checksum: sha256Hex(applied) }]
		return readAccessSnapshot(commit, '', 'notes', settled)
	}

	test('a function that writes a table that confers a relation, or one its principal path reads, refuses the read', async () => {
		await expect(read(files(), writer('note_members'))).rejects.toEqual(new SnapshotRefused('migrations-refused', 1))
		const path = files({ confers: "{ principal: 'person_id.principal_id', expires: 'expires_at', assign: { maxDays: 30 } }" })
		await expect(read(path, writer('people'))).rejects.toEqual(new SnapshotRefused('migrations-refused', 1))
	})

	test('a new rename to an access table refuses the read, though the code it would bind is already applied', async () => {
		const applied = 'CREATE TABLE staging (id uuid PRIMARY KEY);\nCREATE RULE keep AS ON DELETE TO staging DO INSTEAD NOTHING;\n'
		await expect(read(files(), 'ALTER TABLE staging RENAME TO note_members;\n', applied)).rejects.toEqual(new SnapshotRefused('migrations-refused', 1))
		expect((await read(files(), 'ALTER TABLE staging RENAME TO staged;\n', applied)).databaseCode?.map((deviation) => deviation.kind)).toEqual(['rule'])
	})

	test('a function that writes another table, and a backfill of an access table, are read', async () => {
		expect((await read(files(), writer('people'))).databaseCode?.map((deviation) => deviation.object)).toEqual(['touch'])
		expect((await read(files(), 'INSERT INTO note_members (id) SELECT id FROM notes;\n')).databaseCode).toBeUndefined()
	})
})
