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

const mixedVocabulary = {
	app: 'mixed',
	dimensions: { queue: {} },
	actions: { 'jobs.run': 'Run jobs' },
	roles: { runner: { grants: ['jobs.run'] } },
} as const

/** Both caller kinds on one mount, and another application as the consumer of an export. */
const mixedContract = defineContract(mixedVocabulary, (c) => ({
	tasks: c.rpc('/tasks', { callers: ['human', 'machine'] }, {
		run: c.mutation({ input: Empty, output: Empty, access: { action: 'jobs.run', over: 'queue' } }),
	}),
	exports: {
		queue: c.export({
			version: 1,
			consumers: ['billing'],
			audience: 'any consumer user',
			procedures: { depth: c.query({ output: Empty, access: { action: 'jobs.run', over: 'queue' } }) },
		}),
	},
	health: c.health('/healthz'),
}))

/** The notes fixture's tables without auth-core's 0.5 form inbox, which a 0.6 contract no longer declares. */
const { contact_messages: _inbox, ...noteTables } = notesArtifact.tables
const notes = compileContract(notesContract, noteTables)
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
				{ type: 'note', in: 'workspace' },
				{
					type: 'workspace',
					creator: 'owner',
					members: { manage: 'notes.admin', list: 'notes.read' },
					lookups: ['notes.delete', 'notes.write'],
				},
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
			},
			workloads: [
				{ kind: 'app', name: 'shop', actions: ['notes.read'] },
				{ kind: 'job', name: 'purgeDeleted', actions: ['notes.delete'] },
				{ kind: 'webhook', name: 'github', actions: ['notes.write'] },
			],
		})
	})

	test("an export's consumer is an app workload holding the actions of the export rows it may call", () => {
		expect(schemaFromContract(mixed).workloads).toEqual([{ kind: 'app', name: 'billing', actions: ['jobs.run'] }])
	})

	test("a delegation is an endpoint that creates a value or holds its dimension's members.manage action", () => {
		expect(schemaFromContract(members).delegations).toEqual({
			'api.members.invite': { action: 'workspace.admin', dimension: 'workspace', purpose: 'members' },
			'api.workspaces.create': { action: 'workspace.create', dimension: 'workspace', purpose: 'creates' },
		})
	})

	test('the locale and the display name reach IAM only when the vocabulary declares them', () => {
		const named = defineContract({ ...mixedVocabulary, locale: 'cs', displayName: 'Fronta úloh' }, () => ({}))
		const schema = schemaFromContract(compileContract(named, {}))
		expect([schema.locale, schema.displayName]).toEqual(['cs', 'Fronta úloh'])
		expect(appSchemaSchema.parse(schema)).toEqual(schema)
		const unnamed = schemaFromContract(compileContract(defineContract(mixedVocabulary, () => ({})), {}))
		expect('locale' in unnamed || 'displayName' in unnamed || 'mail' in unnamed).toBe(false)
		const mail = { reset: { cs: { subject: 'Nové heslo', text: 'Heslo si nastavíte zde: {{actionUrl}}' } } }
		const worded = schemaFromContract(compileContract(defineContract({ ...mixedVocabulary, mail }, () => ({})), {}))
		expect(worded.mail).toEqual(mail)
		expect(appSchemaSchema.parse(worded)).toEqual(worded)
		expect('mail' in compileContract(defineContract({ ...mixedVocabulary, mail: {} }, () => ({})), {})).toBe(false)
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
