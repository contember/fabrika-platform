import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
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

	test('an attachment of a file type Postmark refuses is refused without a request', async () => {
		const { fetch, requests } = capturing(() => Response.json({ MessageID: 'pm-4', ErrorCode: 0 }))
		const sender = new PostmarkEmailSender({ serverToken: 'pm_secret', from, fetch })
		const withFile = (filename: string) => ({
			...message,
			attachments: [{ filename, contentType: 'application/octet-stream', content: new Uint8Array([1]) }],
		})
		for (const filename of ['setup.exe', 'data.BIN', 'invoice.pdf.vbs']) {
			expect((await caught(sender.send(withFile(filename), signal))).code).toBe('invalid_message')
		}
		expect(requests).toHaveLength(0)
		await sender.send(withFile('data.dat'), signal)
		await sender.send(withFile('exe'), signal)
		expect(requests).toHaveLength(2)
	})

	test('a refusal is read by its ErrorCode: out of credits is a quota, a sender or account not allowed is unauthorized', async () => {
		const answer = (code: number) => capturing(() => Response.json({ ErrorCode: code, Message: `private detail ${code}` }, { status: 422 })).fetch
		const send = (fetch: EmailFetch) => caught(new PostmarkEmailSender({ serverToken: 'pm_secret', from, fetch }).send(message, signal))
		const credits = await send(answer(405))
		expect([credits.code, credits.retryable, credits.outcome]).toEqual(['quota_exceeded', true, 'not_sent'])
		for (const code of [400, 401, 412, 413]) expect((await send(answer(code))).code).toBe('provider_unauthorized')
		for (const code of [300, 406, 411]) expect((await send(answer(code))).code).toBe('provider_rejected')
		expect((await send(answer(405))).message).not.toContain('private detail')
	})

	test('a broadcast message goes through the broadcast stream, a transactional one through the default', async () => {
		const { fetch, requests } = capturing(() => Response.json({ MessageID: 'pm-5', ErrorCode: 0 }))
		await new PostmarkEmailSender({ serverToken: 'pm_secret', from, fetch }).send({
			...message,
			unsubscribeUrl: 'https://app.example.test/u?t=1',
			broadcast: true,
		}, signal)
		await new PostmarkEmailSender({ serverToken: 'pm_secret', from, fetch, broadcastStream: 'newsletters' }).send({
			...message,
			unsubscribeUrl: 'https://app.example.test/u?t=1',
			broadcast: true,
		}, signal)
		await new PostmarkEmailSender({ serverToken: 'pm_secret', from, fetch }).send(message, signal)
		const streams = await Promise.all(
			requests.map(async (request) => z.object({ MessageStream: z.string().optional() }).parse(await request.json()).MessageStream),
		)
		expect(streams).toEqual(['broadcast', 'newsletters', undefined])
		expect(() => new PostmarkEmailSender({ serverToken: 'pm_secret', from, broadcastStream: 'bad stream' })).toThrow(
			'Postmark broadcast stream is invalid',
		)
		const env = { FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: 'pm_secret', FABRIKA_EMAIL_POSTMARK_BROADCAST_STREAM: 'private stream' }
		expect(() => postmarkEmailProvider.create({ from, env })).toThrow('FABRIKA_EMAIL_POSTMARK_BROADCAST_STREAM is missing or invalid')
	})

	test('the provider reads its token and names a bad one without its value', () => {
		const env = { FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: 'pm_secret' }
		expect(postmarkEmailProvider.create({ from, env })).toBeInstanceOf(PostmarkEmailSender)

		const refused = (): unknown => postmarkEmailProvider.create({ from, env: { FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN: 'private token' } })
		expect(refused).toThrow('FABRIKA_EMAIL_POSTMARK_SERVER_TOKEN is missing or invalid')
		expect(refused).not.toThrow('private token')
	})
})
