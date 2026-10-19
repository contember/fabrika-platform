// A webhook bound to the whole application (`boundTo: 'app'`) and the procedure that binds it (`binds`): the procedure
// creates and removes bindings through `ctx.webhooks('<name>')` with its `ctx.app`, in its own transaction, and a
// delivery runs as the webhook's workload with `ctx.app('<action>')` and `ctx.db.app('<action>')`. Through the test kit
// and a REAL Postgres, over the app-wide fixture; skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { createClient } from '@fabrika/app/client'
import {
	type App,
	compileContract,
	ContractError,
	type Declared,
	type KitTypes,
	type Unavailable,
	type WebhookKitContext,
	WebhookSecret,
} from '@fabrika/app/contract'
import { type AppCapability, serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { admin } from './app-wide-fixture/src/admin/endpoints'
import { app } from './app-wide-fixture/src/app-kit'
import { tables } from './app-wide-fixture/src/db/tables'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type Hook = WebhookKitContext<Kit, 'app', 'positions.manage', Declared<never, never, never, never>>

/** A webhook bound to `'app'` mints application-wide capabilities of its declared actions, and has no bound value. */
export type AppWebhookContext = [
	Expect<Equal<ReturnType<Hook['app']>, AppCapability<'positions.manage'>>>,
	Expect<Equal<Parameters<Hook['db']['app']>[0], 'positions.manage'>>,
	Expect<Hook['refs'] extends Unavailable<string> ? true : false>,
	Expect<Hook['files'] extends Unavailable<string> ? true : false>,
]

const fixtureRoot = join(import.meta.dir, 'app-wide-fixture')
const postgres = await testDatabase({ migrations: join(fixtureRoot, 'db', 'migrations'), label: 'webhook-app.test.ts' })

afterAll(async () => {
	await postgres?.close()
})

const Event = z.strictObject({ id: z.string(), type: z.string() })
const Account = z.strictObject({ account: z.string() })
const seen: { action?: string; bound?: string; candidate?: string } = {}

const stripe = app.webhook('/hooks/stripe', { scheme: 'stripe', boundTo: 'app', actions: ['positions.manage'], input: Event })
	.handle(async ({ input, ctx }) => {
		seen.action = ctx.app('positions.manage').action
		await ctx.db.app('positions.manage').positions.insert({ title: `${input.type} ${input.id}` })
	})

/** A provider that signs its body in a header of its own, per candidate: its handler acts on the bound value. */
const signedBody = { header: 'X-Screening-Signature', algorithm: 'sha256', encoding: 'hex', signed: 'body' } as const
const screening = app.webhook('/hooks/screening', {
	scheme: { hmac: signedBody },
	boundTo: 'candidate',
	actions: ['candidates.review'],
	input: Event,
})
	.handle(({ ctx }) => {
		seen.candidate = ctx.refs['candidates.review'].value
	})

const candidates = app.group({ callers: ['human'] }, (r) => ({
	connect: r.mutation({
		input: z.strictObject({ id: z.uuid(), account: z.string() }),
		output: WebhookSecret,
		access: { action: 'candidates.review', on: 'candidate', from: 'id' },
		binds: 'screening',
	}).handle(({ input, ctx }) => ctx.webhooks('screening').bind(ctx.target, input.account)),
	misbound: r.mutation({ input: Account, output: WebhookSecret, access: { action: 'positions.manage', app: true }, binds: 'screening' })
		.handle(({ input, ctx }) => Reflect.apply(ctx.webhooks('screening').bind, undefined, [ctx.app, input.account])),
}))

const billing = app.group({ callers: ['human'] }, (r) => ({
	connect: r.mutation({ input: Account, output: WebhookSecret, access: { action: 'positions.manage', app: true }, binds: 'stripe' })
		.handle(({ input, ctx }) => ctx.webhooks('stripe').bind(ctx.app, input.account)),
	disconnect: r.mutation({
		input: z.strictObject({ id: z.uuid() }),
		output: z.strictObject({ removed: z.boolean() }),
		access: { action: 'positions.manage', app: true },
		binds: 'stripe',
	}).handle(async ({ input, ctx }) => ({ removed: await ctx.webhooks('stripe').unbind(ctx.app, input.id) })),
	abandoned: r.mutation({ input: Account, output: WebhookSecret, access: { action: 'positions.manage', app: true }, binds: 'stripe' })
		.handle(async ({ input, ctx }) => {
			seen.bound = (await ctx.webhooks('stripe').bind(ctx.app, input.account)).url
			throw new Error('the binding is rolled back with the rest of the mutation')
		}),
	elsewhere: r.mutation({ input: Account, output: WebhookSecret, access: { action: 'positions.manage', app: true }, binds: 'stripe' })
		.handle(({ input, ctx }) => Reflect.apply(ctx.webhooks, ctx, ['github']).bind(ctx.app, input.account)),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { admin, billing, candidates }), stripe, screening }))

describe('binds in the artifact', () => {
	const refusals = (build: () => unknown): readonly string[] => {
		try {
			build()
		} catch (error) {
			if (error instanceof ContractError) return error.problems
			throw error
		}
		return []
	}
	/** `options` with `key` set, as a cast or a hand-written declaration would set what the kit's types refuse. */
	const withField = <const T extends object>(options: T, key: string, value: unknown): T => {
		Object.defineProperty(options, key, { value, enumerable: true })
		return options
	}

	test('the binding procedure carries binds, and the webhook its verifier and binding', () => {
		const artifact = compileContract(contract, tables)
		expect(artifact.declared?.['api.billing.connect']).toEqual({ sql: null, unscoped: {}, connect: [], issues: null, binds: 'stripe' })
		expect(artifact.mounts['stripe']).toEqual({
			kind: 'webhook',
			path: '/hooks/stripe',
			scheme: 'stripe',
			boundTo: { kind: 'app' },
			actions: ['positions.manage'],
		})
		// Only a GitHub webhook bound to a dimension keeps its generated binding endpoints.
		expect(artifact.endpoints.map((row) => row.id).filter((id) => id.startsWith('webhooks.'))).toEqual([])
	})

	test('binds on a query, on a public procedure and on a job, and binds that names no webhook', () => {
		const access = { action: 'positions.manage', app: true } as const
		const misplaced = app.contract((c) => ({
			api: c.rpc('/api', {
				wrong: app.group({ callers: ['human'] }, (r) => ({
					read: r.query(withField({ output: Account, access }, 'binds', 'stripe')).handle(() => ({ account: 'a' })),
					typo: r.mutation({ input: Account, output: WebhookSecret, access, binds: 'strpe' })
						.handle(({ input, ctx }) => ctx.webhooks('strpe').bind(ctx.app, input.account)),
					anyone: r.mutation(
						withField({ input: Account, output: Account, access: { public: true }, actions: ['positions.manage'] }, 'binds', 'stripe'),
					).handle(({ input }) => input),
				})),
			}),
			stripe,
			jobs: {
				nightly: app.cron('0 3 * * *', withField({ actions: ['positions.manage'], scope: 'app' }, 'binds', 'stripe')).handle(async () => {}),
			},
		}))
		expect(refusals(() => compileContract(misplaced, tables))).toEqual([
			"procedure 'api.wrong.read': declares binds, which only a credentialed mutation of an RPC mount declares",
			"procedure 'api.wrong.typo': binds \"strpe\" is not a webhook of the contract (webhooks: stripe) — did you mean 'stripe'?",
			"procedure 'api.wrong.anyone': is public and declares binds: a public procedure reaches its actions only (allowed: kicks)",
			"job 'nightly': declares binds, which only a credentialed mutation of an RPC mount declares",
		])
	})
})

if (postgres !== null) {
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
	const manager = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'positions.manage' }])) })

	const deliver = (url: string, secret: string, event: z.output<typeof Event>) => {
		const body = JSON.stringify(event)
		const t = String(Math.floor(Date.now() / 1000))
		const signature = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
		return kit.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${signature}` }, body })
	}

	const reader = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'positions.read' }])) })
	const titled = async (title: string) => (await reader.admin.positions()).items.filter((item) => item.title === title).length

	describe('a webhook bound to the application', () => {
		test('a holder of the action binds it; a signed delivery runs with ctx.app and ctx.db.app, and its replay is ignored', async () => {
			const binding = await manager.billing.connect({ account: 'acct_1' })
			expect(binding.url).toBe(`/hooks/stripe/${binding.id}`)
			expect(binding.secret).toMatch(/^[0-9a-f]{64}$/)
			const event = { id: `evt_${crypto.randomUUID()}`, type: 'invoice.paid' }
			expect((await deliver(binding.url, binding.secret, event)).status).toBe(200)
			expect(seen.action).toBe('positions.manage')
			expect(await titled(`invoice.paid ${event.id}`)).toBe(1)
			expect((await deliver(binding.url, binding.secret, event)).status).toBe(200)
			expect(await titled(`invoice.paid ${event.id}`)).toBe(1)
		})

		test('a delivery signed with another secret is refused, and an unbound binding answers 404', async () => {
			const binding = await manager.billing.connect({ account: 'acct_2' })
			const event = { id: `evt_${crypto.randomUUID()}`, type: 'invoice.paid' }
			expect((await deliver(binding.url, 'a'.repeat(64), event)).status).toBe(401)
			expect(await manager.billing.disconnect({ id: binding.id })).toEqual({ removed: true })
			expect(await manager.billing.disconnect({ id: binding.id })).toEqual({ removed: false })
			expect((await deliver(binding.url, binding.secret, event)).status).toBe(404)
			expect(await titled(`invoice.paid ${event.id}`)).toBe(0)
		})

		test('a binding is written in the mutation’s transaction: a mutation that throws leaves none', async () => {
			const log = spyOn(console, 'error').mockImplementation(() => {})
			try {
				await expect(manager.billing.abandoned({ account: 'acct_3' })).rejects.toThrow()
			} finally {
				log.mockRestore()
			}
			const url = seen.bound ?? ''
			expect(url).toStartWith('/hooks/stripe/')
			expect((await deliver(url, 'b'.repeat(64), { id: 'evt_gone', type: 'invoice.paid' })).status).toBe(404)
		})

		test('ctx.webhooks names only the declared webhook', async () => {
			const log = spyOn(console, 'error').mockImplementation(() => {})
			try {
				await expect(manager.billing.elsewhere({ account: 'acct_4' })).rejects.toThrow()
				expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('undeclared_binding')
			} finally {
				log.mockRestore()
			}
		})

		test('a webhook bound to a dimension binds with a Ref of that dimension, and its delivery acts on the bound value', async () => {
			const worlds = await postgres.seedWorlds(tables, 'candidates')
			const reviewer = createClient(contract, 'api', {
				fetch: kit.browser(kit.testCaller([{ action: 'candidates.review', scope: kit.scope('candidate', worlds.own.key) }])),
			})
			const binding = await reviewer.candidates.connect({ id: worlds.own.key, account: 'screening-co' })
			const send = (secret: string) => {
				const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type: 'screened' })
				const signature = createHmac('sha256', secret).update(body).digest('hex')
				return kit.fetch(binding.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Screening-Signature': signature }, body })
			}
			expect((await send('c'.repeat(64))).status).toBe(401)
			expect((await send(binding.secret)).status).toBe(200)
			expect(seen.candidate).toBe(worlds.own.key)
			const log = spyOn(console, 'error').mockImplementation(() => {})
			try {
				await expect(manager.candidates.misbound({ account: 'screening-co' })).rejects.toThrow()
				expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain('wrong_binding')
			} finally {
				log.mockRestore()
			}
		})

		test('a caller without the action binds nothing', async () => {
			await expect(reader.billing.connect({ account: 'acct_5' })).rejects.toThrow()
		})
	})
} else {
	test.skip('a webhook bound to the application (set FABRIKA_TEST_POSTGRES_URL)', () => {})
}
