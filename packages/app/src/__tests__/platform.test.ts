import { appSchemaSchema } from '@fabrika/auth'
import { BUILTIN_ROLE_KEYS, type ContractArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { compileContract, defineContract, schemaFromContract } from '../contract'
import { contract as implementContract } from './fixtures/implement/fabrika.contract'
import { NOTE_TABLE } from './fixtures/implement/stores'
import { contract as notesContract } from './fixtures/notes-app/fabrika.contract'

const Empty = z.strictObject({})
const ById = z.strictObject({ id: z.uuid() })

/** Both caller kinds on one mount, and another application as a caller. */
const mixedContract = defineContract({
	app: 'mixed',
	dimensions: { queue: {} },
	actions: { 'jobs.run': 'Run jobs' },
	roles: { runner: { grants: ['jobs.run'] } },
}, (c) => ({
	tasks: c.rpc('/tasks', { callers: ['human', 'machine'] }, {
		run: c.mutation({ input: Empty, output: Empty, access: { action: 'jobs.run', over: 'queue' } }),
	}),
	partner: c.rpc('/partner', { callers: ['app:billing'] }, {
		ping: c.query({ output: Empty, access: { member: true } }),
	}),
	health: c.health('/healthz'),
}))

const notes = compileContract(notesContract, notesArtifact.tables)
const implemented = compileContract(implementContract, { notes: NOTE_TABLE })
const mixed = compileContract(mixedContract, {})

const FIXTURES: [string, ContractArtifact][] = [['the notes contract', notes], ['the implement fixture', implemented], ['mixed callers', mixed]]

const membersContract = defineContract({
	app: 'teams',
	dimensions: {
		workspace: { creator: 'owner', members: { manage: 'workspace.admin', list: 'workspace.read' } },
		note: { in: 'workspace' },
	},
	actions: {
		'workspace.admin': 'Manage the workspace and its members',
		'workspace.read': 'See the workspace',
		'workspace.create': 'Start a workspace',
	},
	roles: {
		owner: { grants: ['workspace.admin', 'workspace.read'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		viewer: { grants: ['workspace.read'], member: { scope: 'workspace', assignableBy: [] } },
		starter: { grants: ['workspace.create'] },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		members: { invite: c.mutation({ input: ById, output: Empty, access: { action: 'workspace.admin', on: 'workspace', from: 'id' } }) },
		notes: { purge: c.mutation({ input: ById, output: Empty, access: { action: 'workspace.admin', on: 'note', from: 'id' } }) },
		workspaces: { create: c.mutation({ input: Empty, output: ById, access: { action: 'workspace.create', creates: 'workspace' } }) },
	}),
}))

const members = compileContract(membersContract, {})

describe('schemaFromContract', () => {
	test('the notes contract: scopes with their membership metadata, actions, roles, link mounts and delegations', () => {
		expect(schemaFromContract(notes)).toEqual({
			scopes: [
				{ type: 'file:attachments', in: 'note' },
				{ type: 'note', in: 'workspace' },
				{ type: 'workspace', creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } },
			],
			actions: [
				{ action: 'contacts.read', description: 'Read contact messages' },
				{ action: 'notes.admin', description: 'Manage the workspace and its members' },
				{ action: 'notes.delete', description: 'Delete notes' },
				{ action: 'notes.read', description: 'Read notes' },
				{ action: 'notes.share', description: 'Create share links for a note' },
				{ action: 'notes.write', description: 'Create and edit notes' },
				{ action: 'workspaces.create', description: 'Start a workspace' },
			],
			roles: {
				editor: {
					name: 'editor',
					permissions: ['notes.read', 'notes.share', 'notes.write'],
					member: { scope: 'workspace', assignableBy: ['owner'] },
				},
				owner: {
					name: 'owner',
					permissions: ['notes.admin', 'notes.delete', 'notes.read', 'notes.share', 'notes.write'],
					member: { scope: 'workspace', assignableBy: ['owner'] },
				},
				starter: { name: 'starter', permissions: ['workspaces.create'] },
				support: { name: 'support', permissions: ['contacts.read'] },
			},
			contract: true,
			links: { shared: { dimension: 'note', grants: ['notes.read'], issuedBy: 'notes.share', maxDays: 30 } },
			delegations: {
				'api.workspaces.create': { action: 'workspaces.create', dimension: 'workspace', purpose: 'creates' },
				'webhooks.github.bind': { action: 'notes.admin', dimension: 'workspace', purpose: 'members' },
				'webhooks.github.unbind': { action: 'notes.admin', dimension: 'workspace', purpose: 'members' },
			},
			workloads: [
				{ kind: 'job', name: 'purgeDeleted', actions: ['notes.delete'] },
				{ kind: 'webhook', name: 'github', actions: ['notes.write'] },
			],
		})
	})

	test("a delegation is an endpoint that creates a value or holds its dimension's members.manage action", () => {
		expect(schemaFromContract(members).delegations).toEqual({
			'api.members.invite': { action: 'workspace.admin', dimension: 'workspace', purpose: 'members' },
			'api.workspaces.create': { action: 'workspace.create', dimension: 'workspace', purpose: 'creates' },
		})
	})

	test('a contract without link mounts or delegations says so, so IAM drops what an earlier schema had', () => {
		expect(schemaFromContract(implemented)).toMatchObject({ links: {}, delegations: {}, workloads: [] })
	})

	for (const [name, artifact] of [...FIXTURES, ['the members contract', members] as const]) {
		test(`${name}: IAM's reconcile accepts it unchanged, every name resolving, with no reserved role and no wildcard`, () => {
			const schema = schemaFromContract(artifact)
			// `putAppSchema` validates the body with exactly this parser; the rest of its checks read IAM's database.
			expect(appSchemaSchema.parse(schema)).toEqual(schema)
			expect(Object.keys(schema.roles).filter((key) => BUILTIN_ROLE_KEYS.includes(key))).toEqual([])
			const named = [
				...schema.actions.map(({ action }) => action),
				...Object.values(schema.roles).flatMap((role) => role.permissions),
				...Object.values(schema.links ?? {}).flatMap((link) => [...link.grants, link.issuedBy]),
				...Object.values(schema.delegations ?? {}).map((delegation) => delegation.action),
				...(schema.workloads ?? []).flatMap((workload) => workload.actions),
			]
			expect(named.filter((action) => action.includes('*'))).toEqual([])
		})
	}
})
