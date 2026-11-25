// `ctx.notify` (ADR-0088 §6): a writing site writes a notification for one person in its own transaction, naming what
// the recipient must hold to read it, and the inbox answers it under the recipient's session. The validation first,
// with the untyped values the types refuse; then a mutation and a job through the test kit, on SQLite (the object's
// storage) always and on Postgres when FABRIKA_TEST_POSTGRES_URL is set. Nothing here sends a push.

import { defineApp, WebhookSecret } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { TEST_PUSH_KEY, testKit } from '@fabrika/app/testing'
import { applicationSchema, type Database, DatabaseError, scoped } from '@fabrika/db'
import type { NewNotification, Notifications, Session } from '@fabrika/db/framework'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { runFixedStatement, sessionOf } from '../../../db/src/database'
import { CapabilityRefusedError } from '../implement/capability'
import { notifier, type NotifyRules } from '../implement/notify'
import { dailyAhead } from './fixtures/cron-ahead'
import { pushDatabase, pushTables as tables, pushVocabulary as vocabulary } from './fixtures/push-app'

describe('the validation of ctx.notify', () => {
	const located: string[] = []
	const written: NewNotification[] = []
	const rules: NotifyRules = {
		declared: true,
		actions: new Set(['notes.read', 'notes.write']),
		dimensions: new Set(['workspace', 'note']),
		opens: (pathname) => pathname === '/' || pathname.startsWith('/notes/'),
		locate: (dimension, key) => {
			if (dimension !== 'note') return null
			located.push(key)
			return Promise.resolve(null)
		},
	}
	const tablesStub: Notifications = {
		record: async (_session, notification) => {
			written.push(notification)
		},
		unseen: async () => [],
		countAfter: async () => 0,
	}
	let checks = 0
	const site = {
		site: "'api.notes.add'",
		tables: () => tablesStub,
		session: async (): Promise<Session> => sessionOf({ database: (await sqlite()).database }),
		check: () => {
			checks++
		},
	}
	let opened: Awaited<ReturnType<typeof pushDatabase>> | null = null
	const sqlite = async () => (opened ??= await pushDatabase('push-notify.test.ts'))

	beforeEach(() => {
		located.length = 0
		written.length = 0
		checks = 0
	})

	afterEach(async () => {
		await opened?.close()
		opened = null
	})

	const text = { title: 'A new note', body: 'Line one\nline two', path: '/notes/n1?tab=all' }
	const notify = notifier(rules, site)

	test('writes one row with the action and the object, or the application, and locates an object a table owns', async () => {
		await notify('alice', text, { action: 'notes.read', on: { note: 'n1' } })
		await notify('alice', { ...text, path: '/' }, { action: 'notes.read', on: { workspace: 'w1' } })
		await notify('bob', text, { action: 'notes.write', app: true })
		expect(written.map(({ principal, title, body, path, about }) => ({ principal, title, body, path, about }))).toEqual([
			{ principal: 'alice', ...text, about: { action: 'notes.read', dimension: 'note', value: 'n1' } },
			{ principal: 'alice', ...text, path: '/', about: { action: 'notes.read', dimension: 'workspace', value: 'w1' } },
			{ principal: 'bob', ...text, about: { action: 'notes.write', dimension: null, value: null } },
		])
		expect(located).toEqual(['n1'])
		// Each id a UUIDv7, so the inbox reads them in the order written.
		expect(written.map((row) => row.id)).toEqual([...written.map((row) => row.id)].sort())
		expect(checks).toBe(6)
	})

	test.each<[string, unknown, unknown, unknown]>([
		['an empty person', '', text, { action: 'notes.read', app: true }],
		['a person that is no text', 7, text, { action: 'notes.read', app: true }],
		['a blank title', 'alice', { ...text, title: '  ' }, { action: 'notes.read', app: true }],
		['a title past its bound', 'alice', { ...text, title: 'x'.repeat(121) }, { action: 'notes.read', app: true }],
		['a line break in the title', 'alice', { ...text, title: 'a\nb' }, { action: 'notes.read', app: true }],
		['a control character in the body', 'alice', { ...text, body: 'a\u0000b' }, { action: 'notes.read', app: true }],
		['a lone surrogate in the body', 'alice', { ...text, body: 'a\ud800b' }, { action: 'notes.read', app: true }],
		['a body past its bound', 'alice', { ...text, body: 'é'.repeat(501) }, { action: 'notes.read', app: true }],
		['a field the notification does not have', 'alice', { ...text, icon: '/x.png' }, { action: 'notes.read', app: true }],
		['a path no SPA mount serves', 'alice', { ...text, path: '/api/notes.add' }, { action: 'notes.read', app: true }],
		['a path to another origin', 'alice', { ...text, path: '//elsewhere.example/notes/' }, { action: 'notes.read', app: true }],
		['a path that is not canonical', 'alice', { ...text, path: '/notes/../admin' }, { action: 'notes.read', app: true }],
		['a path with a fragment', 'alice', { ...text, path: '/notes/n1#top' }, { action: 'notes.read', app: true }],
		['an absolute URL', 'alice', { ...text, path: 'https://elsewhere.example/notes/' }, { action: 'notes.read', app: true }],
		['an action the contract does not declare', 'alice', text, { action: 'orders.read', app: true }],
		['no action', 'alice', text, { on: { note: 'n1' } }],
		['a dimension the contract does not declare', 'alice', text, { action: 'notes.read', on: { order: 'o1' } }],
		['two objects', 'alice', text, { action: 'notes.read', on: { note: 'n1', workspace: 'w1' } }],
		['no object', 'alice', text, { action: 'notes.read', on: {} }],
		['an empty key', 'alice', text, { action: 'notes.read', on: { note: '' } }],
		['a key past its bound', 'alice', text, { action: 'notes.read', on: { note: 'n'.repeat(257) } }],
		['both an object and the application', 'alice', text, { action: 'notes.read', on: { note: 'n1' }, app: true }],
		['app that is not true', 'alice', text, { action: 'notes.read', app: 'yes' }],
		['a right-to-left override in the body', 'alice', { ...text, body: 'paid ‮01 EUR' }, { action: 'notes.read', app: true }],
		['a bidirectional isolate in the title', 'alice', { ...text, title: 'a ⁧b⁩' }, { action: 'notes.read', app: true }],
		['a right-to-left mark in the title', 'alice', { ...text, title: 'a‏b' }, { action: 'notes.read', app: true }],
	])('refuses %s, and writes nothing', async (_name, person, notification, about) => {
		const refusal = await notify(person, notification, about).then(() => null, (error: unknown) => error)
		expect(refusal).toBeInstanceOf(CapabilityRefusedError)
		expect(refusal).toMatchObject({ reason: 'refused_notification' })
		expect(written).toEqual([])
		expect(located).toEqual([])
	})

	test('keeps the format characters emoji sequences and scripts need', async () => {
		// A family (joined by U+200D), a subdivision flag (tag characters), and a word with a non-joiner (U+200C).
		const title = '\u{1f468}‍\u{1f469}‍\u{1f467} \u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f} می‌خواهم'
		await notify('alice', { ...text, title }, { action: 'notes.read', app: true })
		expect(written.map((row) => row.title)).toEqual([title])
	})

	test('a key the table cannot read is refused as ctx.notify, and any other database failure passes through', async () => {
		const failing = (error: Error) => notifier({ ...rules, locate: () => Promise.reject(error) }, site)
		const aboutNote = { action: 'notes.read', on: { note: 'x' } }
		await expect(failing(new DatabaseError('22P02'))('alice', text, aboutNote)).rejects.toMatchObject({ reason: 'refused_notification' })
		await expect(failing(new DatabaseError(null))('alice', text, aboutNote)).rejects.toBeInstanceOf(DatabaseError)
		await expect(failing(new DatabaseError('40001'))('alice', text, aboutNote)).rejects.toBeInstanceOf(DatabaseError)
		// A look-alike that only borrows the name and the state is not the data layer's, and passes through as it is.
		const lookAlike = Object.assign(new Error('a look-alike'), { name: 'DatabaseError', sqlState: '22P02' })
		await expect(failing(lookAlike)('alice', text, aboutNote)).rejects.toBe(lookAlike)
		expect(written).toEqual([])
	})

	test('a contract that declares no notifications only refuses', async () => {
		const undeclared = notifier({ ...rules, declared: false }, site)
		await expect(undeclared('alice', text, { action: 'notes.read', app: true })).rejects.toMatchObject({ reason: 'undeclared_notify' })
		expect(written).toEqual([])
	})

	test('a site whose request ended writes nothing', async () => {
		const ended = notifier(rules, {
			...site,
			check: () => {
				throw new CapabilityRefusedError('ended', 'the request ended')
			},
		})
		await expect(ended('alice', text, { action: 'notes.read', app: true })).rejects.toMatchObject({ reason: 'ended' })
		expect(written).toEqual([])
	})
})

// ── Through the kit ──────────────────────────────────────────────────────────────────────────────

const app = defineApp(vocabulary, tables)

const rooted = (path: string): path is `/${string}` => path.startsWith('/')

const Holds = z.strictObject({ notify: z.boolean() })
const InWorkspace = z.strictObject({ workspaceId: z.string().min(1) })
const Question = z.strictObject({ question: z.string().min(1) })

const notes = app.group({ callers: ['human'] }, (r) => ({
	add: r.mutation({
		input: z.strictObject({
			workspaceId: z.string().min(1),
			title: z.string().min(1),
			person: z.string().min(1),
			path: z.string(),
			noteKey: z.string().optional(),
			fail: z.boolean(),
			catchNotify: z.boolean().optional(),
		}),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
	})
		.handle(async ({ input, ctx }) => {
			const { id } = await ctx.db.target.notes.insert({ title: input.title })
			const path = rooted(input.path) ? input.path : '/'
			// A reader's action, which the writer need not hold: the note's readers.
			const notified = ctx.notify(input.person, { title: 'A new note', body: input.title, path }, {
				action: 'notes.read',
				on: { note: input.noteKey ?? id },
			})
			// A handler that treats its notification as best effort.
			await (input.catchNotify === true ? notified.catch(() => undefined) : notified)
			if (input.fail) {
				throw new Error('the handler failed after it notified')
			}
			return { id }
		}),
	everyone: r.mutation({
		input: z.strictObject({ person: z.string().min(1) }),
		output: z.strictObject({ ok: z.boolean() }),
		access: { action: 'notes.write', app: true },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.notify(input.person, { title: 'For everyone', body: 'Application-wide', path: '/' }, { action: 'notes.read', app: true })
			return { ok: true }
		}),
	connectAlerts: r.mutation({
		input: z.strictObject({ account: z.string() }),
		output: WebhookSecret,
		access: { action: 'notes.write', app: true },
		binds: 'alerts',
	}).handle(({ input, ctx }) => ctx.webhooks('alerts').bind(ctx.app, input.account)),
	// What a query's handler holds at run time: no notify, as its type says.
	peek: r.query({ output: Holds, access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' }, input: InWorkspace })
		.handle(({ ctx }) => ({ notify: 'notify' in ctx })),
}))

/** A visitor asks; staff of w1 hear of it. A public query reads and notifies no one. */
const visitors = app.group({}, (r) => ({
	ask: r.mutation({
		input: Question,
		output: Holds,
		access: { public: true },
		actions: ['notes.write'],
		admission: { rate: { perClient: null, perEndpoint: null } },
	})
		.handle(async ({ input, ctx }) => {
			await ctx.notify('alice', { title: 'A visitor asked', body: input.question, path: '/' }, { action: 'notes.read', on: { workspace: 'w1' } })
			return { notify: true }
		}),
	look: r.query({ output: Holds, access: { public: true }, actions: ['notes.read'], admission: { rate: { perClient: null, perEndpoint: null } } })
		.handle(({ ctx }) => ({ notify: 'notify' in ctx })),
}))

/** A share link's holder annotates its note; the note's readers hear of it. */
const shared = app.link('/s', {
	spa: 'dist/share',
	dimension: 'note',
	grants: ['notes.write'],
	issuedBy: 'notes.write',
	maxDays: 7,
	procedures: (l) => ({
		annotate: l.mutation({ output: Holds, access: { action: 'notes.write' } }).handle(async ({ ctx }) => {
			await ctx.notify('alice', { title: 'Annotated', body: 'A link holder annotated a note', path: '/' }, {
				action: 'notes.read',
				on: { note: ctx.target.value },
			})
			return { notify: true }
		}),
	}),
})

/** A monitoring service posts an alert; staff of w1 hear of it. */
const alerts = app.webhook('/hooks/alerts', {
	boundTo: 'app',
	actions: ['notes.write'],
	scheme: { bearer: true },
	input: z.strictObject({ text: z.string().min(1) }),
}).handle(async ({ input, ctx }) => {
	await ctx.notify('alice', { title: 'Alert', body: input.text, path: '/' }, { action: 'notes.read', on: { workspace: 'w1' } })
})

const digest = app.cron(dailyAhead(12), { actions: ['notes.read'] }).handle(async ({ ctx }) => {
	await ctx.transaction(async (tx) => {
		await tx.notify('alice', { title: 'Daily digest', body: 'Your notes of today', path: '/' }, { action: 'notes.read', on: { workspace: 'w1' } })
	})
})

const contract = app.contract((c) => ({
	web: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	identify: c.spa('/identify', { dir: 'dist/identify', access: { public: true } }),
	api: c.rpc('/api', { notes, visitors }),
	shared,
	alerts,
	health: c.health('/healthz'),
	jobs: { digest },
}))

/** Postgres keys a note by a `uuid`, so a key it cannot read fails the writer's statement there. */
const POSTGRES_TABLE = `create table notes (
	id uuid primary key,
	workspace_id text not null,
	title text not null,
	created_by text not null,
	version integer not null,
	unique (id, workspace_id)
);`

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
if (url === '') {
	console.warn(`push-notify.test.ts: set ${URL_VAR} to run the Postgres half as well`)
}

async function admin(statement: string): Promise<void> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

interface Fresh {
	readonly database: Database
	close(): Promise<void>
}

const drivers: readonly { readonly name: string; readonly enabled: boolean; readonly open: () => Promise<Fresh> }[] = [
	{ name: 'SQLite', enabled: true, open: () => pushDatabase('push-notify.test.ts') },
	{
		name: 'Postgres',
		enabled: url !== '',
		async open() {
			const schema = applicationSchema(`notify-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
			const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
			await admin(`create schema ${schema}; set search_path to ${schema}; ${framework} ${POSTGRES_TABLE}`)
			const database = openPostgres({ url, schema, max: 3 })
			return {
				database,
				async close() {
					await database.close()
					await admin(`drop schema ${schema} cascade`)
				},
			}
		},
	},
]

const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`
const record = (name: string) => ({
	op: 'record',
	subscription: { endpoint: endpoint(name), expirationTime: null, keys: { p256dh: `B${'p'.repeat(86)}`, auth: 'A'.repeat(22) } },
	key: TEST_PUSH_KEY,
})

for (const driver of drivers) {
	describe.skipIf(!driver.enabled)(`ctx.notify on ${driver.name}`, () => {
		let fresh: Fresh
		let kit: ReturnType<typeof testKit<typeof contract>>

		beforeEach(async () => {
			fresh = await driver.open()
			kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
		})

		afterEach(async () => {
			await kit.drain()
			await fresh.close()
		})

		type TestCaller = Parameters<typeof kit.browser>[0]
		const alice = () => kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }], { id: 'alice' })
		const bob = () => kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w2' } }], { id: 'bob' })
		const admin = () => kit.testCaller([{ role: 'editor' }], { id: 'admin' })

		async function post(caller: TestCaller, path: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
			const response = await kit.browser(caller)(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
			const answer = await response.text()
			return {
				status: response.status,
				body: response.headers.get('Content-Type')?.startsWith('application/json') === true ? JSON.parse(answer) : answer,
			}
		}

		const add = (
			caller: TestCaller,
			input: {
				readonly workspaceId: string
				readonly person: string
				readonly noteKey?: string
				readonly fail?: boolean
				readonly path?: string
				readonly catchNotify?: boolean
			},
		) => post(caller, '/api/notes.add', { title: 'Buy milk', path: '/notes/', fail: false, ...input })

		/** What the inbox answers `caller` for its own subscription `name`: the titles, oldest first. */
		async function inboxTitles(caller: TestCaller, name: string): Promise<readonly string[]> {
			const answer = await post(caller, '/__fabrika/push/inbox', { endpoint: endpoint(name) })
			expect(answer).toMatchObject({ status: 200, body: { mine: true } })
			const body = z.strictObject({
				mine: z.boolean(),
				more: z.number(),
				notifications: z.array(z.strictObject({ id: z.string(), title: z.string(), body: z.string(), path: z.string() })),
			})
				.parse(answer.body)
			return body.notifications.map((row) => `${row.title}: ${row.body} (${row.path})`)
		}

		async function rows(): Promise<readonly unknown[]> {
			return await runFixedStatement(sessionOf({ database: fresh.database }), 'select principal, title from fabrika_notifications order by id', [])
		}

		test("a mutation notifies about the note it wrote, and only the note's readers read it", async () => {
			await post(alice(), '/__fabrika/push/subscription', record('alice'))
			await post(bob(), '/__fabrika/push/subscription', record('bob'))
			// Alice writes in her workspace and notifies herself and Bob; Bob does not read notes in w1.
			expect(await add(alice(), { workspaceId: 'w1', person: 'alice' })).toMatchObject({ status: 200 })
			expect(await add(alice(), { workspaceId: 'w1', person: 'bob' })).toMatchObject({ status: 200 })
			expect(await inboxTitles(alice(), 'alice')).toEqual(['A new note: Buy milk (/notes/)'])
			expect(await inboxTitles(bob(), 'bob')).toEqual([])
			expect(await rows()).toEqual([{ principal: 'alice', title: 'A new note' }, { principal: 'bob', title: 'A new note' }])
		})

		test('a handler that fails after it notified writes no notification, nor its note', async () => {
			expect(await add(alice(), { workspaceId: 'w1', person: 'alice', fail: true })).toMatchObject({ status: 500 })
			expect(await rows()).toEqual([])
		})

		test('a refused notification fails the handler, and nothing it wrote is kept', async () => {
			expect(await add(alice(), { workspaceId: 'w1', person: 'alice', path: '/api/notes.add' })).toMatchObject({ status: 500 })
			expect(await rows()).toEqual([])
			expect(await runFixedStatement(sessionOf({ database: fresh.database }), 'select id from notes', [])).toEqual([])
		})

		test(
			driver.name === 'Postgres'
				? 'a key the owning table cannot read fails the writer, never the inbox'
				: 'a key no note has is written, and the inbox shows nothing about it',
			async () => {
				await post(alice(), '/__fabrika/push/subscription', record('alice'))
				const answer = await add(alice(), { workspaceId: 'w1', person: 'alice', noteKey: 'not-a-note' })
				expect(answer.status).toBe(driver.name === 'Postgres' ? 500 : 200)
				expect((await rows()).length).toBe(driver.name === 'Postgres' ? 0 : 1)
				// Either way the inbox reads on, and a later notification reaches her.
				expect(await inboxTitles(alice(), 'alice')).toEqual([])
				await add(alice(), { workspaceId: 'w1', person: 'alice' })
				expect(await inboxTitles(alice(), 'alice')).toEqual(['A new note: Buy milk (/notes/)'])
			},
		)

		test('an application-wide notification reaches only a holder of the action as a global grant', async () => {
			await post(alice(), '/__fabrika/push/subscription', record('alice'))
			await post(admin(), '/__fabrika/push/subscription', record('admin'))
			expect(await post(admin(), '/api/notes.everyone', { person: 'alice' })).toMatchObject({ status: 200 })
			expect(await post(admin(), '/api/notes.everyone', { person: 'admin' })).toMatchObject({ status: 200 })
			expect(await inboxTitles(alice(), 'alice')).toEqual([])
			expect(await inboxTitles(admin(), 'admin')).toEqual(['For everyone: Application-wide (/)'])
		})

		test('a job notifies inside its transaction, fenced by its lease', async () => {
			await post(alice(), '/__fabrika/push/subscription', record('alice'))
			expect(await kit.runJob('digest')).toMatchObject({ status: 'succeeded' })
			expect(await inboxTitles(alice(), 'alice')).toEqual(['Daily digest: Your notes of today (/)'])
		})

		test('a webhook delivery notifies in its transaction', async () => {
			await post(alice(), '/__fabrika/push/subscription', record('alice'))
			const connected = await post(admin(), '/api/notes.connectAlerts', { account: 'monitoring' })
			const { url: hook, secret } = z.strictObject({ result: z.strictObject({ id: z.string(), url: z.string(), secret: z.string() }) })
				.parse(connected.body).result
			const delivered = await kit.fetch(hook, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
				body: JSON.stringify({ text: 'Disk almost full' }),
			})
			expect(delivered.status).toBe(200)
			expect(await inboxTitles(alice(), 'alice')).toEqual(['Alert: Disk almost full (/)'])
		})

		test("a share link's holder notifies about the link's note, which its readers then read", async () => {
			await post(alice(), '/__fabrika/push/subscription', record('alice'))
			await post(bob(), '/__fabrika/push/subscription', record('bob'))
			const added = await add(alice(), { workspaceId: 'w1', person: 'nobody' })
			const { id } = z.strictObject({ result: z.strictObject({ id: z.string() }) }).parse(added.body).result
			const note = { type: 'note', value: id } as const
			const holder = kit.testCaller([{ action: 'notes.write', scope: note }], {
				kind: 'link',
				link: { mount: 'shared', chain: [note, { type: 'workspace', value: 'w1' }] },
			})
			const annotated = await kit.fetch('/s/api/annotate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${holder.key}` },
				body: '{}',
			})
			expect(annotated.status).toBe(200)
			expect(await inboxTitles(alice(), 'alice')).toEqual(['Annotated: A link holder annotated a note (/)'])
			expect(await inboxTitles(bob(), 'bob')).toEqual([])
		})

		test('a public mutation notifies as its own workload; a public query and a group query hold no notify', async () => {
			await post(alice(), '/__fabrika/push/subscription', record('alice'))
			const anyone = (path: string, body: unknown) =>
				kit.fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
			expect((await anyone('/api/visitors.ask', { question: 'Are you open on Sunday?' })).status).toBe(200)
			expect(await inboxTitles(alice(), 'alice')).toEqual(['A visitor asked: Are you open on Sunday? (/)'])
			expect(await (await anyone('/api/visitors.look', {})).json()).toEqual({ result: { notify: false } })
			expect(await post(alice(), '/api/notes.peek', { workspaceId: 'w1' })).toEqual({ status: 200, body: { result: { notify: false } } })
		})

		test("a path of the public SPA mount opens; one of the link mount, whose page needs the link's key, does not", async () => {
			expect(await add(alice(), { workspaceId: 'w1', person: 'alice', path: '/identify' })).toMatchObject({ status: 200 })
			expect(await add(alice(), { workspaceId: 'w1', person: 'alice', path: '/identify/welcome' })).toMatchObject({ status: 200 })
			expect(await add(alice(), { workspaceId: 'w1', person: 'alice', path: '/s/' })).toMatchObject({ status: 500 })
			expect(await rows()).toEqual([{ principal: 'alice', title: 'A new note' }, { principal: 'alice', title: 'A new note' }])
		})

		test(
			driver.name === 'Postgres'
				? 'a handler that catches the refusal of a key its table cannot read still fails, and keeps nothing'
				: 'a handler that catches nothing has nothing to catch for a key no note has',
			async () => {
				const answer = await add(alice(), { workspaceId: 'w1', person: 'alice', noteKey: 'not-a-note', catchNotify: true })
				expect(answer.status).toBe(driver.name === 'Postgres' ? 500 : 200)
				expect((await rows()).length).toBe(driver.name === 'Postgres' ? 0 : 1)
			},
		)
	})
}
