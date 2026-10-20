import type { AuthContext } from '@fabrika/auth'
import { encodePlatformMailRequest } from '@fabrika/email/platform'
import { uuidv7 } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { ControlRepositories, MailMessageState } from '../db'
import type { MailDispatchMessage } from '../mail-relay/queue'
import type { ControlRpcDeps } from '../services'
import { createHarness } from './helpers/harness'
import { allowAllAuth, authWithActions, authWithPermissions } from './helpers/iam'
import { fakeControlProvider } from './helpers/provider'
import { rpcRequest, rpcResult } from './helpers/rpc'

// The console's mail procedures over the real RPC parser and ACL, on the production schema: who reads which messages,
// who sees their content, and that release and drop decide a held message only.

const listSchema = z.object({
	items: z.array(z.object({ id: z.string(), sender: z.string(), state: z.string() }).passthrough()),
	nextCursor: z.string().nullable(),
})
const messageSchema = z.object({ id: z.string(), state: z.string(), decidedBy: z.string().nullable() }).passthrough()
const contentSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('withheld') }),
	z.object({ kind: z.literal('purged') }),
	z.object({
		kind: z.literal('present'),
		message: z.object({
			to: z.string(),
			subject: z.string(),
			text: z.string(),
			html: z.string().optional(),
			attachments: z.array(z.object({ filename: z.string(), contentType: z.string(), bytes: z.number() })),
		}).passthrough(),
	}),
])
const detailSchema = messageSchema.extend({ content: contentSchema })
const ruleSchema = z.object({ id: z.string(), scope: z.string(), domain: z.string(), action: z.string() }).passthrough()

interface Fixture {
	repositories: ControlRepositories
	dispatched: MailDispatchMessage[]
	call(auth: AuthContext, method: string, input?: unknown): Promise<Response>
	seed(sender: string, state: MailMessageState): Promise<string>
}

function fixture(options: { relay?: boolean } = {}): Fixture {
	const repositories = createHarness().db
	const dispatched: MailDispatchMessage[] = []
	return {
		repositories,
		dispatched,
		call(auth, method, input = null) {
			const deps: ControlRpcDeps = {
				repositories,
				auth,
				queue: { send: () => Promise.resolve() },
				logs: { get: () => Promise.resolve(null) },
				provider: fakeControlProvider,
				cancelRun: () => Promise.resolve(),
				...(options.relay === false ? {} : {
					mailQueue: {
						send(message) {
							dispatched.push(message)
							return Promise.resolve()
						},
					},
				}),
			}
			return rpcResult(rpcRequest(method, input), deps)
		},
		async seed(sender, state) {
			const id = uuidv7()
			const content = encodePlatformMailRequest({
				to: 'ada@example.com',
				subject: 'Your invoice',
				text: 'Hello',
				html: '<p>Hello</p>',
				idempotencyKey: id,
				attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: new Uint8Array(12) }],
			})
			await repositories.mailMessages.insertOrFind({
				id,
				sender,
				idempotency_key: id,
				fingerprint: 'f',
				recipient_domain: 'example.com',
				state,
				rule_id: null,
				content,
			}, 1_000)
			return id
		},
	}
}

const reader = (scope: { type: 'app' | 'environment'; value: string } | null) =>
	authWithPermissions([{ action: 'mail.read', scope }], scope === null ? 'reader@test' : `reader-${scope.value}@test`)

async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
	expect(response.status).toBe(200)
	return schema.parse(await response.json())
}

describe('mail.messages.list', () => {
	test('the whole list needs a global mail.read', async () => {
		const f = fixture()
		const app = await f.seed('notes@prod', 'held')
		const installation = await f.seed('installation:iam', 'queued')
		const listed = await json(await f.call(reader(null), 'mail.messages.list', {}), listSchema)
		expect(listed.items.map((item) => item.id).sort()).toEqual([app, installation].sort())
		expect((await f.call(reader({ type: 'app', value: 'notes' }), 'mail.messages.list', {})).status).toBe(403)
		expect((await f.call(authWithActions([]), 'mail.messages.list', {})).status).toBe(403)
	})

	test("one application's messages are read at its app or its environment", async () => {
		const f = fixture()
		const notes = await f.seed('notes@prod', 'held')
		await f.seed('blog@prod', 'held')
		for (const auth of [reader({ type: 'app', value: 'notes' }), reader({ type: 'environment', value: 'prod' })]) {
			const listed = await json(await f.call(auth, 'mail.messages.list', { scope: 'notes@prod' }), listSchema)
			expect(listed.items.map((item) => item.id)).toEqual([notes])
		}
		expect((await f.call(reader({ type: 'app', value: 'notes' }), 'mail.messages.list', { scope: 'blog@prod' })).status).toBe(403)
	})

	test("an installation service's messages need a global mail.read", async () => {
		const f = fixture()
		await f.seed('installation:iam', 'queued')
		expect((await f.call(reader({ type: 'environment', value: 'prod' }), 'mail.messages.list', { scope: 'installation:iam' })).status).toBe(403)
		const listed = await json(await f.call(reader(null), 'mail.messages.list', { scope: 'installation:iam' }), listSchema)
		expect(listed.items).toHaveLength(1)
	})

	test('filters by state', async () => {
		const f = fixture()
		const held = await f.seed('notes@prod', 'held')
		await f.seed('notes@prod', 'sent')
		const listed = await json(await f.call(reader(null), 'mail.messages.list', { state: 'held' }), listSchema)
		expect(listed.items.map((item) => item.id)).toEqual([held])
		expect((await f.call(reader(null), 'mail.messages.list', { state: 'released' })).status).toBe(400)
	})
})

describe('mail.messages.get', () => {
	test('a message the caller does not read is not found', async () => {
		const f = fixture()
		const id = await f.seed('notes@prod', 'held')
		const installation = await f.seed('installation:iam', 'queued')
		expect((await f.call(reader({ type: 'app', value: 'blog' }), 'mail.messages.get', { id })).status).toBe(404)
		expect((await f.call(reader({ type: 'app', value: 'notes' }), 'mail.messages.get', { id: installation })).status).toBe(404)
		expect((await f.call(reader(null), 'mail.messages.get', { id: uuidv7() })).status).toBe(404)
	})

	test('the content is withheld without mail.content.read', async () => {
		const f = fixture()
		const id = await f.seed('notes@prod', 'held')
		const detail = await json(await f.call(reader({ type: 'app', value: 'notes' }), 'mail.messages.get', { id }), detailSchema)
		expect(detail.content).toEqual({ kind: 'withheld' })
	})

	test('a content reader sees the message and its attachments as name, type and size', async () => {
		const f = fixture()
		const id = await f.seed('notes@prod', 'held')
		const auth = authWithActions(['mail.read', 'mail.content.read'])
		const detail = await json(await f.call(auth, 'mail.messages.get', { id }), detailSchema)
		expect(detail.content).toEqual({
			kind: 'present',
			message: {
				to: 'ada@example.com',
				subject: 'Your invoice',
				text: 'Hello',
				html: '<p>Hello</p>',
				attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', bytes: 12 }],
			},
		})
	})

	test('purged content reads as purged', async () => {
		const f = fixture()
		const id = await f.seed('notes@prod', 'sent')
		expect(await f.repositories.mailMessages.purgeContent(id)).toBe(true)
		const detail = await json(await f.call(allowAllAuth(), 'mail.messages.get', { id }), detailSchema)
		expect(detail.content).toEqual({ kind: 'purged' })
	})
})

describe('release and drop', () => {
	test('need a global mail.manage', async () => {
		const f = fixture()
		const id = await f.seed('notes@prod', 'held')
		const scoped = authWithPermissions([{ action: 'mail.manage', scope: { type: 'app', value: 'notes' } }])
		for (const method of ['mail.messages.release', 'mail.messages.drop']) {
			expect((await f.call(reader(null), method, { id })).status).toBe(403)
			expect((await f.call(scoped, method, { id })).status).toBe(403)
		}
		expect((await f.repositories.mailMessages.get(id))?.state).toBe('held')
	})

	test('release queues a held message, records who, and enqueues its dispatch', async () => {
		const f = fixture()
		const id = await f.seed('notes@prod', 'held')
		const released = await json(await f.call(authWithActions(['mail.manage'], 'ops@test'), 'mail.messages.release', { id }), messageSchema)
		expect(released.state).toBe('queued')
		expect(released.decidedBy).toBe('user:p-ops@test')
		expect(f.dispatched).toEqual([{ messageId: id }])
	})

	test('drop ends a held message, records who, and enqueues nothing', async () => {
		const f = fixture()
		const id = await f.seed('notes@prod', 'held')
		const dropped = await json(await f.call(authWithActions(['mail.manage'], 'ops@test'), 'mail.messages.drop', { id }), messageSchema)
		expect(dropped.state).toBe('dropped')
		expect(dropped.decidedBy).toBe('user:p-ops@test')
		expect(f.dispatched).toEqual([])
	})

	test('a message that is not held is a conflict, and an unknown one is not found', async () => {
		const f = fixture()
		const manager = authWithActions(['mail.manage'])
		for (const state of ['queued', 'sent', 'dropped'] as const) {
			const id = await f.seed('notes@prod', state)
			expect((await f.call(manager, 'mail.messages.release', { id })).status).toBe(409)
			expect((await f.call(manager, 'mail.messages.drop', { id })).status).toBe(409)
			expect((await f.repositories.mailMessages.get(id))?.state).toBe(state)
		}
		expect((await f.call(manager, 'mail.messages.release', { id: uuidv7() })).status).toBe(404)
		expect((await f.call(manager, 'mail.messages.drop', { id: uuidv7() })).status).toBe(404)
		expect(f.dispatched).toEqual([])
	})

	test('release answers 503 where no dispatcher runs, and leaves the message held', async () => {
		const f = fixture({ relay: false })
		const id = await f.seed('notes@prod', 'held')
		expect((await f.call(authWithActions(['mail.manage']), 'mail.messages.release', { id })).status).toBe(503)
		expect((await f.repositories.mailMessages.get(id))?.state).toBe('held')
	})
})

describe('mail.rules', () => {
	async function withApp(f: Fixture): Promise<void> {
		await f.repositories.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		await f.repositories.registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			namespaceId: null,
			provider: fakeControlProvider.id,
			providerTargetJson: '{}',
			providerArtifactJson: '{}',
		})
	}

	test('every procedure needs a global mail.manage', async () => {
		const f = fixture()
		const auth = authWithActions(['mail.read', 'mail.content.read'])
		expect((await f.call(auth, 'mail.rules.list')).status).toBe(403)
		expect((await f.call(auth, 'mail.rules.set', { scope: '*', domain: '*', action: 'hold' })).status).toBe(403)
		expect((await f.call(auth, 'mail.rules.remove', { id: uuidv7() })).status).toBe(403)
	})

	test('set creates a rule and sets the action of an existing one; remove deletes it', async () => {
		const f = fixture()
		await withApp(f)
		const manager = authWithActions(['mail.manage'])
		const created = await json(await f.call(manager, 'mail.rules.set', { scope: 'notes@prod', domain: 'example.com', action: 'hold' }), ruleSchema)
		const updated = await json(await f.call(manager, 'mail.rules.set', { scope: 'notes@prod', domain: 'example.com', action: 'drop' }), ruleSchema)
		expect(updated).toMatchObject({ id: created.id, action: 'drop' })
		await json(await f.call(manager, 'mail.rules.set', { scope: '*', domain: '*', action: 'pass' }), ruleSchema)
		const listed = await json(await f.call(manager, 'mail.rules.list'), z.object({ items: z.array(ruleSchema) }))
		expect(listed.items.map((rule) => [rule.scope, rule.domain, rule.action])).toEqual([['*', '*', 'pass'], ['notes@prod', 'example.com', 'drop']])
		expect((await f.call(manager, 'mail.rules.remove', { id: created.id })).status).toBe(200)
		expect((await f.call(manager, 'mail.rules.remove', { id: created.id })).status).toBe(404)
	})

	test('refuses a malformed scope or domain, an unknown application environment, and an unknown action', async () => {
		const f = fixture()
		await withApp(f)
		const manager = authWithActions(['mail.manage'])
		const refused = [
			{ scope: 'notes', domain: '*', action: 'hold' },
			{ scope: 'installation:iam', domain: '*', action: 'hold' },
			{ scope: '*', domain: 'Example.com', action: 'hold' },
			{ scope: '*', domain: '*.example.com', action: 'hold' },
			{ scope: '*', domain: '', action: 'hold' },
			{ scope: '*', domain: '*', action: 'release' },
		]
		for (const input of refused) expect((await f.call(manager, 'mail.rules.set', input)).status).toBe(400)
		expect((await f.call(manager, 'mail.rules.set', { scope: 'notes@stage', domain: '*', action: 'hold' })).status).toBe(400)
		expect(await f.repositories.mailRules.list()).toEqual([])
	})
})
