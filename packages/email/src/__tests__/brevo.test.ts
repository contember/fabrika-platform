import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { brevoEmailProvider, BrevoEmailSender, brevoHtmlOfText, brevoIdempotencyKey } from '../brevo.js'
import { readEmailTransportConfig } from '../config.js'
import { EmailDeliveryError, type EmailFetch, mayRetryDelivery } from '../email.js'

const signal = new AbortController().signal
const from = { address: 'auth@example.test' }
const message = { to: 'ada@example.test', subject: 'Welcome', text: 'Your account is ready.', idempotencyKey: 'welcome/user-1' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

const accepted = (): Response => Response.json({ messageId: '<brevo-1@smtp-relay.mailin.fr>' }, { status: 201 })

describe('BrevoEmailSender', () => {
	test('sends the documented request with the API key and the key as a UUID', async () => {
		const { fetch, requests } = capturing(accepted)
		const sender = new BrevoEmailSender({ apiKey: 'xkeysib-secret', from: { address: 'auth@example.test', name: 'Fabrika' }, fetch })

		await expect(sender.send({ ...message, html: '<p>Ready.</p>', replyTo: 'help@example.test' }, signal)).resolves.toEqual({
			status: 'accepted',
			provider: 'brevo',
			messageId: '<brevo-1@smtp-relay.mailin.fr>',
		})
		const request = requests[0]
		if (request === undefined) throw new Error('Expected a request')
		expect(request.url).toBe('https://api.brevo.com/v3/smtp/email')
		expect(request.method).toBe('POST')
		expect(request.headers.get('api-key')).toBe('xkeysib-secret')
		expect(request.headers.get('content-type')).toBe('application/json')
		expect(await request.json()).toEqual({
			sender: { email: 'auth@example.test', name: 'Fabrika' },
			to: [{ email: 'ada@example.test' }],
			subject: 'Welcome',
			htmlContent: '<p>Ready.</p>',
			textContent: 'Your account is ready.',
			replyTo: { email: 'help@example.test' },
			headers: { idempotencyKey: await brevoIdempotencyKey('welcome/user-1') },
		})
	})

	test('one key is always one UUID, and another key another', async () => {
		const first = await brevoIdempotencyKey('welcome/user-1')
		expect(first).toMatch(UUID)
		expect(await brevoIdempotencyKey('welcome/user-1')).toBe(first)
		expect(await brevoIdempotencyKey('welcome/user-2')).not.toBe(first)
		expect(await brevoIdempotencyKey('x'.repeat(256))).toMatch(UUID)
	})

	test('a text-only message carries its text, escaped, as the HTML body Brevo requires', async () => {
		const { fetch, requests } = capturing(accepted)
		await new BrevoEmailSender({ apiKey: 'xkeysib-secret', from, fetch }).send({ ...message, text: 'Hi <Ada> & "you"\nline two' }, signal)
		const body = z.object({ htmlContent: z.string(), textContent: z.string() }).parse(await requests[0]?.json())
		expect(body.textContent).toBe('Hi <Ada> & "you"\nline two')
		expect(body.htmlContent).toBe('Hi &lt;Ada&gt; &amp; &quot;you&quot;<br>\nline two')
		expect(brevoHtmlOfText("it's\r\nok")).toBe('it&#39;s<br>\nok')
	})

	test('a message sender name replaces the transport one, and a name over 70 characters is refused without a request', async () => {
		const { fetch, requests } = capturing(accepted)
		const sender = new BrevoEmailSender({ apiKey: 'xkeysib-secret', from: { address: 'auth@example.test', name: 'Fabrika' }, fetch })
		await sender.send({ ...message, fromName: 'Support' }, signal)
		expect(await requests[0]?.json()).toMatchObject({ sender: { email: 'auth@example.test', name: 'Support' } })

		expect((await caught(sender.send({ ...message, fromName: 'x'.repeat(71) }, signal))).code).toBe('invalid_message')
		expect(requests).toHaveLength(1)
		expect(() => new BrevoEmailSender({ apiKey: 'xkeysib-secret', from: { address: 'auth@example.test', name: 'x'.repeat(71) } })).toThrow(
			'Brevo sender name is longer than 70 characters',
		)
	})

	test('attachments go as name and base64 content, and a file type Brevo refuses is refused without a request', async () => {
		const { fetch, requests } = capturing(accepted)
		const sender = new BrevoEmailSender({ apiKey: 'xkeysib-secret', from, fetch })
		const withFile = (filename: string) => ({
			...message,
			attachments: [{ filename, contentType: 'application/pdf', content: new TextEncoder().encode('%PDF') }],
		})
		await sender.send(withFile('Invoice.PDF'), signal)
		expect(await requests[0]?.json()).toMatchObject({ attachment: [{ name: 'Invoice.PDF', content: 'JVBERg==' }] })
		for (const filename of ['setup.exe', 'invoice', 'data.bin']) {
			expect((await caught(sender.send(withFile(filename), signal))).code).toBe('invalid_message')
		}
		expect(requests).toHaveLength(1)
	})

	test('sends no unsubscribe headers and no broadcast', async () => {
		const { fetch, requests } = capturing(accepted)
		const sender = new BrevoEmailSender({ apiKey: 'xkeysib-secret', from, fetch })
		expect(sender.capabilities).toMatchObject({ idempotent: false, confirmation: 'sync', maxBatch: 1 })
		expect(sender.capabilities.listUnsubscribe ?? false).toBe(false)
		expect(sender.capabilities.broadcast ?? false).toBe(false)
		const unsubscribe = { ...message, unsubscribeUrl: 'https://app.example.test/u?t=1' }
		expect((await caught(sender.send(unsubscribe, signal))).code).toBe('invalid_message')
		expect((await caught(sender.send({ ...unsubscribe, broadcast: true }, signal))).code).toBe('invalid_message')
		expect(requests).toHaveLength(0)
	})

	test('a refusal is read by its status and code', async () => {
		const answer = (status: number, code?: string) =>
			capturing(() => code === undefined ? new Response('private outage', { status }) : Response.json({ code, message: `private ${code}` }, { status }))
				.fetch
		const send = (fetch: EmailFetch) => caught(new BrevoEmailSender({ apiKey: 'xkeysib-secret', from, fetch }).send(message, signal))
		const cases: readonly [number, string | undefined, string][] = [
			[400, 'invalid_parameter', 'provider_rejected'],
			[400, 'missing_parameter', 'provider_rejected'],
			[400, 'duplicate_parameter', 'idempotency_conflict'],
			[400, 'duplicate_request', 'idempotency_conflict'],
			[400, 'account_under_validation', 'provider_unauthorized'],
			[400, 'Insufficient credits', 'quota_exceeded'],
			[401, 'unauthorized', 'provider_unauthorized'],
			[401, undefined, 'provider_unauthorized'],
			[402, 'not_enough_credits', 'quota_exceeded'],
			[402, undefined, 'quota_exceeded'],
			[403, 'permission_denied', 'provider_unauthorized'],
			[404, 'document_not_found', 'provider_rejected'],
			[429, 'too_many_requests', 'rate_limited'],
			[500, undefined, 'provider_unavailable'],
			[503, 'unavailable', 'provider_unavailable'],
		]
		for (const [status, code, expected] of cases) {
			const error = await send(answer(status, code))
			expect([status, code, error.code]).toEqual([status, code, expected])
			expect(error.message).not.toContain('private')
		}
	})

	test('the one retry rule leaves an unknown outcome to a person and retries what did not leave', async () => {
		const sender = new BrevoEmailSender({ apiKey: 'xkeysib-secret', from })
		const outage = await caught(
			new BrevoEmailSender({ apiKey: 'xkeysib-secret', from, fetch: capturing(() => new Response('', { status: 502 })).fetch }).send(message, signal),
		)
		const limited = await caught(
			new BrevoEmailSender({ apiKey: 'xkeysib-secret', from, fetch: capturing(() => new Response('', { status: 429 })).fetch }).send(message, signal),
		)
		expect(mayRetryDelivery(outage, sender.capabilities)).toBe(false)
		expect(mayRetryDelivery(limited, sender.capabilities)).toBe(true)
	})

	test('a 201 without a message id is a malformed answer', async () => {
		const error = await caught(
			new BrevoEmailSender({ apiKey: 'xkeysib-secret', from, fetch: capturing(() => Response.json({}, { status: 201 })).fetch }).send(message, signal),
		)
		expect(error.code).toBe('malformed_response')
	})

	test('the provider reads its key and names a bad one without its value', () => {
		expect(brevoEmailProvider.create({ from, env: { FABRIKA_EMAIL_BREVO_API_KEY: 'xkeysib-secret' } })).toBeInstanceOf(BrevoEmailSender)
		const refused = (): unknown => brevoEmailProvider.create({ from, env: { FABRIKA_EMAIL_BREVO_API_KEY: 'private key' } })
		expect(refused).toThrow('FABRIKA_EMAIL_BREVO_API_KEY is missing or invalid')
		expect(refused).not.toThrow('private key')
		expect(brevoEmailProvider.variables).toEqual([{ name: 'FABRIKA_EMAIL_BREVO_API_KEY', secret: true, required: true }])
	})

	test('an installation selects it by name, and its configuration is refused before any send', () => {
		const registry = { brevo: brevoEmailProvider }
		const env = { FABRIKA_EMAIL_PROVIDER: 'brevo', FABRIKA_EMAIL_FROM: 'auth@example.test', FABRIKA_EMAIL_BREVO_API_KEY: 'xkeysib-secret' }
		expect(readEmailTransportConfig(env, registry)).toMatchObject({ kind: 'provider', provider: 'brevo' })
		const refusal = (variables: Record<string, string>): unknown => readEmailTransportConfig({ ...env, ...variables }, registry)
		expect(() => refusal({ FABRIKA_EMAIL_BREVO_API_KEY: '' })).toThrow('FABRIKA_EMAIL_BREVO_API_KEY is missing')
		expect(() => refusal({ FABRIKA_EMAIL_FROM: '' })).toThrow('FABRIKA_EMAIL_FROM is missing')
		expect(() => refusal({ FABRIKA_EMAIL_FROM_NAME: 'x'.repeat(71) })).toThrow('Brevo sender name is longer than 70 characters')
		expect(() => refusal({ FABRIKA_EMAIL_FROM: `${'x'.repeat(71)} <auth@example.test>` })).toThrow('Brevo sender name is longer than 70 characters')
	})
})
