import { describe, expect, test } from 'bun:test'
import { ahaSendEmailProvider, AhaSendEmailSender } from '../ahasend.js'
import { EmailDeliveryError, type EmailFetch } from '../email.js'

const signal = new AbortController().signal
const from = { address: 'auth@example.test' }
const ACCOUNT_ID = '0f4c6a52-6d1e-4c7a-9b0e-3a2f1d5c7e90'
const message = { to: 'ada@example.test', subject: 'Welcome', text: 'Your account is ready.', idempotencyKey: 'welcome/user-1' }

async function caught(promise: Promise<unknown>): Promise<EmailDeliveryError> {
	const error = await promise.then(() => undefined, (reason: unknown) => reason)
	if (!(error instanceof EmailDeliveryError)) throw new Error('Expected EmailDeliveryError')
	return error
}

function capturing(response: () => Response): { fetch: EmailFetch; requests: Request[] } {
	const requests: Request[] = []
	return {
		requests,
		fetch: async (input, init) => {
			requests.push(new Request(input, init))
			return response()
		},
	}
}

function accepted(item: Record<string, unknown>): Response {
	return Response.json({ object: 'list', data: [{ object: 'message', recipient: { email: 'ada@example.test', name: '' }, error: null, ...item }] }, {
		status: 202,
	})
}

describe('AhaSendEmailSender', () => {
	test("sends the documented request to the account's messages", async () => {
		const { fetch, requests } = capturing(() => accepted({ id: 'aha-1', status: 'queued' }))
		const sender = new AhaSendEmailSender({
			apiKey: 'aha_secret',
			accountId: ACCOUNT_ID,
			from: { address: 'auth@example.test', name: 'Fabrika' },
			fetch,
		})

		await expect(sender.send({ ...message, replyTo: 'help@example.test' }, signal)).resolves.toEqual({
			status: 'accepted',
			provider: 'ahasend',
			messageId: 'aha-1',
		})
		const request = requests[0]
		if (request === undefined) throw new Error('Expected a request')
		expect(request.url).toBe(`https://api.ahasend.com/v2/accounts/${ACCOUNT_ID}/messages`)
		expect(request.headers.get('authorization')).toBe('Bearer aha_secret')
		expect(request.headers.get('idempotency-key')).toBe('welcome/user-1')
		expect(await request.json()).toEqual({
			from: { email: 'auth@example.test', name: 'Fabrika' },
			recipients: [{ email: 'ada@example.test' }],
			subject: 'Welcome',
			text_content: 'Your account is ready.',
			reply_to: { email: 'help@example.test' },
		})
	})

	test('sends template syntax in the content as written, because it sends no substitutions', async () => {
		const { fetch, requests } = capturing(() => accepted({ id: 'aha-2', status: 'queued' }))
		const sender = new AhaSendEmailSender({ apiKey: 'aha_secret', accountId: ACCOUNT_ID, from, fetch })
		await sender.send({ ...message, subject: 'Code {{x}}', text: 'Use {% raw %} here', html: '<style>p{color:red}</style>{# note #}' }, signal)
		const body: unknown = await requests[0]?.json()
		expect(body).toMatchObject({ subject: 'Code {{x}}', text_content: 'Use {% raw %} here', html_content: '<style>p{color:red}</style>{# note #}' })
		expect(body).not.toHaveProperty('substitutions')
	})

	test('a key over its 255 characters is sent as its digest, the same one on every retry', async () => {
		const { fetch, requests } = capturing(() => accepted({ id: 'aha-3', status: 'queued' }))
		const sender = new AhaSendEmailSender({ apiKey: 'aha_secret', accountId: ACCOUNT_ID, from, fetch })
		const long = { ...message, idempotencyKey: 'k'.repeat(256) }
		await sender.send(long, signal)
		await sender.send(long, signal)
		await sender.send({ ...long, idempotencyKey: `${'k'.repeat(255)}j` }, signal)
		const keys = requests.map((request) => request.headers.get('idempotency-key'))
		expect(keys[0]).toMatch(/^sha256:[0-9a-f]{64}$/)
		expect(keys[1]).toBe(keys[0] ?? '')
		expect(keys[2]).not.toBe(keys[0] ?? '')
	})

	test("a 202 whose recipient result is an error is a rejection that keeps the result's text out", async () => {
		const { fetch } = capturing(() => accepted({ id: null, status: 'error', error: 'private: ada@example.test is suppressed' }))
		const error = await caught(new AhaSendEmailSender({ apiKey: 'aha_secret', accountId: ACCOUNT_ID, from, fetch }).send(message, signal))
		expect([error.code, error.httpStatus, error.outcome]).toEqual(['provider_rejected', 202, 'not_sent'])
		expect(error.message).not.toContain('ada@example.test')
	})

	test('an accepted recipient with an undocumented status still counts, one without an id does not', async () => {
		const sent = capturing(() => accepted({ id: 'aha-4', status: 'sent' }))
		const sender = new AhaSendEmailSender({ apiKey: 'aha_secret', accountId: ACCOUNT_ID, from, fetch: sent.fetch })
		expect((await sender.send(message, signal)).messageId).toBe('aha-4')

		const odd = capturing(() => accepted({ id: null, status: 'sent' }))
		const error = await caught(new AhaSendEmailSender({ apiKey: 'aha_secret', accountId: ACCOUNT_ID, from, fetch: odd.fetch }).send(message, signal))
		expect(error.code).toBe('malformed_response')
	})

	test('an unknown account is a configuration refusal', async () => {
		const { fetch } = capturing(() => Response.json({ message: 'account not found' }, { status: 404 }))
		const error = await caught(new AhaSendEmailSender({ apiKey: 'aha_secret', accountId: ACCOUNT_ID, from, fetch }).send(message, signal))
		expect([error.code, error.httpStatus]).toEqual(['provider_unauthorized', 404])
	})

	test('the provider reads its variables and names a bad one without its value', () => {
		const env = { FABRIKA_EMAIL_AHASEND_API_KEY: 'aha_secret', FABRIKA_EMAIL_AHASEND_ACCOUNT_ID: ACCOUNT_ID }
		expect(ahaSendEmailProvider.create({ from, env })).toBeInstanceOf(AhaSendEmailSender)
		expect(ahaSendEmailProvider.variables.map((variable) => [variable.name, variable.secret])).toEqual([
			['FABRIKA_EMAIL_AHASEND_API_KEY', true],
			['FABRIKA_EMAIL_AHASEND_ACCOUNT_ID', false],
		])

		const refused = (): unknown => ahaSendEmailProvider.create({ from, env: { ...env, FABRIKA_EMAIL_AHASEND_ACCOUNT_ID: '../private' } })
		expect(refused).toThrow('FABRIKA_EMAIL_AHASEND_ACCOUNT_ID is missing or invalid')
		expect(refused).not.toThrow('../private')
		expect(() => new AhaSendEmailSender({ apiKey: 'aha_secret', accountId: 'a/b', from })).toThrow('AhaSend account ID is invalid')
	})
})
