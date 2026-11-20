// The access map of a snapshot: each role with the actions it holds, and once per action the endpoints that require it,
// the tables it reaches, the members it manages or lists and the share links it issues.

import type { ContractArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { accessMap, snapshotAccessMap } from '../approval/access-map'
import { EMPTY_SNAPSHOT } from '../approval/snapshot'

describe('the access map', () => {
	test('a membership role says where it is granted and who assigns it; an application-wide role is global', () => {
		const { roles } = accessMap(notesArtifact)
		expect(roles.map((role) => role.role)).toEqual(['editor', 'owner', 'starter', 'support'])
		expect(roles[0]).toEqual({
			role: 'editor',
			scope: 'workspace',
			assignableBy: ['owner'],
			external: false,
			actions: ['notes.read', 'notes.share', 'notes.write'],
			via: [],
		})
		expect(roles[2]).toMatchObject({ role: 'starter', scope: null, assignableBy: [], actions: ['workspaces.create'] })
	})

	test('an action lists the endpoints that require it, where, and what it does in each table', () => {
		const remove = accessMap(notesArtifact).actions.find((action) => action.action === 'notes.delete')
		expect(remove).toEqual({
			action: 'notes.delete',
			description: 'Delete notes',
			endpoints: [{ id: 'api.notes.remove', method: 'POST', path: '/api/notes.remove', access: 'on note' }],
			members: [],
			links: [],
			tables: [{ table: 'notes', lies: 'one row per note, inside its workspace', operations: ['delete'] }],
		})
	})

	test('an action names the members it manages or lists, the links it issues and the columns it alone reads', () => {
		const { actions } = accessMap(notesArtifact)
		const of = (name: string) => actions.find((action) => action.action === name)
		expect(of('notes.admin')?.members).toEqual(['manage the members of each workspace'])
		expect(of('notes.read')?.members).toEqual(['list the members of each workspace'])
		expect(of('notes.share')?.links).toEqual(['issue share links of shared to a note, which grant notes.read'])
		expect(of('contacts.read')?.tables).toEqual([{ table: 'contact_messages', lies: 'the inbox of contact', operations: ['read', 'read email'] }])
		expect(of('workspaces.create')?.endpoints).toEqual([
			{ id: 'api.workspaces.create', method: 'POST', path: '/api/workspaces.create', access: 'creates workspace' },
		])
	})

	test('an action held only through a relation is listed with the relation, and an app-wide reach says so', () => {
		const contract: ContractArtifact = {
			...notesArtifact,
			relations: { author: { dimension: 'note' } },
			roles: { ...notesArtifact.roles, starter: { grants: ['workspaces.create'], member: null, via: { author: ['notes.delete'] } } },
			tables: {
				...notesArtifact.tables,
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
		expect(map.roles.find((role) => role.role === 'starter')?.via).toEqual([{ relation: 'author', dimension: 'note', actions: ['notes.delete'] }])
		const of = (name: string) => map.actions.find((action) => action.action === name)
		expect(of('notes.admin')?.tables).toEqual([{ table: 'audit', lies: 'app-wide', operations: ['read every row'] }])
		expect(of('notes.share')?.tables).toEqual([{ table: 'audit', lies: 'app-wide', operations: ['write note'] }])
	})

	test('a snapshot without a contract maps nothing', () => {
		expect(snapshotAccessMap(EMPTY_SNAPSHOT)).toEqual({ roles: [], actions: [] })
	})
})
