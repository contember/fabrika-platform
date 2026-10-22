import { describe, expect, test } from 'bun:test'
import { EmailDeliveryError, type EmailFetch } from '../email.js'
import { postmarkEmailProvider, PostmarkEmailSender } from '../postmark.js'

const signal = new AbortController().signal
const from = { address: 'auth@example.test' }
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

describe('PostmarkEmailSender', () => {
	test('sends the documented request with the server token and no idempotency key', async () => {
		const { fetch, requests } = capturing(() => Response.json({ To: 'ada@example.test', MessageID: 'pm-1', ErrorCode: 0, Message: 'OK' }))
		const sender = new PostmarkEmailSender({ serverToken: 'pm_secret', from: { address: 'auth@example.test', name: 'Fabrika' }, fetch })

		await expect(sender.send({ ...message, html: '<p>Ready.</p>' }, signal)).resolves.toEqual({
			status: 'accepted',
			provider: 'postmark',
			messageId: 'pm-1',
		})
		const request = requests[0]
		if (request === undefined) throw new Error('Expected a request')
		expect(request.url).toBe('https://api.postmarkapp.com/email')
		expect(request.headers.get('x-postmark-server-token')).toBe('pm_secret')
		expect(request.headers.get('accept')).toBe('application/json')
		expect(request.headers.get('idempotency-key')).toBeNull()
		expect(await request.json()).toEqual({
			From: 'Fabrika <auth@example.test>',
			To: 'ada@example.test',
			Subject: 'Welcome',
			TextBody: 'Your account is ready.',
			HtmlBody: '<p>Ready.</p>',
		})
	})

	test('writes the one-click unsubscribe as two Name/Value headers', async () => {
		const { fetch, requests } = capturing(() => Response.json({ MessageID: 'pm-2', ErrorCode: 0 }))
		const sender = new PostmarkEmailSender({ serverToken: 'pm_secret', from, fetch })

		await sender.send({ ...message, unsubscribeUrl: 'https://app.example.test/u?t=1' }, signal)
		const body: unknown = await requests[0]?.json()
		expect(body).toMatchObject({
			Headers: [
				{ Name: 'List-Unsubscribe', Value: '<https://app.example.test/u?t=1>' },
				{ Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
			],
		})
	})

	test('an inactive recipient is a permanent rejection, and a 200 with an error code is no success', async () => {
		const inactive = capturing(() => Response.json({ ErrorCode: 406, Message: 'private: ada@example.test is inactive' }, { status: 422 }))
		const rejected = await caught(new PostmarkEmailSender({ serverToken: 'pm_secret', from, fetch: inactive.fetch }).send(message, signal))
		expect([rejected.code, rejected.httpStatus]).toEqual(['provider_rejected', 422])
		expect(rejected.message).not.toContain('ada@example.test')

		const odd = capturing(() => Response.json({ MessageID: 'pm-3', ErrorCode: 300 }))
		const malformed = await caught(new PostmarkEmailSender({ serverToken: 'pm_secret', from, fetch: odd.fetch }).send(message, signal))
		expect(malformed.code).toBe('malformed_response')
	})

	test('the provider reads its token and names a bad one without its value', () => {
		const env = { FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: 'pm_secret' }
		expect(postmarkEmailProvider.create({ from, env })).toBeInstanceOf(PostmarkEmailSender)

		const refused = (): unknown => postmarkEmailProvider.create({ from, env: { FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: 'private token' } })
		expect(refused).toThrow('FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN is missing or invalid')
		expect(refused).not.toThrow('private token')
	})
})
