import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DirectoryEmailSender, readCapturedEmails } from '../directory.js'
import { EmailDeliveryError } from '../email.js'

const message = {
	to: 'ada@example.test',
	subject: 'Welcome',
	text: 'Your account is ready.',
	html: '<p>Your account is ready.</p>',
	idempotencyKey: 'welcome/user-1',
}

let directory = ''

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'fabrika-mail-'))
})

afterEach(() => {
	rmSync(directory, { recursive: true, force: true })
})

async function caught(promise: Promise<unknown>): Promise<EmailDeliveryError> {
	const error = await promise.then(() => undefined, (reason: unknown) => reason)
	if (!(error instanceof EmailDeliveryError)) throw new Error('Expected EmailDeliveryError')
	return error
}

describe('DirectoryEmailSender', () => {
	test('captures each message, and the reader answers them oldest first', async () => {
		let now = 2_000
		const sender = new DirectoryEmailSender({ directory, now: () => now })
		const first = await sender.send(message)
		now = 1_000
		await sender.send({ to: 'grace@example.test', subject: 'Reset', text: 'Reset it.', idempotencyKey: 'reset/user-2' })

		expect(first).toEqual({ status: 'accepted', provider: 'directory', messageId: expect.stringMatching(/^[0-9a-f]{64}$/) })
		const captured = await readCapturedEmails(directory)
		expect(captured.map((email) => email.to)).toEqual(['grace@example.test', 'ada@example.test'])
		expect(captured[1]).toEqual({
			messageId: first.messageId,
			to: 'ada@example.test',
			subject: 'Welcome',
			text: 'Your account is ready.',
			html: '<p>Your account is ready.</p>',
			capturedAt: 2_000,
		})
		expect(captured[0]?.html).toBeUndefined()
	})

	test('a repeated idempotency key keeps the first message and answers its id', async () => {
		const sender = new DirectoryEmailSender({ directory })
		const first = await sender.send(message)
		const repeated = await sender.send({ ...message, text: 'A different body.' })

		expect(repeated.messageId).toBe(first.messageId)
		const captured = await readCapturedEmails(directory)
		expect(captured.map((email) => email.text)).toEqual(['Your account is ready.'])
		expect(readdirSync(directory)).toEqual([`${first.messageId}.json`])
	})

	test('validates the message before it writes anything', async () => {
		const sender = new DirectoryEmailSender({ directory })
		const error = await caught(sender.send({ ...message, to: 'not an address' }))
		expect(error.code).toBe('invalid_message')
		expect(readdirSync(directory)).toEqual([])
	})

	test('refuses a relative directory, and a missing one is a retryable failure that names no body', async () => {
		expect(() => new DirectoryEmailSender({ directory: 'mail' })).toThrow(EmailDeliveryError)
		const error = await caught(new DirectoryEmailSender({ directory: join(directory, 'missing') }).send(message))
		expect(error.code).toBe('provider_unavailable')
		expect(error.retryable).toBe(true)
		expect(error.message).not.toContain(message.text)
	})
})
