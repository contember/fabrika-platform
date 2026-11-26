// An agent's device grant at an application (ADR-0090), end to end through the test kit: the production proxy decision
// exchanges the agent's resource token at the kit's IAM, which narrows the person's live permissions to the grant's
// value with auth-core's `narrowToValue`, the real dispatcher repeats the caller and scope checks, and the handlers read
// through `@fabrika/db` on SQLite. The witness of §4: a token narrowed to project A reaches A and nothing in B, in an
// application that declares no cross-value mechanism, and a grant at a container of A does not reach A.

import { createClient } from '@fabrika/app/client'
import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { AGENT_CLIENT_ID, type AgentScope, buildAccessClaims } from '@fabrika/auth-core'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { notesApp } from './fixtures/implement/app'
import { APP_ID, bootApp, ISSUER, send, sign } from './fixtures/implement/harness'

const TA = '0190a0a0-0000-7000-8000-00000000000a'
const TB = '0190a0a0-0000-7000-8000-00000000000b'

const vocabulary = defineVocabulary({
	// The name the dispatch harness boots an application under.
	app: 'notes',
	dimensions: { organization: {}, project: { in: 'organization' }, task: { in: 'project' } },
	actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Create tasks' },
	roles: { reader: { grants: ['tasks.read'] }, editor: { grants: ['tasks.read', 'tasks.write'] } },
})

interface DB {
	projects: { id: string; organization_id: string; name: string }
	tasks: { id: string; project_id: string; organization_id: string; title: string }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'organization_id', 'name'], foreignKeys: [] },
	tasks: {
		columns: ['id', 'project_id', 'organization_id', 'title'],
		foreignKeys: [{ columns: ['project_id', 'organization_id'], table: 'projects', references: ['id', 'organization_id'] }],
	},
}

const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project', key: 'id', in: { dimension: 'organization', column: 'organization_id' } },
		actions: { read: 'tasks.read' },
	},
	tasks: {
		scope: { dimension: 'task', key: 'id', in: { dimension: 'project', column: 'project_id' } },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['title'],
	},
})

const app = defineApp(vocabulary, tables)

const Task = z.strictObject({ id: z.uuid(), title: z.string() })

const self = app.group({ callers: ['human', 'agent'] }, (r) => ({
	whoami: r.query({
		output: z.strictObject({ person: z.string(), agent: z.string().nullable(), label: z.string().nullable(), scope: z.string().nullable() }),
		access: { member: true },
	}).handle(({ ctx }) => ({
		person: ctx.principal.id,
		agent: ctx.agent?.grant ?? null,
		label: ctx.agent?.label ?? null,
		scope: ctx.agent === null
			? null
			: ctx.agent.scope.within === null
			? ctx.agent.scope.mode
			: `${ctx.agent.scope.mode}:${ctx.agent.scope.within.value}`,
	})),
}))

const tasks = app.group({ callers: ['human', 'agent'] }, (r) => ({
	list: r.query({ output: z.strictObject({ items: z.array(Task) }), access: { action: 'tasks.read', over: 'project' } })
		.handle(async ({ ctx }) => {
			const page = await ctx.db.within.tasks.list({ orderBy: [['id', 'asc']] })
			return { items: page.items.map((task) => ({ id: task.id, title: task.title })) }
		}),
	get: r.query({ input: z.strictObject({ id: z.uuid() }), output: Task, access: { action: 'tasks.read', on: 'task', from: 'id' } })
		.handle(async ({ ctx }) => {
			const task = await ctx.db.target.get()
			return { id: task.id, title: task.title }
		}),
	count: r.query({
		input: z.strictObject({ projectId: z.string() }),
		output: z.strictObject({ project: z.string(), tasks: z.int() }),
		access: { action: 'tasks.read', in: 'project', from: 'projectId' },
	}).handle(async ({ ctx }) => ({ project: ctx.target.value, tasks: (await ctx.db.target.tasks.list()).items.length })),
	create: r.mutation({
		input: z.strictObject({ projectId: z.string(), title: z.string() }),
		output: Task,
		access: { action: 'tasks.write', in: 'project', from: 'projectId' },
	}).handle(async ({ input, ctx }) => {
		const { id } = await ctx.db.target.tasks.insert({ title: input.title })
		return { id, title: input.title }
	}),
}))

const people = app.group({ callers: ['human'] }, (r) => ({
	me: r.query({ output: z.strictObject({ id: z.string() }), access: { member: true } }).handle(({ ctx }) => ({ id: ctx.principal.id })),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { self, tasks }), people: c.rpc('/people', { people }) }))
const served = serve(contract, { database: scoped(tables) })

// Project a lies in organization o, project b in organization p; one task in each.
const migrations = mkdtempSync(join(tmpdir(), 'agent-isolation-'))
writeFileSync(
	join(migrations, '20261126120000_tasks.sql'),
	[
		'CREATE TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, UNIQUE (id, organization_id)) STRICT;',
		'CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, organization_id TEXT NOT NULL, title TEXT NOT NULL,'
		+ ' FOREIGN KEY (project_id, organization_id) REFERENCES projects (id, organization_id)) STRICT;',
		"INSERT INTO projects VALUES ('a', 'o', 'A'), ('b', 'p', 'B');",
		`INSERT INTO tasks VALUES ('${TA}', 'a', 'o', 'in A'), ('${TB}', 'b', 'p', 'in B');`,
		'',
	].join('\n'),
)
const sqlite = await testDatabase({ migrations, label: 'agent-isolation.test.ts' })
afterAll(async () => {
	await sqlite.close()
	rmSync(migrations, { recursive: true, force: true })
})

const A = { type: 'project', value: 'a' } as const
const B = { type: 'project', value: 'b' } as const
const O = { type: 'organization', value: 'o' } as const

function post(body: unknown, token: string): RequestInit {
	return { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }
}

// One kit for the file: a later kit of the same application takes the data layer over from an earlier one.
const kit = testKit(served, { database: sqlite.database })
const client = (token: string) => createClient(contract, 'api', { fetch: kit.fetch, key: token })

describe('an agent narrowed to project A (ADR-0090 §4)', () => {
	test('reaches A as the person, and nothing in B, though the person holds the same role in B', async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }, { role: 'reader', scope: B }])
		const { token } = await kit.agentGrant(person, { scope: 'read:project=a' })
		const agent = client(token)
		expect(await agent.tasks.get({ id: TA })).toEqual({ id: TA, title: 'in A' })
		expect(await agent.tasks.count({ projectId: 'a' })).toEqual({ project: 'a', tasks: 1 })
		expect(await agent.tasks.list()).toEqual({ items: [{ id: TA, title: 'in A' }] })
		expect((await kit.fetch('/api/tasks.get', post({ id: TB }, token))).status).toBe(404)
		expect((await kit.fetch('/api/tasks.count', post({ projectId: 'b' }, token))).status).toBe(403)
	})

	test('a global grant narrowed to A reaches A only', async () => {
		const person = kit.testCaller([{ role: 'reader' }])
		const { token } = await kit.agentGrant(person, { scope: 'read:project=a' })
		const agent = client(token)
		expect(await agent.tasks.list()).toEqual({ items: [{ id: TA, title: 'in A' }] })
		expect(await agent.tasks.get({ id: TA })).toEqual({ id: TA, title: 'in A' })
		expect((await kit.fetch('/api/tasks.get', post({ id: TB }, token))).status).toBe(404)
		expect((await kit.fetch('/api/tasks.count', post({ projectId: 'b' }, token))).status).toBe(403)
	})

	test('without the narrowing the same person reaches B: the narrowing is what keeps the agent in A', async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }, { role: 'reader', scope: B }])
		const { token } = await kit.agentGrant(person)
		const agent = client(token)
		expect(await agent.tasks.get({ id: TB })).toEqual({ id: TB, title: 'in B' })
		expect((await agent.tasks.list()).items).toHaveLength(2)
	})

	test('a person whose grants are all in B gets nothing in A or B', async () => {
		const person = kit.testCaller([{ role: 'reader', scope: B }])
		const { token } = await kit.agentGrant(person, { scope: 'read:project=a' })
		expect((await kit.fetch('/api/tasks.get', post({ id: TB }, token))).status).toBe(403)
		expect((await kit.fetch('/api/tasks.get', post({ id: TA }, token))).status).toBe(403)
	})

	test("a grant at A's organization is dropped, not narrowed: the agent reaches nothing, though the person reaches A", async () => {
		const person = kit.testCaller([{ role: 'reader', scope: O }])
		const own = createClient(contract, 'api', { fetch: kit.browser(person) })
		expect(await own.tasks.get({ id: TA })).toEqual({ id: TA, title: 'in A' })
		const { token } = await kit.agentGrant(person, { scope: 'read:project=a' })
		expect((await kit.fetch('/api/tasks.get', post({ id: TA }, token))).status).toBe(403)
		expect((await kit.fetch('/api/tasks.count', post({ projectId: 'a' }, token))).status).toBe(403)
		expect((await kit.fetch('/api/tasks.list', post({}, token))).status).toBe(403)
	})
})

describe('the agent caller and its scope', () => {
	test('ctx.principal is the person and ctx.agent the grant; a person calling has ctx.agent null', async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }])
		const { grant, token } = await kit.agentGrant(person, { scope: 'read:project=a', label: 'nightly report' })
		expect(await client(token).self.whoami()).toEqual({ person: person.id, agent: grant, label: 'nightly report', scope: 'read:a' })
		const own = createClient(contract, 'api', { fetch: kit.browser(person) })
		expect(await own.self.whoami()).toEqual({ person: person.id, agent: null, label: null, scope: null })
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
		expect((await kit.fetch('/people/people.me', post({}, token))).status).toBe(401)
	})

	test("the kit's IAM refuses a grant where IAM's device start refuses it", async () => {
		const person = kit.testCaller([{ role: 'reader', scope: A }])
		await expect(kit.agentGrant(person, { scope: 'read:team=a' })).rejects.toThrow("'team' is not a dimension of the contract")
		await expect(kit.agentGrant(person, { scope: 'admin' })).rejects.toThrow("'admin' is no agent scope")
		// Last: a later kit of an application named `notes` takes the file's kit over.
		const notes = testKit(notesApp(new Map()))
		await expect(notes.agentGrant(notes.testCaller([{ action: 'notes.read' }]))).rejects.toThrow("no group of the contract lists 'agent'")
	})
})

describe('the application repeats the caller and scope checks (ADR-0022 rule 5)', () => {
	// Its own implementation: the kit above bound `served` to the data layer.
	const booted = bootApp(serve(contract, { database: scoped(tables) }), { database: sqlite.database })

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

	test('a read grant reaches no mutation even when the proxy let it through; a write grant does, into the table', async () => {
		const body = { projectId: 'a', title: 'written by the agent' }
		const read = await send(booted, '/api/tasks.create', { body, token: await agentToken({ mode: 'read', within: A }) })
		expect(read.status).toBe(403)
		const write = await send(booted, '/api/tasks.create', { body, token: await agentToken({ mode: 'write', within: A }) })
		expect(write.status).toBe(200)
		const counted = await send(booted, '/api/tasks.count', { body: { projectId: 'a' }, token: await agentToken({ mode: 'read', within: A }) })
		expect(counted.body).toEqual({ result: { project: 'a', tasks: 2 } })
	})

	test("an agent's token reaches no group that does not list agent", async () => {
		const sent = await send(booted, '/people/people.me', { body: {}, token: await agentToken({ mode: 'read', within: null }) })
		expect(sent.status).toBe(403)
	})
})
