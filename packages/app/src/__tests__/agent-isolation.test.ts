// An agent's device grant at an application (ADR-0090), end to end through the test kit: the production proxy decision
// exchanges the agent's resource token at the kit's IAM, which narrows the person's live permissions to the grant's
// value with auth-core's `narrowToValue`, and the real dispatcher repeats the caller and scope checks. The witness of
// §4: a token narrowed to project A reaches A and nothing in B, in an application that declares no cross-value
// mechanism.

import { createClient } from '@fabrika/app/client'
import { defineContract } from '@fabrika/app/contract'
import type { ContractDatabase } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { AGENT_CLIENT_ID, type AgentScope, buildAccessClaims } from '@fabrika/auth-core'
import type { CapabilityAuthority, CapabilityGrant, Ref, Within } from '@fabrika/db/capability'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'
import { notesApp } from './fixtures/implement/app'
import { APP_ID, bootApp, ISSUER, send, sign } from './fixtures/implement/harness'

const TA = '0190a0a0-0000-7000-8000-00000000000a'
const TB = '0190a0a0-0000-7000-8000-00000000000b'

const Task = z.strictObject({ id: z.uuid(), title: z.string() })
const ById = z.strictObject({ id: z.uuid() })
const InProject = z.strictObject({ projectId: z.string() })
const NewTask = z.strictObject({ projectId: z.string(), title: z.string() })

const contract = defineContract({
	// The name the dispatch harness boots an application under.
	app: 'notes',
	dimensions: { project: {}, task: { in: 'project' } },
	actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Create tasks' },
	roles: { reader: { grants: ['tasks.read'] }, editor: { grants: ['tasks.read', 'tasks.write'] } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human', 'agent'] }, {
		whoami: c.query({
			output: z.strictObject({ person: z.string(), agent: z.string().nullable(), label: z.string().nullable(), scope: z.string().nullable() }),
			access: { member: true },
		}),
		tasks: {
			list: c.query({ output: z.strictObject({ items: z.array(Task) }), access: { action: 'tasks.read', over: 'project' } }),
			get: c.query({ input: ById, output: Task, access: { action: 'tasks.read', on: 'task', from: 'id' } }),
			count: c.query({
				input: InProject,
				output: z.strictObject({ project: z.string() }),
				access: { action: 'tasks.read', in: 'project', from: 'projectId' },
			}),
			create: c.mutation({ input: NewTask, output: Task, access: { action: 'tasks.write', in: 'project', from: 'projectId' } }),
		},
	}),
	people: c.rpc('/people', { callers: ['human'] }, {
		me: c.query({ output: z.strictObject({ id: z.string() }), access: { member: true } }),
	}),
}))

interface TaskRow {
	readonly id: string
	readonly projectId: string
	readonly title: string
}

const TASK_TABLE = {
	scope: { mode: 'dimension', dimension: 'task', key: 'id', container: { dimension: 'project', column: 'project_id' } },
	actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write', delete: 'tasks.write' },
	insert: ['title'],
	update: ['title'],
	version: null,
	createdBy: null,
	columns: {},
} as const

function grantOf(capabilities: CapabilityAuthority, capability: unknown, kind: 'ref' | 'within', dimension: string): CapabilityGrant {
	const grant = capabilities.resolve(capability)
	if (grant.kind !== kind || grant.dimension !== dimension) throw new Error(`needs a ${kind} of ${dimension}`)
	return grant
}

/** The in-memory store a data layer would be: it reads only what each capability names. */
function taskStore(capabilities: CapabilityAuthority, rows: Map<string, TaskRow>) {
	return {
		list: (within: Within<'project', 'tasks.read'>): TaskRow[] => {
			const grant = grantOf(capabilities, within, 'within', 'project')
			const values = grant.kind === 'within' ? grant.values : []
			return [...rows.values()].filter((row) => values === 'all' || values.includes(row.projectId))
		},
		get: (task: Ref<'task', 'tasks.read'>): TaskRow => {
			const grant = grantOf(capabilities, task, 'ref', 'task')
			const row = grant.kind === 'ref' ? rows.get(grant.id) : undefined
			if (row === undefined) throw new Error('missing row')
			return row
		},
		insert: (project: Ref<'project', 'tasks.write'>, title: string): TaskRow => {
			const grant = grantOf(capabilities, project, 'ref', 'project')
			const row = { id: crypto.randomUUID(), projectId: grant.kind === 'ref' ? grant.id : '', title }
			rows.set(row.id, row)
			return row
		},
	}
}

function tasksApp() {
	const rows = new Map<string, TaskRow>([
		[TA, { id: TA, projectId: 'a', title: 'in A' }],
		[TB, { id: TB, projectId: 'b', title: 'in B' }],
	])
	const database: ContractDatabase = {
		tables: { tasks: TASK_TABLE },
		locate: (dimension, id) => {
			const row = dimension === 'task' ? rows.get(id) : undefined
			return Promise.resolve(row === undefined ? null : new Map([['project', row.projectId]]))
		},
	}
	return implement(contract, {
		database,
		deps: (_env, { capabilities }) => ({ tasks: taskStore(capabilities, rows) }),
		handlers: ({ tasks }) => ({
			api: {
				whoami: ({ ctx }) => ({
					person: ctx.principal.id,
					agent: ctx.agent?.grant ?? null,
					label: ctx.agent?.label ?? null,
					scope: ctx.agent === null
						? null
						: ctx.agent.scope.within === null
						? ctx.agent.scope.mode
						: `${ctx.agent.scope.mode}:${ctx.agent.scope.within.value}`,
				}),
				tasks: {
					list: ({ ctx }) => ({ items: tasks.list(ctx.within).map((row) => ({ id: row.id, title: row.title })) }),
					get: ({ ctx }) => {
						const row = tasks.get(ctx.target)
						return { id: row.id, title: row.title }
					},
					count: ({ ctx }) => ({ project: ctx.target.value }),
					create: ({ input, ctx }) => {
						const row = tasks.insert(ctx.target, input.title)
						return { id: row.id, title: row.title }
					},
				},
			},
			people: { me: ({ ctx }) => ({ id: ctx.principal.id }) },
		}),
	})
}

const A = { type: 'project', value: 'a' } as const
const B = { type: 'project', value: 'b' } as const

function post(body: unknown, token: string): RequestInit {
	return { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }
}

describe('an agent narrowed to project A (ADR-0090 §4)', () => {
	const kit = testKit(tasksApp())

	test('reaches A as the person, and nothing in B, though the person holds the same role in B', async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }, { role: 'reader', scope: B }])
		const { token } = await kit.agentGrant(person, { scope: 'read:project=a' })
		const agent = createClient(contract, 'api', { fetch: kit.fetch, key: token })
		expect(await agent.tasks.get({ id: TA })).toEqual({ id: TA, title: 'in A' })
		expect(await agent.tasks.count({ projectId: 'a' })).toEqual({ project: 'a' })
		expect(await agent.tasks.list()).toEqual({ items: [{ id: TA, title: 'in A' }] })
		expect((await kit.fetch('/api/tasks.get', post({ id: TB }, token))).status).toBe(404)
		expect((await kit.fetch('/api/tasks.count', post({ projectId: 'b' }, token))).status).toBe(403)
	})

	test('a global grant narrowed to A reaches A only', async () => {
		const person = kit.testCaller([{ role: 'reader' }])
		const { token } = await kit.agentGrant(person, { scope: 'read:project=a' })
		const agent = createClient(contract, 'api', { fetch: kit.fetch, key: token })
		expect(await agent.tasks.list()).toEqual({ items: [{ id: TA, title: 'in A' }] })
		expect(await agent.tasks.get({ id: TA })).toEqual({ id: TA, title: 'in A' })
		expect((await kit.fetch('/api/tasks.get', post({ id: TB }, token))).status).toBe(404)
		expect((await kit.fetch('/api/tasks.count', post({ projectId: 'b' }, token))).status).toBe(403)
	})

	test('without the narrowing the same person reaches B: the narrowing is what keeps the agent in A', async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }, { role: 'reader', scope: B }])
		const { token } = await kit.agentGrant(person)
		const agent = createClient(contract, 'api', { fetch: kit.fetch, key: token })
		expect(await agent.tasks.get({ id: TB })).toEqual({ id: TB, title: 'in B' })
		expect((await agent.tasks.list()).items).toHaveLength(2)
	})

	test('a person whose grants are all in B gets nothing in A or B', async () => {
		const person = kit.testCaller([{ role: 'reader', scope: B }])
		const { token } = await kit.agentGrant(person, { scope: 'read:project=a' })
		expect((await kit.fetch('/api/tasks.get', post({ id: TB }, token))).status).toBe(403)
		expect((await kit.fetch('/api/tasks.get', post({ id: TA }, token))).status).toBe(403)
	})
})

describe('the agent caller and its scope', () => {
	const kit = testKit(tasksApp())

	test('ctx.principal is the person and ctx.agent the grant; a person calling has ctx.agent null', async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }])
		const { grant, token } = await kit.agentGrant(person, { scope: 'read:project=a', label: 'nightly report' })
		const agent = createClient(contract, 'api', { fetch: kit.fetch, key: token })
		expect(await agent.whoami()).toEqual({ person: person.id, agent: grant, label: 'nightly report', scope: 'read:a' })
		const own = createClient(contract, 'api', { fetch: kit.browser(person) })
		expect(await own.whoami()).toEqual({ person: person.id, agent: null, label: null, scope: null })
	})

	test('a read grant is refused on a mutation, and a write grant is refused at the exchange until agent-write is mirrored', async () => {
		const person = kit.testCaller([{ role: 'editor', scope: A }])
		const read = await kit.agentGrant(person, { scope: 'read:project=a' })
		const refused = await kit.fetch('/api/tasks.create', post({ projectId: 'a', title: 'x' }, read.token))
		expect(refused.status).toBe(403)
		expect(refused.headers.get('WWW-Authenticate')).toContain('insufficient_scope')
		const write = await kit.agentGrant(person, { scope: 'write:project=a' })
		const exchanged = await kit.fetch('/api/tasks.create', post({ projectId: 'a', title: 'x' }, write.token))
		expect(exchanged.status).toBe(401)
	})

	test("a group that does not list agent refuses the agent's token without a call to IAM", async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }])
		const { token } = await kit.agentGrant(person)
		expect((await kit.fetch('/people/me', post({}, token))).status).toBe(401)
	})

	test("the kit's IAM refuses a grant where IAM's device start refuses it", async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }])
		await expect(kit.agentGrant(person, { scope: 'read:team=a' })).rejects.toThrow("'team' is not a dimension of the contract")
		await expect(kit.agentGrant(person, { scope: 'admin' })).rejects.toThrow("'admin' is no agent scope")
		const notes = testKit(notesApp(new Map()))
		await expect(notes.agentGrant(notes.testCaller([{ action: 'notes.read' }]))).rejects.toThrow("no group of the contract lists 'agent'")
	})
})

describe('the application repeats the caller and scope checks (ADR-0022 rule 5)', () => {
	const app = bootApp(tasksApp())

	/** A person's token acting for an agent under `scope`, as the proxy injects it after the exchange. */
	function agentToken(scope: AgentScope): Promise<string> {
		const now = Math.floor(Date.now() / 1000)
		return sign(buildAccessClaims({
			iss: ISSUER,
			app: APP_ID,
			subject: 'user-1',
			type: 'user',
			label: 'Ann',
			email: 'ann@example.com',
			permissions: [{ action: 'tasks.write', scope: A, source: 'grant' }, { action: 'tasks.read', scope: A, source: 'grant' }],
			issuedAt: now - 10,
			expiresAt: now + 300,
			act: { sub: AGENT_CLIENT_ID, grant: 'grant-1', scope },
		}))
	}

	test('a read grant reaches no mutation even when the proxy let it through; a write grant does', async () => {
		const body = { projectId: 'a', title: 'x' }
		const read = await send(app, '/api/tasks.create', { body, token: await agentToken({ mode: 'read', within: A }) })
		expect(read.status).toBe(403)
		const write = await send(app, '/api/tasks.create', { body, token: await agentToken({ mode: 'write', within: A }) })
		expect(write.status).toBe(200)
	})

	test("an agent's token reaches no group that does not list agent", async () => {
		const sent = await send(app, '/people/me', { body: {}, token: await agentToken({ mode: 'read', within: null }) })
		expect(sent.status).toBe(403)
	})
})
