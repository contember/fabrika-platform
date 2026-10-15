import { describe, expect, test } from 'bun:test'
import { EmailDeliveryError, type EmailFetch } from '../email.js'
import { smartEmailingEmailProvider, SmartEmailingEmailSender } from '../smartemailing.js'

const signal = new AbortController().signal
const message = {
	to: 'ada@example.test',
	subject: 'Welcome',
	text: 'Your account is ready.',
	idempotencyKey: 'welcome/user-1',
}

function accepted(data: unknown): Response {
	return Response.json({ status: 'created', meta: [], data }, { status: 201 })
}

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

describe('SmartEmailingEmailSender', () => {
	test('sends one task to the bulk endpoint with Basic credentials and the default tag', async () => {
		const { fetch, requests } = capturing(() => accepted([{ recipient: 'ada@example.test', id: 'se-1' }]))
		const sender = new SmartEmailingEmailSender({
			username: 'user@example.test',
			apiKey: 'se_secret',
			from: { address: 'auth@example.test', name: 'Fabrika' },
			fetch,
		})

		await expect(sender.send(message, signal)).resolves.toEqual({ status: 'accepted', provider: 'smartemailing', messageId: 'se-1' })
		const request = requests[0]
		if (request === undefined) throw new Error('Expected a request')
		expect(request.url).toBe('https://app.smartemailing.cz/api/v3/send/transactional-emails-bulk')
		expect(request.method).toBe('POST')
		expect(request.headers.get('authorization')).toBe(`Basic ${btoa('user@example.test:se_secret')}`)
		expect(request.headers.get('content-type')).toBe('application/json')
		expect(request.headers.get('idempotency-key')).toBeNull()
		expect(await request.json()).toEqual({
			sender_credentials: { from: 'auth@example.test', sender_name: 'Fabrika' },
			tag: 'fabrika',
			message_contents: { subject: 'Welcome', text_body: 'Your account is ready.' },
			tasks: [{ recipient: { emailaddress: 'ada@example.test' } }],
		})
	})

	test("the message's sender name, reply-to and html replace or add to the defaults", async () => {
		const { fetch, requests } = capturing(() => accepted([{ id: 'se-2' }]))
		const sender = new SmartEmailingEmailSender({
			username: 'user',
			apiKey: 'se_secret',
			from: { address: 'auth@example.test', name: 'Fabrika' },
			tag: 'intake-mail',
			fetch,
		})

		await sender.send({ ...message, html: '<p>Ready.</p>', fromName: 'Acme', replyTo: 'support@example.test' }, signal)
		expect(await requests[0]?.json()).toMatchObject({
			sender_credentials: { from: 'auth@example.test', sender_name: 'Acme', reply_to: 'support@example.test' },
			tag: 'intake-mail',
			message_contents: { html_body: '<p>Ready.</p>' },
		})
	})

	test.each([[], [{ id: 'se-1' }, { id: 'se-2' }], [{ id: '' }], [{ id: 7 }], null])('a 201 without exactly one id is malformed', async (data) => {
		const { fetch } = capturing(() => accepted(data))
		const sender = new SmartEmailingEmailSender({ username: 'user', apiKey: 'se_secret', from: { address: 'auth@example.test' }, fetch })

		const error = await caught(sender.send(message, signal))
		expect(error.code).toBe('malformed_response')
		expect(error.httpStatus).toBe(201)
	})

	test('validates its configuration before any request', () => {
		const from = { address: 'auth@example.test' }
		expect(() => new SmartEmailingEmailSender({ username: 'us:er', apiKey: 'k', from })).toThrow('SmartEmailing username is invalid')
		expect(() => new SmartEmailingEmailSender({ username: 'user', apiKey: 'with space', from })).toThrow('SmartEmailing API key is invalid')
		expect(() => new SmartEmailingEmailSender({ username: 'user', apiKey: 'k', from: { address: 'nope' } })).toThrow('SmartEmailing sender is invalid')
		expect(() => new SmartEmailingEmailSender({ username: 'user', apiKey: 'k', from, tag: 'no spaces' })).toThrow('SmartEmailing tag is invalid')
	})

	test('the provider reads its variables and names a bad one without its value', () => {
		const from = { address: 'auth@example.test' }
		const env = { FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'user', FABRIKA_EMAIL_SMARTEMAILING_API_KEY: 'se_secret', FABRIKA_EMAIL_SMARTEMAILING_TAG: '' }
		expect(smartEmailingEmailProvider.create({ from, env })).toBeInstanceOf(SmartEmailingEmailSender)

		const refused = (): unknown => smartEmailingEmailProvider.create({ from, env: { ...env, FABRIKA_EMAIL_SMARTEMAILING_USERNAME: 'private:user' } })
		expect(refused).toThrow('FABRIKA_EMAIL_SMARTEMAILING_USERNAME is missing or invalid')
		expect(refused).not.toThrow('private:user')
	})
})
