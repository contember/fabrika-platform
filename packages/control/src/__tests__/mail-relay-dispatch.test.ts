// The relay's dispatcher: one job sends one queued message through the installation's sender and settles its row.
// Against the shipped SQLite schema, with the memory sender standing in for a provider.

import type { EmailMessage } from '@fabrika/email'
import { MemoryEmailSender } from '@fabrika/email/memory'
import { encodePlatformMailRequest, platformMailFingerprint } from '@fabrika/email/platform'
import { type JobQueue, uuidv7 } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { MailMessageRepository, type MailMessageState } from '../db'
import { dispatchMail, MAIL_DISPATCH_INTERRUPTED, MAIL_MAX_ATTEMPTS, MAIL_STALE_CLAIM_S, relayIdempotencyKey } from '../mail-relay/dispatch'
import type { MailDispatchMessage } from '../mail-relay/queue'
import { createHarness } from './helpers/harness'

const T0 = 1_800_000_000
const MESSAGE: EmailMessage = { to: 'ada@example.com', subject: 'Your invitation', text: 'Join us.', idempotencyKey: 'invite:1' }

interface Sent {
	message: MailDispatchMessage
	delaySeconds: number | undefined
}

/** A database write that fails after the provider took the message. */
class FailingMarkSent extends MailMessageRepository {
	override markSent(): Promise<boolean> {
		return Promise.reject(new Error('database unavailable'))
	}
}

function dispatcher(sender: MemoryEmailSender | null = new MemoryEmailSender(), options: { failMarkSent?: boolean } = {}) {
	const harness = createHarness()
	const messages = options.failMarkSent === true ? new FailingMarkSent(harness.d1) : harness.repositories.mailMessages
	const jobs: Sent[] = []
	const queue: JobQueue<MailDispatchMessage> = {
		send(message, options) {
			jobs.push({ message, delaySeconds: options?.delaySeconds })
			return Promise.resolve()
		},
	}
	let now = T0
	return {
		messages,
		jobs,
		sender,
		advance(seconds: number) {
			now += seconds
		},
		now: () => now,
		dispatch: (id: string) => dispatchMail({ messages, queue, sender, now: () => now }, { messageId: id }),
	}
}

async function stored(
	messages: MailMessageRepository,
	options: { sender?: string; state?: MailMessageState; message?: EmailMessage; content?: string } = {},
): Promise<string> {
	const message = options.message ?? MESSAGE
	const { row } = await messages.insertOrFind({
		id: uuidv7(),
		sender: options.sender ?? 'notes@prod',
		idempotency_key: message.idempotencyKey,
		fingerprint: await platformMailFingerprint(message),
		recipient_domain: 'example.com',
		state: options.state ?? 'queued',
		rule_id: null,
		content: options.content ?? encodePlatformMailRequest(message),
	}, T0)
	return row.id
}

describe('the mail dispatcher', () => {
	test("a queued message is sent under the relay's key and keeps its content", async () => {
		const d = dispatcher()
		const id = await stored(d.messages)
		expect(await d.dispatch(id)).toEqual({ status: 'sent' })
		const [delivered] = d.sender?.accepted ?? []
		expect(delivered?.message).toEqual({ ...MESSAGE, idempotencyKey: 'relay:notes@prod:invite:1' })
		expect(await d.messages.get(id)).toMatchObject({
			state: 'sent',
			attempts: 1,
			provider_message_id: delivered?.messageId,
			error_code: null,
			content: encodePlatformMailRequest(MESSAGE),
		})
	})

	test("an installation message's content is forgotten once it is final, sent or not, and an app message's is kept", async () => {
		const sent = dispatcher()
		const delivered = await stored(sent.messages, { sender: 'installation:iam' })
		await sent.dispatch(delivered)
		expect(await sent.messages.get(delivered)).toMatchObject({ state: 'sent', content: null })

		const rejected = dispatcher()
		rejected.sender?.refuse('provider_rejected')
		const failed = await stored(rejected.messages, { sender: 'installation:iam' })
		const appFailed = await stored(rejected.messages, { message: { ...MESSAGE, idempotencyKey: 'app' } })
		await rejected.dispatch(failed)
		await rejected.dispatch(appFailed)
		expect(await rejected.messages.get(failed)).toMatchObject({ state: 'failed', content: null })
		expect((await rejected.messages.get(appFailed))?.content).not.toBeNull()

		const lost = dispatcher(new MemoryEmailSender({ capabilities: { idempotent: false } }))
		lost.sender?.unreachable()
		const unknown = await stored(lost.messages, { sender: 'installation:iam' })
		await lost.dispatch(unknown)
		expect(await lost.messages.get(unknown)).toMatchObject({ state: 'unknown', content: null })
	})

	test('a retryable failure is requeued with a doubling delay, and the fifth attempt is final by its outcome', async () => {
		const d = dispatcher()
		d.sender?.unavailable()
		const id = await stored(d.messages)
		const delays: number[] = []
		for (let attempt = 1; attempt < MAIL_MAX_ATTEMPTS; attempt++) {
			const result = await d.dispatch(id)
			if (result.status !== 'requeued') throw new Error(`attempt ${attempt}: ${result.status}`)
			delays.push(result.delaySeconds)
			expect(await d.messages.get(id)).toMatchObject({
				state: 'queued',
				attempts: attempt,
				next_attempt_at: d.now() + result.delaySeconds,
				error_code: 'provider_unavailable',
			})
			// Not due yet: an early job leaves the message to its delayed one.
			expect(await d.dispatch(id)).toEqual({ status: 'skipped' })
			d.advance(result.delaySeconds)
		}
		expect(delays).toEqual([60, 120, 240, 480])
		expect(d.jobs).toEqual(delays.map((delaySeconds) => ({ message: { messageId: id }, delaySeconds })))
		expect(await d.dispatch(id)).toEqual({ status: 'unknown', code: 'provider_unavailable' })
		expect(await d.messages.get(id)).toMatchObject({ state: 'unknown', attempts: MAIL_MAX_ATTEMPTS, next_attempt_at: null })
	})

	test('a retryable failure that left nothing behind ends failed once the attempts are spent', async () => {
		const d = dispatcher()
		d.sender?.refuse('rate_limited')
		const id = await stored(d.messages)
		for (let attempt = 1; attempt < MAIL_MAX_ATTEMPTS; attempt++) {
			const result = await d.dispatch(id)
			if (result.status !== 'requeued') throw new Error(`attempt ${attempt}: ${result.status}`)
			d.advance(result.delaySeconds)
		}
		expect(await d.dispatch(id)).toEqual({ status: 'failed', code: 'rate_limited' })
	})

	test('a refusal is final at once: failed when nothing left, unknown when it may have', async () => {
		const refused = dispatcher()
		refused.sender?.refuse('provider_rejected')
		const rejected = await stored(refused.messages)
		expect(await refused.dispatch(rejected)).toEqual({ status: 'failed', code: 'provider_rejected' })
		expect(await refused.messages.get(rejected)).toMatchObject({ state: 'failed', attempts: 1, error_code: 'provider_rejected' })

		// Over a transport that is not idempotent, an unknown outcome is never sent again.
		const lost = dispatcher(new MemoryEmailSender({ capabilities: { idempotent: false } }))
		lost.sender?.unreachable()
		const unreachable = await stored(lost.messages)
		expect(await lost.dispatch(unreachable)).toEqual({ status: 'unknown', code: 'network_error' })
		expect(lost.jobs).toEqual([])
	})

	test('without a transport a queued message fails as mail_not_configured', async () => {
		const d = dispatcher(null)
		const id = await stored(d.messages)
		expect(await d.dispatch(id)).toEqual({ status: 'failed', code: 'mail_not_configured' })
	})

	test('a stored body that no longer parses fails as invalid_message and sends nothing', async () => {
		const d = dispatcher()
		const id = await stored(d.messages, { content: '{"to":"ada@example.com"}' })
		expect(await d.dispatch(id)).toEqual({ status: 'failed', code: 'invalid_message' })
		expect(d.sender?.handoffs).toEqual([])
	})

	test('a message that is not queued, or does not exist, is skipped without a send', async () => {
		const d = dispatcher()
		for (const state of ['held', 'dropped'] satisfies MailMessageState[]) {
			const id = await stored(d.messages, { state, message: { ...MESSAGE, idempotencyKey: state } })
			expect(await d.dispatch(id)).toEqual({ status: 'skipped' })
			expect((await d.messages.get(id))?.state).toBe(state)
		}
		const sent = await stored(d.messages)
		await d.dispatch(sent)
		expect(await d.dispatch(sent)).toEqual({ status: 'skipped' })
		expect(await d.dispatch(uuidv7())).toEqual({ status: 'skipped' })
		expect(d.sender?.handoffs).toHaveLength(1)
	})
})

describe('the claim before the send', () => {
	test('two dispatches of one message, one while the other sends, send it once', async () => {
		const d = dispatcher(new MemoryEmailSender({ capabilities: { idempotent: false } }))
		const id = await stored(d.messages)
		const during: Promise<unknown>[] = []
		d.sender?.during(async () => {
			during.push(d.dispatch(id))
			await Promise.resolve()
		})
		const results = await Promise.all([d.dispatch(id), d.dispatch(id)])
		expect(await Promise.all(during)).toEqual([{ status: 'skipped' }])
		expect(results.filter((result) => result.status === 'sent')).toHaveLength(1)
		expect(d.sender?.handoffs).toHaveLength(1)
		expect(await d.messages.get(id)).toMatchObject({ state: 'sent', attempts: 1 })
	})

	test('a claimed attempt that a live consumer still holds is left to it', async () => {
		const d = dispatcher()
		const id = await stored(d.messages)
		expect(await d.messages.claim(id, 0, d.now())).toBe(true)
		d.advance(MAIL_STALE_CLAIM_S - 1)
		expect(await d.dispatch(id)).toEqual({ status: 'skipped' })
		expect(d.sender?.handoffs).toEqual([])
		expect(await d.messages.get(id)).toMatchObject({ state: 'sending', attempts: 1 })
	})

	test('over a non-idempotent transport, a send whose outcome was not recorded is never sent again: it ends unknown', async () => {
		const d = dispatcher(new MemoryEmailSender({ capabilities: { idempotent: false } }), { failMarkSent: true })
		const id = await stored(d.messages)
		await expect(d.dispatch(id)).rejects.toThrow('database unavailable')
		// The consumer retries the job at once: the claim is still held.
		expect(await d.dispatch(id)).toEqual({ status: 'skipped' })
		d.advance(MAIL_STALE_CLAIM_S)
		expect(await d.dispatch(id)).toEqual({ status: 'unknown', code: MAIL_DISPATCH_INTERRUPTED })
		expect(await d.messages.get(id)).toMatchObject({ state: 'unknown', attempts: 1, error_code: MAIL_DISPATCH_INTERRUPTED })
		expect(d.sender?.handoffs).toHaveLength(1)
		expect(d.jobs).toEqual([])
	})

	test('over an idempotent transport, an interrupted attempt goes again under the same key', async () => {
		const d = dispatcher()
		const id = await stored(d.messages)
		expect(await d.messages.claim(id, 0, d.now())).toBe(true)
		d.advance(MAIL_STALE_CLAIM_S)
		expect(await d.dispatch(id)).toEqual({ status: 'sent' })
		expect(await d.messages.get(id)).toMatchObject({ state: 'sent', attempts: 2 })
		expect(d.sender?.handoffs.map((handoff) => handoff.message.idempotencyKey)).toEqual(['relay:notes@prod:invite:1'])
	})

	test('over an idempotent transport, an interrupted last attempt ends unknown', async () => {
		const d = dispatcher()
		const id = await stored(d.messages)
		d.sender?.unavailable()
		for (let attempt = 1; attempt < MAIL_MAX_ATTEMPTS; attempt++) {
			const result = await d.dispatch(id)
			if (result.status !== 'requeued') throw new Error(`attempt ${attempt}: ${result.status}`)
			d.advance(result.delaySeconds)
		}
		expect(await d.messages.claim(id, MAIL_MAX_ATTEMPTS - 1, d.now())).toBe(true)
		d.advance(MAIL_STALE_CLAIM_S)
		expect(await d.dispatch(id)).toEqual({ status: 'unknown', code: MAIL_DISPATCH_INTERRUPTED })
		expect(await d.messages.get(id)).toMatchObject({ state: 'unknown', attempts: MAIL_MAX_ATTEMPTS })
	})
})

describe("the relay's idempotency key", () => {
	test('keeps the sender and key readable while they fit, and hashes them when they would not', async () => {
		expect(await relayIdempotencyKey('installation:iam', 'login:42')).toBe('relay:installation:iam:login:42')
		const long = await relayIdempotencyKey('notes@prod', 'k'.repeat(256))
		expect(long).toMatch(/^relay:[0-9a-f]{64}$/)
		expect(await relayIdempotencyKey('notes@stage', 'k'.repeat(256))).not.toBe(long)
	})
})
