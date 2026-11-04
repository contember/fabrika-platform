// Relation grants in the approval diff and at publication: a role holding actions through a relation, a table that
// confers it and an action's condition are read from source, shown with their effect, and refused for a framework
// release that would not enforce them.

import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { relationGrantsRefusal } from '../approval/enforcement'
import type { AccessSnapshot } from '../approval/snapshot'
import { classifyAccess } from './helpers/access'
import { kitFiles } from './helpers/kit-contract'

interface RelationOptions {
	readonly via?: string
	readonly confers?: string
	readonly when?: string
}

const ROLES = "roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },"
const NOTE_TABLE = "insert: ['title'],\n\t\tupdate: ['title'],\n\t},"

function files(options: RelationOptions = {}): Map<string, string> {
	const base = kitFiles()
	const vocabulary = (base['src/vocabulary.ts'] ?? '')
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
			'export interface NoteMembersTable {\n\tid: string\n\tnote_id: string\n\tworkspace_id: string\n\tprincipal_id: string\n\texpires_at: Date | null\n}\n\nexport interface DB {\n\taudit: AuditTable\n\tnote_members: NoteMembersTable',
		)
		.replace(
			"\tnotes: { columns: ['id', 'workspace_id', 'title'], foreignKeys: [] },",
			"\tnote_members: {\n\t\tcolumns: ['id', 'note_id', 'workspace_id', 'principal_id', 'expires_at'],\n\t\tforeignKeys: [{ columns: ['note_id', 'workspace_id'], table: 'notes', references: ['id', 'workspace_id'] }],\n\t\ttimestamps: ['expires_at'],\n\t},\n\tnotes: { columns: ['id', 'workspace_id', 'title'], foreignKeys: [] },",
		)
	const tables = (base['src/db/tables.ts'] ?? '').replace(
		NOTE_TABLE,
		`${NOTE_TABLE.slice(0, -3)}${options.when === undefined ? '' : `\n\t\twhen: ${options.when},`}\n\t},
	note_members: {
		scope: { child: 'notes' },
		actions: { read: 'notes.read', insert: 'notes.share', delete: 'notes.share' },
		insert: ['principal_id', 'expires_at'],
		confers: { member: ${options.confers ?? "{ principal: 'principal_id', expires: 'expires_at', assign: { maxDays: 30 } }"} },
	},`,
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

	test("an action's condition narrows when added and widens when removed or changed", () => {
		const open = snapshot(files())
		const locked = snapshot(files({ when: "{ 'notes.write': { title: { notEq: 'locked' } } }" }))
		expect(lines(open, locked)).toContainEqual({ effect: 'narrows', line: '`notes.write` holds a row of `notes` only under its condition' })
		expect(classifyAccess(open, locked).outcome).toBe('no-widening')
		expect(classifyAccess(locked, open).outcome).toBe('widening')
		expect(classifyAccess(locked, snapshot(files({ when: "{ 'notes.write': { title: { notEq: 'frozen' } } }" }))).outcome).toBe('widening')
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
})
