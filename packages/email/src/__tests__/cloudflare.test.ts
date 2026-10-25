import { describe, expect, test } from 'bun:test'
import { cloudflareEmailProvider, CloudflareEmailSender } from '../cloudflare.js'
import { EmailDeliveryError, type EmailDeliveryErrorCode, type EmailFetch } from '../email.js'

const signal = new AbortController().signal
const from = { address: 'auth@example.test' }
const ACCOUNT_ID = '023e105f4ecef8ad9ca31a8372d0c353'
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

function accepted(result: Record<string, unknown>): Response {
	return Response.json({
		success: true,
		errors: [],
		messages: [],
		result: { delivered: ['ada@example.test'], permanent_bounces: [], queued: [], ...result },
	})
}

function refused(status: number, code: number, text: string): Response {
	return Response.json({ success: false, errors: [{ code, message: text }], messages: [], result: null }, { status })
}

function sender(fetch: EmailFetch): CloudflareEmailSender {
	return new CloudflareEmailSender({ apiToken: 'cf_secret', accountId: ACCOUNT_ID, from, fetch })
}

describe('CloudflareEmailSender', () => {
	test("sends the documented request to the account's Email Sending, with no idempotency key", async () => {
		const { fetch, requests } = capturing(() => accepted({ message_id: '<cf-1@example.test>' }))
		const named = new CloudflareEmailSender({
			apiToken: 'cf_secret',
			accountId: ACCOUNT_ID,
			from: { address: 'auth@example.test', name: 'Fabrika' },
			fetch,
		})

		await expect(named.send({ ...message, html: '<p>Ready.</p>', replyTo: 'help@example.test' }, signal)).resolves.toEqual({
			status: 'accepted',
			provider: 'cloudflare',
			messageId: '<cf-1@example.test>',
		})
		const request = requests[0]
		if (request === undefined) throw new Error('Expected a request')
		expect(request.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/email/sending/send`)
		expect(request.headers.get('authorization')).toBe('Bearer cf_secret')
		expect(request.headers.get('idempotency-key')).toBeNull()
		expect(await request.json()).toEqual({
			from: { address: 'auth@example.test', name: 'Fabrika' },
			to: 'ada@example.test',
			subject: 'Welcome',
			text: 'Your account is ready.',
			html: '<p>Ready.</p>',
			reply_to: 'help@example.test',
		})
	})

	test('writes the one-click unsubscribe as headers and attachments as base64 with their type', async () => {
		const { fetch, requests } = capturing(() => accepted({ message_id: '<cf-2@example.test>' }))
		await sender(fetch).send({
			...message,
			fromName: 'Billing',
			unsubscribeUrl: 'https://app.example.test/u?t=1',
			attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: new Uint8Array([37, 80, 68, 70]) }],
		}, signal)
		expect(await requests[0]?.json()).toMatchObject({
			from: { address: 'auth@example.test', name: 'Billing' },
			headers: { 'List-Unsubscribe': '<https://app.example.test/u?t=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
			attachments: [{ content: 'JVBERg==', filename: 'invoice.pdf', type: 'application/pdf', disposition: 'attachment' }],
		})
	})

	test('a recipient queued for later is accepted; one that bounced or is suppressed is a rejection without the address', async () => {
		const queued = capturing(() => accepted({ message_id: '<cf-3@example.test>', delivered: [], queued: ['ada@example.test'] }))
		expect((await sender(queued.fetch).send(message, signal)).messageId).toBe('<cf-3@example.test>')

		for (const result of [{ permanent_bounces: ['ada@example.test'] }, { suppressed_recipients: ['ada@example.test'] }]) {
			const answer = capturing(() => accepted({ message_id: '<cf-4@example.test>', delivered: [], ...result }))
			const error = await caught(sender(answer.fetch).send(message, signal))
			expect([error.code, error.httpStatus, error.outcome, error.retryable]).toEqual(['provider_rejected', 200, 'not_sent', false])
			expect(error.message).not.toContain('ada@example.test')
		}
	})

	test('a fresh send as a live account answered it: queued, with an angle-bracketed message ID', async () => {
		const live = capturing(() =>
			Response.json({
				success: true,
				errors: [],
				messages: [],
				result: {
					message_id: '<0a1b2c3d-live@notify.example.test>',
					delivered: [],
					queued: ['ada@example.test'],
					permanent_bounces: [],
					suppressed_recipients: [],
				},
			})
		)
		await expect(sender(live.fetch).send(message, signal)).resolves.toEqual({
			status: 'accepted',
			provider: 'cloudflare',
			messageId: '<0a1b2c3d-live@notify.example.test>',
		})
	})

	test('a 200 without a message ID counts by the recipient delivered or queued, under an ID derived from the key', async () => {
		for (const result of [{ delivered: ['ada@example.test'] }, { delivered: [], queued: ['Ada@Example.test'] }]) {
			const answer = capturing(() => Response.json({ success: true, errors: [], messages: [], result: { permanent_bounces: [], ...result } }))
			await expect(sender(answer.fetch).send(message, signal)).resolves.toEqual({
				status: 'accepted',
				provider: 'cloudflare',
				messageId: 'cloudflare:welcome/user-1',
			})
		}
		const bounced = capturing(() => Response.json({ success: true, result: { delivered: [], permanent_bounces: ['ada@example.test'] } }))
		expect((await caught(sender(bounced.fetch).send(message, signal))).code).toBe('provider_rejected')
	})

	test('a 200 that names neither a message ID nor the recipient, or with success false, is no success', async () => {
		const bodies = [
			{ success: true, result: { delivered: [], queued: [], permanent_bounces: [] } },
			{ success: true, result: { delivered: ['someone-else@example.test'] } },
			{ success: true, result: { message_id: '' } },
			{ success: false, result: { message_id: 'cf-5', delivered: ['ada@example.test'] } },
		]
		for (const body of bodies) {
			const odd = capturing(() => Response.json(body))
			expect((await caught(sender(odd.fetch).send(message, signal))).code).toBe('malformed_response')
		}
	})

	test("an unsubscribe URL whose header value passes Cloudflare's 2,048 bytes is refused before the request", async () => {
		const { fetch, requests } = capturing(() => accepted({ message_id: '<cf-7@example.test>' }))
		const url = (length: number): string => {
			const prefix = 'https://app.example.test/u?t='
			return prefix + 'a'.repeat(length - prefix.length)
		}
		const error = await caught(sender(fetch).send({ ...message, unsubscribeUrl: url(2047) }, signal))
		expect([error.code, error.message]).toEqual(['invalid_message', 'Email unsubscribe URL is invalid'])
		expect(requests).toHaveLength(0)
		await sender(fetch).send({ ...message, unsubscribeUrl: url(2046) }, signal)
		expect(requests).toHaveLength(1)
	})

	test('a refusal is classified by its status, and its text stays out', async () => {
		const send = async (status: number, code: number, text: string) =>
			caught(sender(capturing(() => refused(status, code, text)).fetch).send(message, signal))
		const cases: [number, number, string, EmailDeliveryErrorCode][] = [
			[400, 10001, 'email.sending.error.invalid_request_schema', 'provider_rejected'],
			[400, 10200, 'email.sending.error.email.too_big', 'provider_rejected'],
			[401, 10101, 'email.sending.error.authentication.unauthorized', 'provider_unauthorized'],
			[403, 10102, 'email.sending.error.authentication.forbidden', 'provider_unauthorized'],
			[403, 10203, 'email.sending.error.email.sending_disabled', 'provider_unauthorized'],
			[404, 10000, 'email.sending.error.not_found', 'provider_unauthorized'],
			[429, 10004, 'email.sending.error.throttled', 'rate_limited'],
			[500, 10002, 'email.sending.error.internal_server', 'provider_unavailable'],
			[503, 10100, 'email.sending.error.authentication.upstream', 'provider_unavailable'],
		]
		for (const [status, code, text, expected] of cases) {
			const error = await send(status, code, text)
			expect([error.code, error.httpStatus]).toEqual([expected, status])
			expect(error.message).not.toContain(text)
		}
	})

	test('it is not idempotent and sends no broadcast', async () => {
		const { fetch, requests } = capturing(() => accepted({ message_id: '<cf-6@example.test>' }))
		const cloudflare = sender(fetch)
		expect(cloudflare.capabilities).toEqual({
			idempotent: false,
			confirmation: 'sync',
			maxBatch: 1,
			listUnsubscribe: true,
			maxAttachmentBytes: 3 * 1024 * 1024,
		})
		const error = await caught(cloudflare.send({ ...message, unsubscribeUrl: 'https://app.example.test/u?t=1', broadcast: true }, signal))
		expect(error.code).toBe('invalid_message')
		expect(requests).toHaveLength(0)
	})

	test('the provider reads its variables and names a bad one without its value', () => {
		const env = { FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN: 'cf_secret', FABRIKA_EMAIL_CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }
		expect(cloudflareEmailProvider.create({ from, env })).toBeInstanceOf(CloudflareEmailSender)
		expect(cloudflareEmailProvider.variables.map((variable) => [variable.name, variable.secret, variable.required])).toEqual([
			['FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN', true, true],
			['FABRIKA_EMAIL_CLOUDFLARE_ACCOUNT_ID', false, true],
		])

		const refusedAccount = (): unknown => cloudflareEmailProvider.create({ from, env: { ...env, FABRIKA_EMAIL_CLOUDFLARE_ACCOUNT_ID: '../private' } })
		expect(refusedAccount).toThrow('FABRIKA_EMAIL_CLOUDFLARE_ACCOUNT_ID is missing or invalid')
		expect(refusedAccount).not.toThrow('../private')
		const refusedToken = (): unknown => cloudflareEmailProvider.create({ from, env: { ...env, FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN: 'a b' } })
		expect(refusedToken).toThrow('FABRIKA_EMAIL_CLOUDFLARE_API_TOKEN is missing or invalid')
		expect(() => new CloudflareEmailSender({ apiToken: 'cf_secret', accountId: 'a/b', from })).toThrow('Cloudflare account ID is invalid')
		expect(() => new CloudflareEmailSender({ apiToken: '', accountId: ACCOUNT_ID, from })).toThrow('Cloudflare API token is invalid')
	})
})
