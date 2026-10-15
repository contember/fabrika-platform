import { describe, expect, test } from 'bun:test'
import { EmailDeliveryError, type EmailDeliveryErrorCode } from '../email.js'
import { MemoryEmailSender } from '../memory.js'

const signal = new AbortController().signal
const message = { to: 'ada@example.test', subject: 'Welcome', text: 'Your account is ready.', idempotencyKey: 'welcome/user-1' }

async function caught(promise: Promise<unknown>): Promise<EmailDeliveryError> {
	const error = await promise.then(() => undefined, (reason: unknown) => reason)
	if (!(error instanceof EmailDeliveryError)) throw new Error('Expected EmailDeliveryError')
	return error
}

describe('MemoryEmailSender', () => {
	test('accepts a message and records the handoff', async () => {
		const sender = new MemoryEmailSender({ provider: 'stand-in', now: () => 42 })

		expect(await sender.send(message, signal)).toEqual({ status: 'accepted', provider: 'stand-in', messageId: 'memory-1' })
		expect(sender.accepted).toEqual([{ message, messageId: 'memory-1', acceptedAt: 42 }])
		expect(sender.handoffs).toEqual([{ message, at: 42, taken: true, answer: 'accepted' }])
		expect(sender.capabilities).toEqual({ idempotent: true, confirmation: 'sync', maxBatch: 1 })
	})

	const faults: { name: string; fault: (sender: MemoryEmailSender) => void; code: EmailDeliveryErrorCode }[] = [
		{ name: 'refuse()', fault: (sender) => sender.refuse(), code: 'provider_rejected' },
		{ name: 'refuse(quota_exceeded)', fault: (sender) => sender.refuse('quota_exceeded'), code: 'quota_exceeded' },
		{ name: 'unavailable()', fault: (sender) => sender.unavailable(), code: 'provider_unavailable' },
		{ name: 'unreachable()', fault: (sender) => sender.unreachable(), code: 'network_error' },
	]
	test.each(faults)('$name answers its code, takes nothing, and heal() clears it', async ({ fault, code }) => {
		const sender = new MemoryEmailSender()
		fault(sender)

		expect((await caught(sender.send(message, signal))).code).toBe(code)
		expect(sender.accepted).toEqual([])
		expect(sender.handoffs).toMatchObject([{ taken: false, answer: code }])
		sender.heal()
		expect((await sender.send(message, signal)).messageId).toBe('memory-1')
	})

	test('the last fault wins its one slot', async () => {
		const sender = new MemoryEmailSender()
		sender.refuse('rate_limited')
		sender.unavailable()
		expect((await caught(sender.send(message, signal))).code).toBe('provider_unavailable')
	})

	test('loseAnswers takes the message, answers network_error, and only for its count', async () => {
		const sender = new MemoryEmailSender()
		sender.loseAnswers(2)

		expect((await caught(sender.send(message, signal))).code).toBe('network_error')
		expect((await caught(sender.send(message, signal))).code).toBe('network_error')
		expect(await sender.send(message, signal)).toMatchObject({ messageId: 'memory-1' })
		expect(sender.accepted).toHaveLength(1)
		expect(sender.handoffs.map((handoff) => [handoff.taken, handoff.answer])).toEqual([
			[true, 'network_error'],
			[false, 'network_error'],
			[false, 'accepted'],
		])
	})

	test('during runs after the handoff is recorded and before the answer; an abort inside it answers aborted', async () => {
		const sender = new MemoryEmailSender()
		const seen: number[] = []
		const controller = new AbortController()
		sender.during(async () => {
			seen.push(sender.handoffs.length, sender.accepted.length)
			controller.abort()
		})

		const error = await caught(sender.send(message, controller.signal))
		expect(seen).toEqual([1, 0])
		expect(error.code).toBe('aborted')
		expect(error.outcome).toBe('unknown')
		expect(sender.accepted).toEqual([])
		expect(sender.handoffs).toMatchObject([{ taken: false, answer: 'aborted' }])
	})

	test('a during hook that rejects answers network_error and takes nothing', async () => {
		const sender = new MemoryEmailSender()
		sender.during(() => Promise.reject(new Error('private hook detail')))

		const error = await caught(sender.send(message, signal))
		expect(error.code).toBe('network_error')
		expect(error.message).not.toContain('private hook detail')
		expect(sender.accepted).toEqual([])
	})

	test('a during hook that rejects after the abort answers aborted', async () => {
		const sender = new MemoryEmailSender()
		const controller = new AbortController()
		sender.during(() => {
			controller.abort()
			return Promise.reject(new Error('private hook detail'))
		})

		expect((await caught(sender.send(message, controller.signal))).code).toBe('aborted')
		expect(sender.handoffs).toMatchObject([{ taken: false, answer: 'aborted' }])
	})

	test('an aborted signal is refused before any handoff', async () => {
		const sender = new MemoryEmailSender()
		expect((await caught(sender.send(message, AbortSignal.abort()))).code).toBe('aborted')
		expect(sender.handoffs).toEqual([])
	})

	test('an idempotent sender answers a repeat with its first id and refuses a different message under the key', async () => {
		const sender = new MemoryEmailSender()
		const first = await sender.send(message, signal)

		expect(await sender.send(message, signal)).toEqual(first)
		expect((await caught(sender.send({ ...message, replyTo: 'support@example.test' }, signal))).code).toBe('idempotency_conflict')
		expect(sender.accepted).toHaveLength(1)
	})

	test('a non-idempotent sender delivers a repeat again', async () => {
		const sender = new MemoryEmailSender({ capabilities: { idempotent: false, confirmation: 'queued' } })

		const first = await sender.send(message, signal)
		const second = await sender.send(message, signal)
		expect(second.messageId).not.toBe(first.messageId)
		expect(sender.accepted.map((email) => email.message)).toEqual([message, message])
		expect(sender.capabilities).toEqual({ idempotent: false, confirmation: 'queued', maxBatch: 1 })
	})

	test('refuses an invalid message without a handoff', async () => {
		const sender = new MemoryEmailSender()
		expect((await caught(sender.send({ ...message, to: 'nope' }, signal))).code).toBe('invalid_message')
		expect(sender.handoffs).toEqual([])
	})
})
