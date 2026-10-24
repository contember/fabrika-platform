// The relay on the Bun process's own parts: the receiver records into Postgres, the `vozka-mail` queue carries the job,
// and the process's mail consumer sends it; a held message reaches the provider only after its release.

import { MemoryEmailSender } from '@fabrika/email/memory'
import { encodePlatformMailRequest, hashPlatformKey } from '@fabrika/email/platform'
import { PostgresJobQueue } from '@fabrika/platform-node'
import { afterEach, describe, expect, test } from 'bun:test'
import { createMailConsumer } from '../bun/server'
import { createControlRepositories } from '../db'
import type { Env } from '../env'
import { handleMailRelay } from '../mail-relay/handler'
import { enqueueMailDispatch, type MailDispatchMessage, releaseMailMessage } from '../mail-relay/queue'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'
import { fakeControlProvider } from './helpers/provider'
import { unusedSourceConnection } from './helpers/source-connection'

if (!hasPostgres) console.warn(`mail-relay-postgres.test.ts ${skipReason}`)

const APP_KEY = `px_${'a'.repeat(40)}`
const NOW = Math.floor(Date.now() / 1000)

describe.skipIf(!hasPostgres)('the mail relay on Postgres', () => {
	let fixture: PostgresFixture | null = null
	afterEach(async () => {
		await fixture?.close()
		fixture = null
	})

	async function relay(sender = new MemoryEmailSender()) {
		fixture = await createPostgres('vozka_mail_relay')
		const repositories = createControlRepositories(fixture.db)
		await repositories.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		await repositories.registry.upsertAppEnv({
			appId: 'notes',
			env: 'prod',
			namespaceId: null,
			provider: 'test',
			providerTargetJson: '{}',
			providerArtifactJson: '{}',
		})
		await repositories.platformTransportKeys.insert({
			app_id: 'notes',
			env: 'prod',
			receiver: 'mail',
			key_id: 'k1',
			key_hash: await hashPlatformKey(APP_KEY),
			value_ref: 'vault:platform:platform-key:notes@prod:mail',
			expires_at: NOW + 3600,
			created_at: NOW,
		})
		const queue = new PostgresJobQueue<MailDispatchMessage>(fixture.db, { queue: 'vozka-mail', maxAttempts: 3 })
		const env: Env = {
			DB: fixture.db,
			REPOSITORIES: repositories,
			ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
			RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
			DEPLOY_QUEUE: { send: () => Promise.resolve() },
			WAIT_UNTIL: () => {},
			ENVIRONMENT: 'local',
			MAIL_TRANSPORT: { kind: 'transport', transport: { variables: {}, secretNames: new Set() } },
			MAIL_RELAY: { queue, installationSecret: 'iam-rpc-key-with-at-least-thirty-two-characters', sender },
		}
		const send = async (to: string, idempotencyKey: string): Promise<string> => {
			const request = new Request('http://control:3000/platform/mail/send', {
				method: 'POST',
				headers: { authorization: `Bearer ${APP_KEY}`, 'content-type': 'application/json' },
				body: encodePlatformMailRequest({ to, subject: 'Hello', text: 'Hi.', idempotencyKey }),
			})
			const response = await handleMailRelay({ env, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('harbor'), request })
			const body: unknown = await response.json()
			const messageId: unknown = body !== null && typeof body === 'object' ? Reflect.get(body, 'messageId') : undefined
			if (typeof messageId !== 'string') throw new Error(`not accepted: ${response.status}`)
			return messageId
		}
		return { repositories, queue, sender, consumer: createMailConsumer(env, queue), otherConsumer: () => createMailConsumer(env, queue), send }
	}

	test('a passed message is queued, consumed and sent', async () => {
		const r = await relay()
		const id = await r.send('ada@example.com', 'invite:1')
		expect(await r.consumer.poll()).toBe(1)
		expect(r.sender.accepted.map((mail) => mail.message.idempotencyKey)).toEqual(['relay:notes@prod:invite:1'])
		expect((await r.repositories.mailMessages.get(id))?.state).toBe('sent')
		expect(await r.consumer.poll()).toBe(0)
	})

	test('a held message waits for its release, then is sent', async () => {
		const r = await relay()
		await r.repositories.mailRules.upsert({ id: crypto.randomUUID(), scope: '*', domain: 'example.com', action: 'hold' }, NOW)
		const id = await r.send('ada@example.com', 'invite:2')
		expect(await r.consumer.poll()).toBe(0)
		expect((await r.repositories.mailMessages.get(id))?.state).toBe('held')

		const deps = { messages: r.repositories.mailMessages, queue: r.queue }
		expect(await releaseMailMessage(deps, id, 'user:ops', NOW)).toBe(true)
		expect(await releaseMailMessage(deps, id, 'user:ops', NOW)).toBe(false)
		expect(await r.consumer.poll()).toBe(1)
		expect(await r.consumer.poll()).toBe(0)
		expect(await r.repositories.mailMessages.get(id)).toMatchObject({ state: 'sent', decided_by: 'user:ops' })
		expect(r.sender.accepted).toHaveLength(1)
	})

	test('two consumers with two jobs of one message send it once over a transport without idempotency', async () => {
		const r = await relay(new MemoryEmailSender({ capabilities: { idempotent: false } }))
		const id = await r.send('ada@example.com', 'invite:3')
		await enqueueMailDispatch(r.queue, id)
		const polled = await Promise.all([r.consumer.poll(), r.otherConsumer().poll()])
		expect(polled.reduce((sum, count) => sum + count, 0)).toBe(2)
		expect(r.sender.handoffs).toHaveLength(1)
		expect(await r.repositories.mailMessages.get(id)).toMatchObject({ state: 'sent', attempts: 1 })
	})
})
