import { describe, expect, test } from 'bun:test'
import { EmailDeliveryError } from '../email.js'
import { type EmailFetch, ResendEmailSender } from '../resend.js'
import { isValidEmailAddress, isValidEmailFrom } from '../validation.js'

const validMessage = {
	to: 'ada@example.test',
	subject: 'Welcome',
	text: 'Your account is ready.',
	html: '<p>Your account is ready.</p>',
	idempotencyKey: 'welcome/user-1',
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function caught(promise: Promise<unknown>): Promise<EmailDeliveryError> {
	const error = await promise.then(() => undefined, (reason: unknown) => reason)
	if (!(error instanceof EmailDeliveryError)) throw new Error('Expected EmailDeliveryError')
	return error
}

describe('ResendEmailSender', () => {
	test('sends the documented request and returns the provider message id', async () => {
		const requests: Request[] = []
		const fetch: EmailFetch = async (input, init) => {
			requests.push(new Request(input, init))
			return jsonResponse({ id: 'email-123' }, 200)
		}
		const sender = new ResendEmailSender({ apiKey: 're_secret', from: 'Fabrika <auth@example.test>', fetch })

		await expect(sender.send(validMessage)).resolves.toEqual({ status: 'accepted', provider: 'resend', messageId: 'email-123' })
		const request = requests[0]
		if (request === undefined) throw new Error('Expected a request')
		expect(request.url).toBe('https://api.resend.com/emails')
		expect(request.method).toBe('POST')
		expect(request.headers.get('authorization')).toBe('Bearer re_secret')
		expect(request.headers.get('content-type')).toBe('application/json')
		expect(request.headers.get('idempotency-key')).toBe('welcome/user-1')
		expect(await request.json()).toEqual({
			from: 'Fabrika <auth@example.test>',
			to: 'ada@example.test',
			subject: 'Welcome',
			text: 'Your account is ready.',
			html: '<p>Your account is ready.</p>',
		})
	})

	test('omits html when the caller supplies only plain text', async () => {
		let body: unknown
		const fetch: EmailFetch = async (input, init) => {
			body = await new Request(input, init).json()
			return jsonResponse({ id: 'email-text' }, 200)
		}
		const sender = new ResendEmailSender({ apiKey: 're_secret', from: 'auth@example.test', fetch })

		await sender.send({ to: validMessage.to, subject: validMessage.subject, text: validMessage.text, idempotencyKey: 'text/user-1' })
		expect(body).toEqual({ from: 'auth@example.test', to: 'ada@example.test', subject: 'Welcome', text: 'Your account is ready.' })
	})

	test('classifies a 4xx rejection as permanent without exposing its body', async () => {
		const secret = 're_secret_that_must_not_leak'
		const messageBody = 'Your account is ready.'
		const fetch: EmailFetch = async () => jsonResponse({ name: 'validation_error', message: `${secret}: ${messageBody}` }, 422)
		const sender = new ResendEmailSender({ apiKey: secret, from: 'auth@example.test', fetch })

		const error = await caught(sender.send({ ...validMessage, text: messageBody }))
		expect(error.code).toBe('provider_rejected')
		expect(error.retryable).toBe(false)
		expect(error.httpStatus).toBe(422)
		expect(error.message).not.toContain(secret)
		expect(error.message).not.toContain(messageBody)
	})

	test.each([429, 500, 503])('classifies HTTP %d as retryable', async (status) => {
		const fetch: EmailFetch = async () => new Response('not JSON', { status })
		const sender = new ResendEmailSender({ apiKey: 're_secret', from: 'auth@example.test', fetch })

		const error = await caught(sender.send(validMessage))
		expect(error.retryable).toBe(true)
		expect(error.httpStatus).toBe(status)
		expect(error.code).toBe(status === 429 ? 'rate_limited' : 'provider_unavailable')
	})

	test('classifies a network failure as retryable and hides the original error', async () => {
		const fetch: EmailFetch = async () => {
			throw new Error(`socket failed re_secret ${validMessage.text}`)
		}
		const sender = new ResendEmailSender({ apiKey: 're_secret', from: 'auth@example.test', fetch })

		const error = await caught(sender.send(validMessage))
		expect(error.code).toBe('network_error')
		expect(error.retryable).toBe(true)
		expect(error.message).not.toContain('re_secret')
		expect(error.message).not.toContain(validMessage.text)
	})

	test('aborts a slow request at the configured timeout', async () => {
		const fetch: EmailFetch = (_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted with private provider state')), { once: true })
			})
		const sender = new ResendEmailSender({ apiKey: 're_secret', from: 'auth@example.test', fetch, timeoutMs: 5 })

		const error = await caught(sender.send(validMessage))
		expect(error.code).toBe('request_timeout')
		expect(error.retryable).toBe(true)
	})

	test.each([
		new Response('not JSON', { status: 200 }),
		jsonResponse({ id: '' }, 200),
		jsonResponse({ message: 'accepted' }, 200),
	])('rejects a malformed success response as retryable', async (response) => {
		const fetch: EmailFetch = async () => response
		const sender = new ResendEmailSender({ apiKey: 're_secret', from: 'auth@example.test', fetch })

		const error = await caught(sender.send(validMessage))
		expect(error.code).toBe('malformed_response')
		expect(error.retryable).toBe(true)
	})

	test('validates configuration before making requests', () => {
		expect(() => new ResendEmailSender({ apiKey: '', from: 'auth@example.test' })).toThrow('Resend API key is invalid')
		expect(() => new ResendEmailSender({ apiKey: 're_secret', from: 'not-an-email' })).toThrow('Resend sender is invalid')
		expect(() => new ResendEmailSender({ apiKey: 're_secret', from: 'Bad\nName <auth@example.test>' })).toThrow('Resend sender is invalid')
		expect(() => new ResendEmailSender({ apiKey: 're_secret', from: 'auth@example.test', timeoutMs: 0 })).toThrow('Resend timeout is invalid')
	})

	test.each([
		{ ...validMessage, to: 'invalid' },
		{ ...validMessage, subject: '' },
		{ ...validMessage, subject: 'Bad\nsubject' },
		{ ...validMessage, text: '   ' },
		{ ...validMessage, idempotencyKey: '' },
		{ ...validMessage, idempotencyKey: 'x'.repeat(257) },
	])('rejects an invalid message without making a request', async (message) => {
		let requests = 0
		const fetch: EmailFetch = async () => {
			requests++
			return jsonResponse({ id: 'unexpected' }, 200)
		}
		const sender = new ResendEmailSender({ apiKey: 're_secret', from: 'auth@example.test', fetch })

		const error = await caught(sender.send(message))
		expect(error.code).toBe('invalid_message')
		expect(error.retryable).toBe(false)
		expect(requests).toBe(0)
	})

	test('treats a concurrent idempotent request as retryable', async () => {
		const fetch: EmailFetch = async () => jsonResponse({ name: 'concurrent_idempotent_requests' }, 409)
		const sender = new ResendEmailSender({ apiKey: 're_secret', from: 'auth@example.test', fetch })

		const error = await caught(sender.send(validMessage))
		expect(error.code).toBe('request_in_progress')
		expect(error.retryable).toBe(true)
		expect(error.httpStatus).toBe(409)
	})
})

describe('email address validation', () => {
	test.each(['person@example.test', 'first.last+tag@sub.example.test'])('accepts strict mailbox addresses', (address) => {
		expect(isValidEmailAddress(address)).toBe(true)
	})

	test.each([
		'',
		' person@example.test',
		'person@example.test ',
		'person@@example.test',
		'.person@example.test',
		'person..name@example.test',
		'person@example',
		'person@-example.test',
		'person@example..test',
		'person\n@example.test',
	])('rejects invalid mailbox addresses', (address) => {
		expect(isValidEmailAddress(address)).toBe(false)
	})

	test('accepts a mailbox or display name in the from field', () => {
		expect(isValidEmailFrom('auth@example.test')).toBe(true)
		expect(isValidEmailFrom('Fabrika Auth <auth@example.test>')).toBe(true)
		expect(isValidEmailFrom('<auth@example.test>')).toBe(false)
		expect(isValidEmailFrom('Fabrika <invalid>')).toBe(false)
	})
})
