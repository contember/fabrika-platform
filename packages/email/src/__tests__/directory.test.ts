import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emailSenderFromEnv } from '../config.js'
import { directoryEmailProvider, DirectoryEmailSender, readCapturedEmails } from '../directory.js'
import { EmailDeliveryError } from '../email.js'
import { builtinEmailProviders } from '../providers.js'

const message = {
	to: 'ada@example.test',
	subject: 'Welcome',
	text: 'Your account is ready.',
	html: '<p>Your account is ready.</p>',
	idempotencyKey: 'welcome/user-1',
}

const signal = new AbortController().signal

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
		const first = await sender.send(message, signal)
		now = 1_000
		await sender.send({ to: 'grace@example.test', subject: 'Reset', text: 'Reset it.', idempotencyKey: 'reset/user-2' }, signal)

		expect(first).toEqual({ status: 'accepted', provider: 'directory', messageId: expect.stringMatching(/^[0-9a-f]{64}$/) })
		const captured = await readCapturedEmails(directory)
		expect(captured.map((email) => email.to)).toEqual(['grace@example.test', 'ada@example.test'])
		expect(captured[1]).toEqual({
			messageId: first.messageId,
			idempotencyKey: 'welcome/user-1',
			to: 'ada@example.test',
			subject: 'Welcome',
			text: 'Your account is ready.',
			html: '<p>Your account is ready.</p>',
			capturedAt: 2_000,
		})
		expect(captured[0]?.html).toBeUndefined()
	})

	test('a repeated message under one key answers its first id, and a different one is a conflict', async () => {
		const sender = new DirectoryEmailSender({ directory })
		const first = await sender.send(message, signal)
		const repeated = await sender.send(message, signal)
		const error = await caught(sender.send({ ...message, text: 'A different body.' }, signal))

		expect(repeated.messageId).toBe(first.messageId)
		expect(error.code).toBe('idempotency_conflict')
		expect(error.message).not.toContain('A different body.')
		const captured = await readCapturedEmails(directory)
		expect(captured.map((email) => email.text)).toEqual(['Your account is ready.'])
		expect(readdirSync(directory)).toEqual([`${first.messageId}.json`])
	})

	test('captures the reply-to address and sender name, and an aborted call writes nothing', async () => {
		const sender = new DirectoryEmailSender({ directory })
		await sender.send({ ...message, replyTo: 'support@example.test', fromName: 'Acme' }, signal)
		expect((await readCapturedEmails(directory))[0]).toMatchObject({ replyTo: 'support@example.test', fromName: 'Acme' })

		const error = await caught(sender.send({ ...message, idempotencyKey: 'welcome/user-3' }, AbortSignal.abort()))
		expect(error.code).toBe('aborted')
		expect(await readCapturedEmails(directory)).toHaveLength(1)
	})

	test('validates the message before it writes anything', async () => {
		const sender = new DirectoryEmailSender({ directory })
		const error = await caught(sender.send({ ...message, to: 'not an address' }, signal))
		expect(error.code).toBe('invalid_message')
		expect(readdirSync(directory)).toEqual([])
	})

	test('refuses a relative directory, and a missing one is a retryable failure that names no body', async () => {
		expect(() => new DirectoryEmailSender({ directory: 'mail' })).toThrow(EmailDeliveryError)
		const error = await caught(new DirectoryEmailSender({ directory: join(directory, 'missing') }).send(message, signal))
		expect(error.code).toBe('provider_unavailable')
		expect(error.retryable).toBe(true)
		expect(error.message).not.toContain(message.text)
	})
})

describe('directoryEmailProvider', () => {
	const registry = { directory: directoryEmailProvider }
	const env = (variables: Readonly<Record<string, string>>) => ({
		FABRIKA_EMAIL_PROVIDER: 'directory',
		FABRIKA_EMAIL_FROM: 'mail@local.test',
		...variables,
	})

	function refusal(work: () => unknown): string {
		try {
			work()
		} catch (error) {
			if (error instanceof EmailDeliveryError && error.code === 'invalid_configuration') return error.message
			throw error
		}
		throw new Error('Expected an invalid_configuration refusal')
	}

	test('names a missing FABRIKA_EMAIL_DIRECTORY, and refuses a relative one with the fixed text', () => {
		expect(refusal(() => emailSenderFromEnv(env({}), registry))).toBe('Email configuration is invalid: FABRIKA_EMAIL_DIRECTORY is missing')
		expect(refusal(() => emailSenderFromEnv(env({ FABRIKA_EMAIL_DIRECTORY: 'relative/mail' }), registry))).toBe(
			'Email configuration is invalid: The mail capture directory must be an absolute path',
		)
	})

	test('builds a sender whose capture the reader answers with its idempotency key', async () => {
		const sender = emailSenderFromEnv(env({ FABRIKA_EMAIL_DIRECTORY: directory }), registry)
		if (sender === null) throw new Error('Expected a sender')
		await sender.send(message, signal)
		const captured = await readCapturedEmails(directory)
		expect(captured.map((email) => email.idempotencyKey)).toEqual([message.idempotencyKey])
	})

	test('is no built-in provider: only a composition registers it', () => {
		expect(Object.keys(builtinEmailProviders)).not.toContain('directory')
		expect(refusal(() => emailSenderFromEnv(env({ FABRIKA_EMAIL_DIRECTORY: directory }), builtinEmailProviders))).toBe(
			'FABRIKA_EMAIL_PROVIDER must be none or one of: ahasend, cloudflare, lettermint, postmark, resend, smartemailing',
		)
	})
})
