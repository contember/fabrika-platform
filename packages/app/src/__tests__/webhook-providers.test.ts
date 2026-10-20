// Every verifier end to end through the test kit's proxy and a REAL Postgres: a delivery signed or authenticated with
// the binding's secret runs once, a replay of it is answered and ignored, a stale or foreign signature is refused. A
// provider that issues its own secret (Stripe, Slack, Twilio) gets it set on the binding after its URL exists, and a
// `bearer` or `basic` webhook receives the sender's own `Authorization`, unless it carries a platform key. Skips
// cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { createClient } from '@fabrika/app/client'
import { WebhookSecret } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { admin } from './app-wide-fixture/src/admin/endpoints'
import { app } from './app-wide-fixture/src/app-kit'
import { tables } from './app-wide-fixture/src/db/tables'

const fixtureRoot = join(import.meta.dir, 'app-wide-fixture')
const postgres = await testDatabase({ migrations: join(fixtureRoot, 'db', 'migrations'), label: 'webhook-providers.test.ts' })

afterAll(async () => {
	await postgres?.close()
})

const hooked = { boundTo: 'app', actions: ['positions.manage'] } as const
const Event = z.strictObject({ id: z.string() })

const payments = app.webhook('/hooks/payments', { ...hooked, scheme: 'stripe', input: Event })
	.handle(({ input, ctx }) => ctx.db.app('positions.manage').positions.insert({ title: `payments ${input.id}` }).then(() => undefined))
const slack = app.webhook('/hooks/slack', {
	...hooked,
	scheme: 'slack',
	input: z.strictObject({ event_id: z.optional(z.string()), command: z.optional(z.string()), text: z.optional(z.string()) }),
}).handle(async ({ input, ctx }) => {
	await ctx.db.app('positions.manage').positions.insert({ title: `slack ${input.event_id ?? input.command} ${input.text ?? ''}`.trim() })
})
const sms = app.webhook('/hooks/sms', { ...hooked, scheme: 'twilio', input: z.strictObject({ MessageSid: z.string(), Body: z.string() }) })
	.handle(({ input, ctx }) =>
		ctx.db.app('positions.manage').positions.insert({ title: `sms ${input.MessageSid} ${input.Body}` }).then(() => undefined)
	)
const alerts = app.webhook('/hooks/alerts', { ...hooked, scheme: { bearer: true }, input: Event })
	.handle(({ input, ctx }) => ctx.db.app('positions.manage').positions.insert({ title: `alerts ${input.id}` }).then(() => undefined))
const legacy = app.webhook('/hooks/legacy', { ...hooked, scheme: { basic: true }, input: Event })
	.handle(({ input, ctx }) => ctx.db.app('positions.manage').positions.insert({ title: `legacy ${input.id}` }).then(() => undefined))

const Account = z.strictObject({ account: z.string() })
const Issued = z.strictObject({ id: z.uuid(), secret: z.string() })
const Replaced = z.strictObject({ set: z.boolean() })
const access = { action: 'positions.manage', app: true } as const

const providers = app.group({ callers: ['human'] }, (r) => ({
	connectPayments: r.mutation({ input: Account, output: WebhookSecret, access, binds: 'payments' })
		.handle(({ input, ctx }) => ctx.webhooks('payments').bind(ctx.app, input.account)),
	issuePayments: r.mutation({ input: Issued, output: Replaced, access, binds: 'payments' })
		.handle(async ({ input, ctx }) => ({ set: await ctx.webhooks('payments').setSecret(ctx.app, input.id, input.secret) })),
	connectSlack: r.mutation({ input: Account, output: WebhookSecret, access, binds: 'slack' })
		.handle(({ input, ctx }) => ctx.webhooks('slack').bind(ctx.app, input.account)),
	issueSlack: r.mutation({ input: Issued, output: Replaced, access, binds: 'slack' })
		.handle(async ({ input, ctx }) => ({ set: await ctx.webhooks('slack').setSecret(ctx.app, input.id, input.secret) })),
	connectSms: r.mutation({ input: Account, output: WebhookSecret, access, binds: 'sms' })
		.handle(({ input, ctx }) => ctx.webhooks('sms').bind(ctx.app, input.account)),
	issueSms: r.mutation({ input: Issued, output: Replaced, access, binds: 'sms' })
		.handle(async ({ input, ctx }) => ({ set: await ctx.webhooks('sms').setSecret(ctx.app, input.id, input.secret) })),
	connectAlerts: r.mutation({ input: Account, output: WebhookSecret, access, binds: 'alerts' })
		.handle(({ input, ctx }) => ctx.webhooks('alerts').bind(ctx.app, input.account)),
	issueAlerts: r.mutation({ input: Issued, output: Replaced, access, binds: 'alerts' })
		.handle(async ({ input, ctx }) => ({ set: await ctx.webhooks('alerts').setSecret(ctx.app, input.id, input.secret) })),
	connectLegacy: r.mutation({ input: Account, output: WebhookSecret, access, binds: 'legacy' })
		.handle(({ input, ctx }) => ctx.webhooks('legacy').bind(ctx.app, input.account)),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { admin, providers }), payments, slack, sms, alerts, legacy }))

if (postgres !== null) {
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
	const manager = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'positions.manage' }])) })
	const reader = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'positions.read' }])) })
	const titled = async (title: string) => (await reader.admin.positions()).items.filter((item) => item.title === title).length
	const seconds = (offsetMs = 0) => String(Math.floor((Date.now() + offsetMs) / 1000))
	const hmac = (algorithm: string, secret: string, content: string, encoding: 'hex' | 'base64') =>
		createHmac(algorithm, secret).update(content).digest(encoding)
	const post = (url: string, headers: Record<string, string>, body: string) => kit.fetch(url, { method: 'POST', headers, body })
	const json = { 'Content-Type': 'application/json' }
	const form = { 'Content-Type': 'application/x-www-form-urlencoded' }

	describe('a secret the provider issues', () => {
		const stripe = (url: string, secret: string, body: string) => {
			const t = seconds()
			return post(url, { ...json, 'Stripe-Signature': `t=${t},v1=${hmac('sha256', secret, `${t}.${body}`, 'hex')}` }, body)
		}

		test('is set on the binding after its URL exists; until then a delivery signed with it is refused', async () => {
			const binding = await manager.providers.connectPayments({ account: 'acct_issued' })
			const body = JSON.stringify({ id: `evt_${crypto.randomUUID()}` })
			expect((await stripe(binding.url, 'whsec_issued_by_stripe', body)).status).toBe(401)
			expect(await manager.providers.issuePayments({ id: binding.id, secret: 'whsec_issued_by_stripe' })).toEqual({ set: true })
			expect((await stripe(binding.url, binding.secret, body)).status).toBe(401)
			expect((await stripe(binding.url, 'whsec_issued_by_stripe', body)).status).toBe(200)
			expect((await stripe(binding.url, 'whsec_issued_by_stripe', body)).status).toBe(200)
			expect(await titled(`payments ${JSON.parse(body).id}`)).toBe(1)
		})

		test('names a binding of the webhook, and is printable text a verifier can use', async () => {
			expect(await manager.providers.issuePayments({ id: crypto.randomUUID(), secret: 'whsec_x' })).toEqual({ set: false })
			const binding = await manager.providers.connectPayments({ account: 'acct_refused' })
			await expect(manager.providers.issuePayments({ id: binding.id, secret: 'with space' })).rejects.toThrow('printable characters')
			await expect(manager.providers.issuePayments({ id: binding.id, secret: '' })).rejects.toThrow('printable characters')
			const alert = await manager.providers.connectAlerts({ account: 'monitor' })
			await expect(manager.providers.issueAlerts({ id: alert.id, secret: 'px_live_key' })).rejects.toThrow('cannot contain px_')
		})
	})

	describe('slack', () => {
		const signed = (url: string, secret: string, headers: Record<string, string>, body: string, t = seconds()) =>
			post(url, { ...headers, 'X-Slack-Request-Timestamp': t, 'X-Slack-Signature': `v0=${hmac('sha256', secret, `v0:${t}:${body}`, 'hex')}` }, body)

		test("answers the URL's verification challenge, runs an event and a slash command once, and refuses a stale one", async () => {
			const binding = await manager.providers.connectSlack({ account: 'T0001' })
			const secret = 'f'.repeat(32)
			expect(await manager.providers.issueSlack({ id: binding.id, secret })).toEqual({ set: true })
			const challenge = await signed(binding.url, secret, json, JSON.stringify({ type: 'url_verification', challenge: 'echo-me', token: 'x' }))
			expect(challenge.status).toBe(200)
			expect(await challenge.json()).toEqual({ challenge: 'echo-me' })
			const id = `Ev${crypto.randomUUID()}`
			const event = JSON.stringify({ type: 'event_callback', event_id: id, team_id: 'T0001', event: { type: 'message' } })
			const t = seconds()
			expect((await signed(binding.url, secret, json, event, t)).status).toBe(200)
			expect((await signed(binding.url, secret, json, event, t)).status).toBe(200)
			expect(await titled(`slack ${id}`)).toBe(1)
			const command = `command=%2Fdeploy&text=${encodeURIComponent(id)}&team_id=T0001`
			expect((await signed(binding.url, secret, form, command)).status).toBe(200)
			expect(await titled(`slack /deploy ${id}`)).toBe(1)
			expect((await signed(binding.url, secret, json, event.replace(id, `${id}-late`), seconds(-10 * 60 * 1000))).status).toBe(401)
			expect((await signed(binding.url, 'e'.repeat(32), json, event)).status).toBe(401)
		})
	})

	describe('twilio', () => {
		test('verifies the URL Twilio posted to, from FABRIKA_APP_ORIGIN, and its sorted parameters; a replay runs nothing', async () => {
			const binding = await manager.providers.connectSms({ account: 'AC0001' })
			const token = '0123456789abcdef0123456789abcdef'
			expect(await manager.providers.issueSms({ id: binding.id, secret: token })).toEqual({ set: true })
			const sid = `SM${crypto.randomUUID().replaceAll('-', '')}`
			const body = `MessageSid=${sid}&Body=Hello+there&From=%2B14158675310&AccountSid=AC0001`
			const signature = (url: string) => hmac('sha1', token, `${url}AccountSidAC0001BodyHello thereFrom+14158675310MessageSid${sid}`, 'base64')
			const send = (url: string) => post(binding.url, { ...form, 'X-Twilio-Signature': signature(url) }, body)
			expect((await send(`https://elsewhere.example${binding.url}`)).status).toBe(401)
			expect((await send(`${kit.origin}${binding.url}`)).status).toBe(200)
			expect((await send(`${kit.origin}${binding.url}`)).status).toBe(200)
			expect(await titled(`sms ${sid} Hello there`)).toBe(1)
		})
	})

	describe("a webhook that reads the sender's own Authorization", () => {
		test('bearer: the token is the secret; a replay runs nothing; a value carrying a platform key never reaches it', async () => {
			const binding = await manager.providers.connectAlerts({ account: 'monitor' })
			const id = `alert-${crypto.randomUUID()}`
			const body = JSON.stringify({ id })
			const send = (authorization: string) => post(binding.url, { ...json, Authorization: authorization }, body)
			expect((await send(`Bearer ${binding.secret}`)).status).toBe(200)
			expect((await send(`Bearer ${binding.secret}`)).status).toBe(200)
			expect(await titled(`alerts ${id}`)).toBe(1)
			expect((await send('Bearer other')).status).toBe(401)
			const issued = `issued-${crypto.randomUUID()}`
			expect(await manager.providers.issueAlerts({ id: binding.id, secret: issued })).toEqual({ set: true })
			expect((await post(binding.url, { ...json, Authorization: `Bearer ${issued}` }, JSON.stringify({ id: `${id}-2` }))).status).toBe(200)
			expect((await post(binding.url, { ...json, Authorization: `Bearer px_${issued}` }, JSON.stringify({ id: `${id}-3` }))).status).toBe(401)
		})

		test('basic: the password is the secret, whatever the user name', async () => {
			const binding = await manager.providers.connectLegacy({ account: 'legacy-erp' })
			const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`
			const id = `legacy-${crypto.randomUUID()}`
			const send = (authorization: string) => post(binding.url, { ...json, Authorization: authorization }, JSON.stringify({ id }))
			expect((await send(basic(`erp:${binding.secret}x`))).status).toBe(401)
			expect((await send(basic(`px_erp:${binding.secret}`))).status).toBe(401)
			expect((await send(basic(`erp:${binding.secret}`))).status).toBe(200)
			expect(await titled(`legacy ${id}`)).toBe(1)
		})
	})
} else {
	test.skip('every webhook verifier end to end (set FABRIKA_TEST_POSTGRES_URL)', () => {})
}
