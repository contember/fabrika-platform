// The access map of a snapshot: each role with the actions it holds, and once per action the endpoints that require it,
// the tables and files it reaches, the members it manages or lists and the share links it issues.

import type { ContractArtifact, EndpointRow, TablePolicyArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { accessMap, snapshotAccessMap } from '../approval/access-map'
import { EMPTY_SNAPSHOT } from '../approval/snapshot'

const notes = notesArtifact.tables['notes']
if (notes === undefined) throw new Error('the notes fixture has a notes table')

describe('the access map', () => {
	test('a membership role says where it is granted, who assigns it and which new values grant it; an app-wide role is global', () => {
		const { roles } = accessMap(notesArtifact)
		expect(roles.map((role) => role.role)).toEqual(['editor', 'owner', 'starter', 'support'])
		expect(roles[0]).toEqual({
			role: 'editor',
			scope: 'workspace',
			assignableBy: ['owner'],
			creatorOf: [],
			external: false,
			actions: ['notes.read', 'notes.share', 'notes.write'],
			via: [],
		})
		expect(roles[1]).toMatchObject({ role: 'owner', creatorOf: ['workspace'] })
		expect(roles[2]).toMatchObject({ role: 'starter', scope: null, assignableBy: [], actions: ['workspaces.create'] })
	})

	test('an action lists the endpoints that require it, where, and what it does in each table and to stored files', () => {
		const remove = accessMap(notesArtifact).actions.find((action) => action.action === 'notes.delete')
		expect(remove).toEqual({
			action: 'notes.delete',
			description: 'Delete notes',
			endpoints: [{ id: 'api.notes.remove', method: 'POST', path: '/api/notes.remove', access: 'on note', callers: ['human'] }],
			members: [],
			links: [],
			tables: [{ table: 'notes', lies: 'one row per note, inside its workspace', operations: ['delete'], also: [] }],
			files: [],
		})
		const write = accessMap(notesArtifact).actions.find((action) => action.action === 'notes.write')
		expect(write?.files).toEqual(['upload, delete the files of attachments (rows of notes)'])
	})

	test('a role row lists only what a person or a script calls; the endpoints any member reaches are listed once', () => {
		const map = accessMap(notesArtifact)
		const read = map.actions.find((action) => action.action === 'notes.read')
		const paths = read?.endpoints.map((endpoint) => endpoint.path) ?? []
		expect(paths).not.toContain('/s/api/note')
		expect(paths.some((path) => path.startsWith('/__fabrika/connect/'))).toBe(false)
		expect(map.memberEndpoints.map((endpoint) => endpoint.id)).toEqual(['spa', 'api.me'])
	})

	test('an action names the members it manages or lists, the links it issues and the columns it alone reads', () => {
		const { actions } = accessMap(notesArtifact)
		const of = (name: string) => actions.find((action) => action.action === name)
		expect(of('notes.admin')?.members).toEqual(['manage the members of each workspace'])
		expect(of('notes.read')?.members).toEqual(['list the members of each workspace'])
		expect(of('notes.share')?.links).toEqual(['issue share links of shared to a note, which grant notes.read'])
		expect(of('contacts.read')?.tables).toEqual([
			{ table: 'contact_messages', lies: 'the inbox of contact', operations: ['read', 'read email'], also: [] },
		])
		expect(of('workspaces.create')?.endpoints).toEqual([
			{ id: 'api.workspaces.create', method: 'POST', path: '/api/workspaces.create', access: 'creates workspace', callers: ['human'] },
		])
	})

	test('an action held only through a relation names the relation and the rows that confer it; an app-wide reach says so', () => {
		const contract: ContractArtifact = {
			...notesArtifact,
			relations: { author: { dimension: 'note' } },
			roles: { ...notesArtifact.roles, starter: { grants: ['workspaces.create'], member: null, via: { author: ['notes.delete'] } } },
			tables: {
				...notesArtifact.tables,
				notes: {
					...notes,
					confers: { author: { principal: 'author_id', node: 'id', expires: null, assign: { maxDays: 30, self: false } } },
					relationWhen: { author: { 'notes.delete': { archived: { eq: false } } } },
				},
				audit: {
					scope: { mode: 'app', reason: 'every export', key: 'id' },
					actions: { read: 'contacts.read', insert: null, update: null, delete: null, appRead: ['notes.admin'] },
					insert: [],
					update: [],
					version: null,
					createdBy: null,
					columns: { note: { write: 'notes.share' } },
				},
			},
		}
		const map = accessMap(contract)
		expect(map.roles.find((role) => role.role === 'starter')?.via).toEqual([{
			relation: 'author',
			dimension: 'note',
			actions: ['notes.delete'],
			conferredBy: ['a row of notes naming author_id at id; an insert delegates it for at most 30 days'],
		}])
		const of = (name: string) => map.actions.find((action) => action.action === name)
		expect(of('notes.admin')?.tables).toEqual([{ table: 'audit', lies: 'app-wide', operations: ['read every row'], also: [] }])
		expect(of('notes.share')?.tables).toEqual([{ table: 'audit', lies: 'app-wide', operations: ['write note'], also: [] }])
		expect(of('notes.delete')?.tables[0]?.also).toEqual(['through relation author, only a row its condition holds'])
	})

	test('a column read by a list is read by each listed action and by no other', () => {
		const people: TablePolicyArtifact = {
			scope: { mode: 'app', reason: 'every person', key: 'id' },
			actions: { read: ['notes.read', 'notes.admin', 'notes.share'], insert: null, update: null, delete: null },
			insert: [],
			update: [],
			version: null,
			createdBy: null,
			columns: { email: { read: ['notes.admin', 'notes.share'] } },
		}
		const map = accessMap({ ...notesArtifact, tables: { people } })
		const operations = (name: string) => map.actions.find((action) => action.action === name)?.tables[0]?.operations
		expect(operations('notes.admin')).toEqual(['read', 'read email'])
		expect(operations('notes.share')).toEqual(['read', 'read email'])
		expect(operations('notes.read')).toEqual(['read'])
	})

	test('a path column, a reveal and a member reveal say where else a grant reaches the rows', () => {
		const deals: TablePolicyArtifact = {
			scope: { mode: 'dimension', dimension: 'note', key: 'id', container: { dimension: 'workspace', column: 'workspace_id' } },
			actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: null },
			insert: [],
			update: [],
			version: null,
			createdBy: null,
			columns: {},
			readThrough: { project: 'project_id' },
			writeThrough: { project: ['notes.write'] },
			memberReveals: { note: { to: 'workspace', actions: ['notes.share'] } },
		}
		const map = accessMap({ ...notesArtifact, tables: { deals } })
		const of = (name: string) => map.actions.find((action) => action.action === name)?.tables
		expect(of('notes.read')?.[0]?.also).toEqual(['a read over a project also reaches the rows its project_id names'])
		expect(of('notes.write')?.[0]?.also).toEqual([
			'held on a row by a grant at the project its project_id names, writes included; whoever inserts project_id must hold it there',
		])
		expect(of('notes.share')).toEqual([{
			table: 'deals',
			lies: 'one row per note, inside its workspace',
			operations: [],
			also: ['a row reveals its workspace to a holder of it at its note'],
		}])
	})

	test('an endpoint that needs two capabilities names the other one under each', () => {
		const both: EndpointRow = {
			id: 'api.notes.move',
			source: { kind: 'mount', name: 'api' },
			kind: 'mutation',
			method: 'POST',
			path: '/api/notes.move',
			callers: ['human', 'machine'],
			requirement: {
				kind: 'capabilities',
				capabilities: {
					note: { action: 'notes.write', access: { form: 'on', dimension: 'note', from: 'id' } },
					target: { action: 'notes.write', access: { form: 'in', dimension: 'workspace', from: 'to' } },
				},
			},
			admission: { contentTypes: ['application/json'], maxBytes: null },
			input: null,
			output: null,
		}
		const map = accessMap({ ...notesArtifact, endpoints: [both] })
		expect(map.actions.find((action) => action.action === 'notes.write')?.endpoints.map((endpoint) => endpoint.access)).toEqual([
			'on note, with also notes.write in workspace',
			'in workspace, with also notes.write on note',
		])
	})

	test('a snapshot without a contract maps nothing', () => {
		expect(snapshotAccessMap(EMPTY_SNAPSHOT)).toEqual({ roles: [], actions: [], memberEndpoints: [] })
	})
})
