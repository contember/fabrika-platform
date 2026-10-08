import type { AppSchema } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { appSchemaSchema } from '../app-schema'

// The membership and link declarations IAM acts on (A12). Every name must resolve inside the same body,
// so a typo is refused at the deploy that carries it instead of becoming a dead grant at IAM.

function notes(overrides: Partial<AppSchema> = {}): AppSchema {
	return {
		contract: true,
		scopes: [
			{ type: 'workspace', creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } },
			{ type: 'note', in: 'workspace' },
		],
		actions: [
			{ action: 'notes.read' },
			{ action: 'notes.write' },
			{ action: 'notes.share' },
			{ action: 'notes.admin' },
			{ action: 'workspaces.create' },
		],
		roles: {
			editor: { name: 'Editor', permissions: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } },
			owner: {
				name: 'Owner',
				permissions: ['notes.read', 'notes.write', 'notes.share', 'notes.admin'],
				member: { scope: 'workspace', assignableBy: ['owner'] },
			},
			starter: { name: 'Starter', permissions: ['workspaces.create'] },
		},
		links: { shared: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 30 } },
		delegations: {
			'api.workspaces.invite': { action: 'notes.admin', dimension: 'workspace', purpose: 'members' },
			'api.workspaces.create': { action: 'workspaces.create', dimension: 'workspace', purpose: 'creates' },
		},
		...overrides,
	}
}

function messages(schema: unknown): string[] {
	const parsed = appSchemaSchema.safeParse(schema)
	return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe('appSchemaSchema — membership metadata', () => {
	test('a complete multi-tenant vocabulary parses and keeps every field', () => {
		const parsed = appSchemaSchema.parse(notes())
		expect(parsed).toEqual(notes())
	})

	test('a creator must be a membership role of its own scope', () => {
		const schema = notes()
		const [workspace, note] = schema.scopes
		if (workspace === undefined || note === undefined) throw new Error('fixture')
		expect(messages({ ...schema, scopes: [{ ...workspace, creator: 'starter' }, note] })).toEqual([
			'the creator of scope `workspace` must be a membership role of that scope: `starter`',
		])
	})

	test('the members actions must be exact catalog actions', () => {
		const schema = notes()
		const [workspace, note] = schema.scopes
		if (workspace === undefined || note === undefined) throw new Error('fixture')
		expect(messages({ ...schema, delegations: {}, scopes: [{ ...workspace, members: { manage: 'notes.*', list: 'notes.raed' } }, note] })).toEqual([
			'`notes.*` is not an exact action of the catalog',
			'`notes.raed` is not an exact action of the catalog',
		])
	})

	test('containment names a declared scope and never loops', () => {
		expect(messages(notes({ scopes: [{ type: 'workspace', creator: 'owner' }, { type: 'note', in: 'folder' }] }))).toContain(
			'scope `note` is in an undeclared scope: `folder`',
		)
		expect(messages(notes({ scopes: [{ type: 'workspace', in: 'note' }, { type: 'note', in: 'workspace' }] }))).toContain(
			'scope `workspace` contains itself',
		)
	})

	test('assignableBy names only membership roles of the same scope', () => {
		const schema = notes()
		const roles = {
			...schema.roles,
			editor: { name: 'Editor', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['starter'] } },
		}
		expect(messages({ ...schema, roles })).toEqual(['role `editor` is assignable only by a membership role of its scope, not `starter`'])
	})

	test('a link mount names a declared scope, exact grants and an exact issuing action, for at most a year', () => {
		expect(messages(notes({ links: { shared: { dimension: 'page', grants: ['notes.*'], issuedBy: 'notes.shre', maxDays: 30 } } }))).toEqual([
			'link mount `shared` names an undeclared scope: `page`',
			'`notes.*` is not an exact action of the catalog',
			'`notes.shre` is not an exact action of the catalog',
		])
		expect(
			appSchemaSchema.safeParse(notes({ links: { shared: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 366 } } }))
				.success,
		)
			.toBe(false)
		expect(appSchemaSchema.safeParse(notes({ links: { shared: { dimension: 'note', grants: [], issuedBy: 'notes.share', maxDays: 3 } } })).success)
			.toBe(
				false,
			)
	})

	test('a members endpoint spends only the dimension members.manage action', () => {
		expect(messages(notes({ delegations: { 'api.notes.write': { action: 'notes.write', dimension: 'workspace', purpose: 'members' } } }))).toEqual([
			'endpoint `api.notes.write` manages members only with the members.manage action of `workspace`',
		])
	})

	test('a creating endpoint names a dimension with a creator role and no container', () => {
		expect(messages(notes({ delegations: { 'api.notes.create': { action: 'notes.write', dimension: 'note', purpose: 'creates' } } }))).toEqual([
			'endpoint `api.notes.create` creates `note`, which needs a creator role and no containing scope',
		])
	})

	test('a link mount or an endpoint named __proto__ is refused', () => {
		expect(
			appSchemaSchema.safeParse({
				...notes(),
				links: JSON.parse('{"__proto__":{"dimension":"note","grants":["notes.read"],"issuedBy":"notes.share","maxDays":1}}'),
			}).success,
		)
			.toBe(false)
	})

	test('a membership role, or any role of a contract application, cannot take a built-in key', () => {
		const schema = notes()
		const roles = { ...schema.roles, admin: { name: 'Admin', permissions: ['notes.read'], member: { scope: 'workspace' } } }
		expect(messages({ ...schema, roles })).toContain(
			'role `admin` is a built-in IAM role; a membership role or a contract application role needs another key',
		)
		const plain = { ...schema.roles, admin: { name: 'Admin', permissions: ['notes.read'] } }
		expect(messages({ ...schema, roles: plain })).toHaveLength(1)
		expect(appSchemaSchema.safeParse({ ...schema, contract: false, roles: plain }).success).toBe(true)
	})
})
