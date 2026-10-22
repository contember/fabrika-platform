// The relay's receiver: authentication, the body, idempotency and the gate, through `handleMailRelay` against the
// shipped SQLite schema. The dispatcher and maintenance have their own files.

import type { EmailMessage, EmailSender } from '@fabrika/email'
import { MemoryEmailSender } from '@fabrika/email/memory'
import {
	encodePlatformMailRequest,
	hashPlatformKey,
	installationMailKey,
	parsePlatformMailAnswer,
	platformMailFingerprint,
} from '@fabrika/email/platform'
import type { JobQueue } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import type { MailRuleAction } from '../db'
import type { Env } from '../env'
import { handleMailRelay, MAIL_RELAY_MAX_BODY_BYTES } from '../mail-relay/handler'
import type { MailDispatchMessage } from '../mail-relay/queue'
import type { InstallationMail } from '../mail-transport'
import { createHarness, type Harness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'
import { unusedSourceConnection } from './helpers/source-connection'

const RPC_SECRET = 'iam-rpc-key-with-at-least-thirty-two-characters'
const APP_KEY = `px_${'a'.repeat(40)}`
const NOW = Math.floor(Date.now() / 1000)
const TRANSPORT: InstallationMail = { kind: 'transport', transport: { variables: {}, secretNames: new Set() } }

const MESSAGE: EmailMessage = { to: 'ada@example.com', subject: 'Your invitation', text: 'Join us.', idempotencyKey: 'invite:1' }

interface Relay {
	harness: Harness
	env: Env
	jobs: MailDispatchMessage[]
	send(init: { key?: string | null; body?: string; path?: string; method?: string; headers?: Record<string, string> }): Promise<Response>
}

interface RelayOptions {
	transport?: InstallationMail
	relay?: boolean
	/** Control's sender; none by default. */
	sender?: EmailSender
}

async function relay(options: RelayOptions = {}): Promise<Relay> {
	const harness = createHarness()
	await harness.repositories.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await harness.repositories.registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'test',
		providerTargetJson: '{}',
		providerArtifactJson: '{}',
	})
	await addKey(harness, 'k1', APP_KEY, NOW + 3600)
	const jobs: MailDispatchMessage[] = []
	const queue: JobQueue<MailDispatchMessage> = {
		send(message) {
			jobs.push(message)
			return Promise.resolve()
		},
	}
	const env: Env = {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'local',
		MAIL_TRANSPORT: options.transport ?? TRANSPORT,
		...(options.relay === false ? {} : { MAIL_RELAY: { queue, installationSecret: RPC_SECRET, sender: options.sender ?? null } }),
	}
	return {
		harness,
		env,
		jobs,
		send: (init) => {
			const headers = new Headers({ 'content-type': 'application/json', ...init.headers })
			const key = init.key === undefined ? APP_KEY : init.key
			if (key !== null) headers.set('authorization', `Bearer ${key}`)
			const request = new Request(`http://control:3000${init.path ?? '/platform/mail/send'}`, {
				method: init.method ?? 'POST',
				headers,
				...(init.method === 'GET' ? {} : { body: init.body ?? encodePlatformMailRequest(MESSAGE) }),
			})
			return handleMailRelay({ env, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('harbor'), request })
		},
	}
}

async function addKey(harness: Harness, keyId: string, key: string, expiresAt: number, appId = 'notes', env = 'prod'): Promise<void> {
	await harness.repositories.platformTransportKeys.insert({
		app_id: appId,
		env,
		receiver: 'mail',
		key_id: keyId,
		key_hash: await hashPlatformKey(key),
		value_ref: `vault:platform:platform-key:${appId}@${env}:mail`,
		expires_at: expiresAt,
		created_at: NOW,
	})
}

async function answer(response: Response): Promise<{ status: number; answer: ReturnType<typeof parsePlatformMailAnswer> }> {
	const body: unknown = await response.json()
	return { status: response.status, answer: parsePlatformMailAnswer(response.status, body) }
}

async function acceptedId(response: Response): Promise<string> {
	const read = await answer(response)
	if (read.answer === null || !('messageId' in read.answer)) throw new Error(`not accepted: ${read.status}`)
	return read.answer.messageId
}

async function rule(harness: Harness, scope: string, domain: string, action: MailRuleAction): Promise<string> {
	const row = await harness.repositories.mailRules.upsert({ id: crypto.randomUUID(), scope, domain, action }, NOW)
	return row.id
}

describe('the mail relay: authentication', () => {
	test('an application key sends as its environment, and the canonical body is stored and queued', async () => {
		const r = await relay()
		const id = await acceptedId(await r.send({}))
		const row = await r.harness.repositories.mailMessages.get(id)
		expect(row).toMatchObject({
			sender: 'notes@prod',
			idempotency_key: 'invite:1',
			recipient_domain: 'example.com',
			state: 'queued',
			rule_id: null,
			attempts: 0,
			content: encodePlatformMailRequest(MESSAGE),
		})
		expect(r.jobs).toEqual([{ messageId: id }])
	})

	test("IAM's derived key sends as the installation", async () => {
		const r = await relay()
		const id = await acceptedId(await r.send({ key: await installationMailKey(RPC_SECRET) }))
		expect((await r.harness.repositories.mailMessages.get(id))?.sender).toBe('installation:iam')
	})

	test('a missing, unknown or expired key, or a key derived from another secret, is provider_unauthorized', async () => {
		const r = await relay()
		await addKey(r.harness, 'old', `px_${'b'.repeat(40)}`, NOW - 1)
		const refusals = [
			await r.send({ key: null }),
			await r.send({ key: `px_${'c'.repeat(40)}` }),
			await r.send({ key: `px_${'b'.repeat(40)}` }),
			await r.send({ key: await installationMailKey(`${RPC_SECRET}-other`) }),
			await r.send({ key: null, headers: { authorization: `Basic ${APP_KEY}` } }),
		]
		for (const response of refusals) {
			expect(await answer(response)).toEqual({ status: 401, answer: { error: { code: 'provider_unauthorized' } } })
		}
		expect(await r.harness.repositories.mailMessages.list({ limit: 10 })).toEqual([])
	})

	test('a key lookup that fails is provider_unavailable, which the sender retries', async () => {
		const r = await relay()
		r.harness.sqlite.close()
		expect(await answer(await r.send({}))).toEqual({ status: 503, answer: { error: { code: 'provider_unavailable' } } })
	})

	test('the Worker has no relay, and another path or method under the row is not the receiver', async () => {
		expect((await (await relay({ relay: false })).send({})).status).toBe(404)
		const r = await relay()
		expect((await r.send({ path: '/platform/mail/other' })).status).toBe(404)
		expect((await r.send({ method: 'GET' })).status).toBe(404)
		expect(r.jobs).toEqual([])
	})
})

describe('the mail relay: the body', () => {
	test('malformed JSON, an unknown field or an invalid message is invalid_message and records nothing', async () => {
		const r = await relay()
		const bodies = [
			'{',
			JSON.stringify({ ...JSON.parse(encodePlatformMailRequest(MESSAGE)), bcc: 'eve@example.com' }),
			encodePlatformMailRequest({ ...MESSAGE, to: 'not an address' }),
		]
		for (const body of bodies) {
			expect(await answer(await r.send({ body }))).toEqual({ status: 400, answer: { error: { code: 'invalid_message' } } })
		}
		expect(await r.harness.repositories.mailMessages.list({ limit: 10 })).toEqual([])
	})

	test('a body over the cap is refused as invalid_message, whatever it declares', async () => {
		const r = await relay()
		const oversized = 'x'.repeat(MAIL_RELAY_MAX_BODY_BYTES + 1)
		expect((await r.send({ body: oversized })).status).toBe(400)
		const declared = await r.send({ body: encodePlatformMailRequest(MESSAGE), headers: { 'content-length': String(MAIL_RELAY_MAX_BODY_BYTES + 1) } })
		expect((await answer(declared)).status).toBe(400)
		expect(r.jobs).toEqual([])
	})
})

describe('the mail relay: idempotency', () => {
	test('a repeat of the same message answers the first id and queues nothing more', async () => {
		const r = await relay()
		const first = await acceptedId(await r.send({}))
		expect(await acceptedId(await r.send({}))).toBe(first)
		expect(r.jobs).toEqual([{ messageId: first }])
	})

	test('another message under the same key is idempotency_conflict', async () => {
		const r = await relay()
		await acceptedId(await r.send({}))
		const conflict = await r.send({ body: encodePlatformMailRequest({ ...MESSAGE, subject: 'Something else' }) })
		expect(await answer(conflict)).toEqual({ status: 409, answer: { error: { code: 'idempotency_conflict' } } })
	})

	test('the same key of two senders is two messages', async () => {
		const r = await relay()
		const app = await acceptedId(await r.send({}))
		const iam = await acceptedId(await r.send({ key: await installationMailKey(RPC_SECRET) }))
		expect(iam).not.toBe(app)
	})
})

describe('the mail relay: the gate', () => {
	const decided = async (r: Relay, response: Response) => {
		const row = await r.harness.repositories.mailMessages.get(await acceptedId(response))
		return { state: row?.state, ruleId: row?.rule_id }
	}

	test('without a rule a message passes', async () => {
		const r = await relay()
		await rule(r.harness, 'other@prod', '*', 'hold')
		expect(await decided(r, await r.send({}))).toEqual({ state: 'queued', ruleId: null })
	})

	test('the exact scope and domain win over the scope with any domain', async () => {
		const r = await relay()
		const exact = await rule(r.harness, 'notes@prod', 'example.com', 'hold')
		await rule(r.harness, 'notes@prod', '*', 'drop')
		expect(await decided(r, await r.send({}))).toEqual({ state: 'held', ruleId: exact })
		expect(r.jobs).toEqual([])
	})

	test('the scope with any domain wins over any scope with the exact domain', async () => {
		const r = await relay()
		const scoped = await rule(r.harness, 'notes@prod', '*', 'hold')
		await rule(r.harness, '*', 'example.com', 'drop')
		expect(await decided(r, await r.send({}))).toEqual({ state: 'held', ruleId: scoped })
	})

	test('any scope with the exact domain wins over the catch-all, and matches the domain in any case', async () => {
		const r = await relay()
		const domain = await rule(r.harness, '*', 'example.com', 'pass')
		await rule(r.harness, '*', '*', 'hold')
		const response = await r.send({ body: encodePlatformMailRequest({ ...MESSAGE, to: 'ada@Example.COM' }) })
		const id = await acceptedId(response)
		expect(await r.harness.repositories.mailMessages.get(id)).toMatchObject({ state: 'queued', rule_id: domain, recipient_domain: 'example.com' })
		expect(r.jobs).toEqual([{ messageId: id }])
	})

	test('the catch-all drops', async () => {
		const r = await relay()
		const catchAll = await rule(r.harness, '*', '*', 'drop')
		expect(await decided(r, await r.send({}))).toEqual({ state: 'dropped', ruleId: catchAll })
		expect(r.jobs).toEqual([])
	})

	test('an installation message is queued whatever the rules say', async () => {
		const r = await relay()
		await rule(r.harness, '*', '*', 'drop')
		const response = await r.send({ key: await installationMailKey(RPC_SECRET) })
		expect(await decided(r, response)).toEqual({ state: 'queued', ruleId: null })
		expect(r.jobs).toHaveLength(1)
	})

	test('without a transport, or with an invalid one, an installation message is refused as mail_not_configured and not recorded', async () => {
		for (const transport of [{ kind: 'none' }, { kind: 'invalid', reason: 'FABRIKA_EMAIL_FROM is missing' }] satisfies InstallationMail[]) {
			const r = await relay({ transport })
			const response = await r.send({ key: await installationMailKey(RPC_SECRET) })
			expect(await answer(response)).toEqual({ status: 503, answer: { error: { code: 'mail_not_configured' } } })
			expect(await r.harness.repositories.mailMessages.list({ limit: 10 })).toEqual([])
			expect(r.jobs).toEqual([])
		}
	})

	test('without a transport, or with an invalid one, an application message is held, a pass rule notwithstanding', async () => {
		for (const transport of [{ kind: 'none' }, { kind: 'invalid', reason: 'FABRIKA_EMAIL_FROM is missing' }] satisfies InstallationMail[]) {
			const r = await relay({ transport })
			await rule(r.harness, 'notes@prod', 'example.com', 'pass')
			expect(await decided(r, await r.send({}))).toEqual({ state: 'held', ruleId: null })
			expect(r.jobs).toEqual([])
		}
	})
})

describe('the mail relay: a broadcast message', () => {
	const BROADCAST: EmailMessage = { ...MESSAGE, idempotencyKey: 'news:1', unsubscribeUrl: 'https://notes.example/unsubscribe?t=1', broadcast: true }

	test("is refused as invalid_message and not recorded when Control's transport sends none", async () => {
		const r = await relay({ sender: new MemoryEmailSender({ capabilities: { broadcast: false } }) })
		const response = await r.send({ body: encodePlatformMailRequest(BROADCAST) })
		expect(await answer(response)).toEqual({ status: 400, answer: { error: { code: 'invalid_message' } } })
		expect(await r.harness.repositories.mailMessages.list({ limit: 10 })).toEqual([])
		expect(r.jobs).toEqual([])
	})

	test('recorded before the transport changed, its retry gets the recorded answer, and other content a conflict', async () => {
		const r = await relay({ sender: new MemoryEmailSender({ capabilities: { broadcast: false } }) })
		const { row } = await r.harness.repositories.mailMessages.insertOrFind({
			id: crypto.randomUUID(),
			sender: 'notes@prod',
			idempotency_key: BROADCAST.idempotencyKey,
			fingerprint: await platformMailFingerprint(BROADCAST),
			recipient_domain: 'example.com',
			state: 'held',
			rule_id: null,
			content: encodePlatformMailRequest(BROADCAST),
		}, NOW)
		expect(await acceptedId(await r.send({ body: encodePlatformMailRequest(BROADCAST) }))).toBe(row.id)
		const changed = await r.send({ body: encodePlatformMailRequest({ ...BROADCAST, subject: 'Another' }) })
		expect(await answer(changed)).toEqual({ status: 409, answer: { error: { code: 'idempotency_conflict' } } })
		expect(r.jobs).toEqual([])
	})

	test('is stored as one and queued when the transport sends them, or when there is no sender to ask yet', async () => {
		for (const sender of [new MemoryEmailSender(), undefined]) {
			const r = await relay(sender === undefined ? {} : { sender })
			await acceptedId(await r.send({ body: encodePlatformMailRequest(BROADCAST) }))
			const [row] = await r.harness.repositories.mailMessages.list({ limit: 10 })
			expect(row?.content).toBe(encodePlatformMailRequest(BROADCAST))
			expect(r.jobs).toHaveLength(1)
		}
	})
})
