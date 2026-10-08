import { appSchemaSchema } from '@fabrika/auth'
import {
	type AppGates,
	applicableGates,
	compileEndpointTable,
	compileGates,
	type ContractArtifact,
	type EndpointRow,
	planEndpoint,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { probesFor } from '../../../auth-core/src/__tests__/fixtures/gate-probes'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { compileContract, defineContract, gatesFromContract, schemaFromContract } from '../contract'
import { contract as implementContract } from './fixtures/implement/fabrika.contract'
import { NOTE_TABLE } from './fixtures/implement/stores'
import { contract as notesContract } from './fixtures/notes-app/fabrika.contract'

const Empty = z.strictObject({})
const ById = z.strictObject({ id: z.uuid() })

/** Both caller kinds on one mount, no SPA: a path outside the mounts is undeclared. */
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

type Kind = 'service' | 'human' | 'public'

/** The order the rules of one path come in: a present key is terminal, `public` is terminal. */
const KIND_ORDER: readonly Kind[] = ['service', 'human', 'public']

/** The gate kinds a row's callers need, from the plan: `human` → `human`, every other caller → `service`. */
function kindsOf(row: EndpointRow): Set<Kind> {
	return new Set(row.callers.length === 0 ? ['public'] : row.callers.map((caller) => (caller === 'human' ? 'human' : 'service')))
}

/** The rules of the first matching path, in order: what the proxy evaluates before it falls through to another path. */
function leadingRules(gates: AppGates, path: string): { path: string; kinds: Kind[] } | null {
	const matching = applicableGates(compileGates(gates), path)
	const first = matching[0]
	if (first === undefined) {
		return null
	}
	const kinds = matching.filter(({ rule }) => rule.path === first.rule.path).flatMap(({ rule }) => (rule.kind === 'oauth' ? [] : [rule.kind]))
	return { path: first.rule.path, kinds }
}

describe('gatesFromContract', () => {
	test('the notes contract: one rule per path and kind, most specific first', () => {
		expect(gatesFromContract(notes).rules).toEqual([
			{ path: '/contact', kind: 'human' },
			{ path: '/contact', kind: 'public' },
			{ path: '/healthz', kind: 'public' },
			{ path: '/api/me', kind: 'human' },
			{ path: '/api/notes.list', kind: 'human' },
			{ path: '/api/notes.remove', kind: 'human' },
			{ path: '/api/workspaces.create', kind: 'human' },
			{ path: '/api/files.attachments.remove', kind: 'human' },
			{ path: '/machine/importNotes', kind: 'service' },
			{ path: '/__fabrika/connect/products.v1.get', kind: 'service' },
			{ path: '/s/api/note', kind: 'service' },
			{ path: '/api/files.attachments/:fileId', kind: 'human' },
			{ path: '/api/files.attachments.upload/:owner', kind: 'human' },
			{ path: '/hooks/github/:bindingId', kind: 'human' },
			{ path: '/hooks/github/:bindingId', kind: 'public' },
			{ path: '/s/*', kind: 'public' },
			{ path: '/*', kind: 'human' },
		])
	})

	test('a mount with both callers gets the service rule first', () => {
		expect(gatesFromContract(mixed).rules).toEqual([
			{ path: '/healthz', kind: 'public' },
			{ path: '/partner/ping', kind: 'service' },
			{ path: '/tasks/run', kind: 'service' },
			{ path: '/tasks/run', kind: 'human' },
		])
	})

	test('a contract with no endpoint seals the app', () => {
		expect(gatesFromContract({ ...mixed, endpoints: [], reservedPrefixes: [] })).toEqual({ rules: [] })
	})
})

describe('the generated gates against the endpoint table, on every probe path', () => {
	for (const [name, artifact] of FIXTURES) {
		const gates = gatesFromContract(artifact)
		const table = compileEndpointTable(artifact)
		const probes = probesFor(artifact.endpoints)
		const isReserved = (path: string) => artifact.reservedPrefixes.some((prefix) => path.startsWith(`${prefix}/`))
		const selected = (method: 'GET' | 'POST', path: string): EndpointRow | null => {
			const plan = planEndpoint(table, method, path)
			return plan.outcome === 'endpoint' ? plan.endpoint : null
		}

		test(`${name}: every endpoint path is admitted by its callers' kinds at its own rules`, () => {
			const failures: string[] = []
			for (const path of probes) {
				for (const method of ['GET', 'POST'] as const) {
					const row = selected(method, path)
					if (row === null) {
						continue
					}
					const leading = leadingRules(gates, path)
					const missing = [...kindsOf(row)].filter((kind) => leading?.kinds.includes(kind) !== true)
					if (missing.length > 0) {
						failures.push(`${method} ${path} → ${row.id} misses ${missing.join(', ')} at ${leading?.path ?? 'no rule'}`)
					}
				}
			}
			expect(failures).toEqual([])
		})

		test(`${name}: a path's rules admit exactly the kinds of the rows the table selects through it`, () => {
			const reached = new Map<string, Set<Kind>>()
			for (const path of probes.filter((probe) => !isReserved(probe))) {
				const leading = leadingRules(gates, path)
				if (leading === null) {
					continue
				}
				const kinds = reached.get(leading.path) ?? new Set<Kind>()
				for (const method of ['GET', 'POST'] as const) {
					const row = selected(method, path)
					for (const kind of row === null ? [] : kindsOf(row)) {
						kinds.add(kind)
					}
				}
				reached.set(leading.path, kinds)
			}
			for (const [path, kinds] of reached) {
				const declared = gates.rules.filter((rule) => rule.path === path).map((rule) => rule.kind)
				expect({ path, kinds: declared }).toEqual({ path, kinds: KIND_ORDER.filter((kind) => kinds.has(kind)) })
			}
		})

		test(`${name}: an undeclared path matches no rule`, () => {
			const undeclared = probes.filter((path) => !isReserved(path) && selected('GET', path) === null && selected('POST', path) === null)
			expect(undeclared.filter((path) => leadingRules(gates, path) !== null)).toEqual([])
		})
	}

	test('the mixed contract has undeclared paths, and they match no rule', () => {
		const gates = compileGates(gatesFromContract(mixed))
		for (const path of ['/', '/zz', '/tasks', '/tasks/', '/healthz/', '/partner/ping/x']) {
			expect(applicableGates(gates, path)).toEqual([])
		}
	})
})

/** A members endpoint, one whose action manages another dimension's members, and a `creates` endpoint. */
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
			},
		})
	})

	test("a delegation is an endpoint that creates a value or holds its dimension's members.manage action", () => {
		expect(schemaFromContract(members).delegations).toEqual({
			'api.members.invite': { action: 'workspace.admin', dimension: 'workspace', purpose: 'members' },
			'api.workspaces.create': { action: 'workspace.create', dimension: 'workspace', purpose: 'creates' },
		})
	})

	test('a contract without link mounts or delegations says so, so IAM drops what an earlier schema had', () => {
		expect(schemaFromContract(implemented)).toMatchObject({ links: {}, delegations: {} })
	})

	for (const [name, artifact] of [...FIXTURES, ['the members contract', members] as const]) {
		test(`${name}: the auth SDK's parser accepts it unchanged, every name resolving`, () => {
			const schema = schemaFromContract(artifact)
			expect(appSchemaSchema.parse(schema)).toEqual(schema)
		})
	}
})
