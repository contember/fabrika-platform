import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { EmailDeliveryError, type EmailFetch } from '../email.js'
import { lettermintEmailProvider, LettermintEmailSender } from '../lettermint.js'

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

describe('LettermintEmailSender', () => {
	test('sends the documented request with the project token', async () => {
		const { fetch, requests } = capturing(() => Response.json({ message_id: 'lm-1', status: 'pending' }, { status: 202 }))
		const sender = new LettermintEmailSender({ projectToken: 'lm_secret', from: { address: 'auth@example.test', name: 'Fabrika, s.r.o.' }, fetch })

		await expect(sender.send({ ...message, replyTo: 'help@example.test' }, signal)).resolves.toEqual({
			status: 'accepted',
			provider: 'lettermint',
			messageId: 'lm-1',
		})
		const request = requests[0]
		if (request === undefined) throw new Error('Expected a request')
		expect(request.url).toBe('https://api.lettermint.co/v1/send')
		expect(request.headers.get('x-lettermint-token')).toBe('lm_secret')
		expect(request.headers.get('idempotency-key')).toBe('welcome/user-1')
		expect(await request.json()).toEqual({
			from: '"Fabrika, s.r.o." <auth@example.test>',
			to: ['ada@example.test'],
			subject: 'Welcome',
			text: 'Your account is ready.',
			reply_to: ['help@example.test'],
		})
	})

	test('a 409 is retried unless it says the key went with another payload', async () => {
		const answering = (text: unknown) => capturing(() => Response.json(text, { status: 409 })).fetch
		const send = (fetch: EmailFetch) => caught(new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch }).send(message, signal))

		const conflict = await send(answering({ message: 'This idempotency key has already been used on a request with a different payload.' }))
		expect((await send(answering({ message: 'Payload mismatch for this key' }))).code).toBe('idempotency_conflict')
		expect([conflict.code, conflict.httpStatus, conflict.retryable]).toEqual(['idempotency_conflict', 409, false])
		for (
			const body of [{ message: 'Another request with the same idempotency key is currently being processed.' }, { message: 'reworded' }, 'not json']
		) {
			const error = await send(answering(body))
			expect([error.code, error.retryable]).toEqual(['request_in_progress', true])
		}
	})

	test('a body shorter than three characters once trimmed is refused without a request, as Lettermint counts them', async () => {
		const { fetch, requests } = capturing(() => Response.json({ message_id: 'lm-3', status: 'pending' }, { status: 202 }))
		const sender = new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch })
		for (const text of ['ok', '😀a', '  a  ', 'ab ']) expect((await caught(sender.send({ ...message, text }, signal))).code).toBe('invalid_message')
		expect((await caught(sender.send({ ...message, html: '<b' }, signal))).code).toBe('invalid_message')
		expect(requests).toHaveLength(0)
		await sender.send({ ...message, text: 'žšč' }, signal)
		expect(requests).toHaveLength(1)
	})

	test('an accepted answer with an undocumented status still counts by its message id', async () => {
		const { fetch } = capturing(() => Response.json({ message_id: 'lm-4', status: 'processing' }, { status: 202 }))
		const result = await new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch }).send(message, signal)
		expect(result.messageId).toBe('lm-4')
	})

	test('a key over its 255 characters is sent as its digest', async () => {
		const { fetch, requests } = capturing(() => Response.json({ message_id: 'lm-2', status: 'pending' }, { status: 202 }))
		await new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch }).send({ ...message, idempotencyKey: 'k'.repeat(256) }, signal)
		expect(requests[0]?.headers.get('idempotency-key')).toMatch(/^sha256:[0-9a-f]{64}$/)
	})

	test('a broadcast message goes through the broadcast route, a transactional one through the default', async () => {
		const { fetch, requests } = capturing(() => Response.json({ message_id: 'lm-5', status: 'pending' }, { status: 202 }))
		await new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch }).send({
			...message,
			unsubscribeUrl: 'https://app.example.test/u?t=1',
			broadcast: true,
		}, signal)
		await new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch, broadcastRoute: 'news' }).send({
			...message,
			unsubscribeUrl: 'https://app.example.test/u?t=1',
			broadcast: true,
		}, signal)
		await new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch }).send(message, signal)
		const routes = await Promise.all(requests.map(async (request) => z.object({ route: z.string().optional() }).parse(await request.json()).route))
		expect(routes).toEqual(['broadcast', 'news', undefined])
		const env = { FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN: 'lm_secret', FABRIKA_EMAIL_LETTERMINT_BROADCAST_ROUTE: 'news' }
		expect(lettermintEmailProvider.create({ from, env })).toBeInstanceOf(LettermintEmailSender)
	})

	test('a route the project lacks is a rejection that says how to fix it', async () => {
		const { fetch } = capturing(() => Response.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid route provided.' } }, { status: 422 }))
		const sender = new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch })
		const error = await caught(sender.send({ ...message, unsubscribeUrl: 'https://app.example.test/u', broadcast: true }, signal))
		expect([error.code, error.retryable]).toEqual(['provider_rejected', false])
		expect(error.message).toContain('FABRIKA_EMAIL_LETTERMINT_BROADCAST_ROUTE')
	})

	test('the provider reads its token and names a bad one without its value', () => {
		const env = { FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN: 'lm_secret' }
		expect(lettermintEmailProvider.create({ from, env })).toBeInstanceOf(LettermintEmailSender)

		const refused = (): unknown => lettermintEmailProvider.create({ from, env: { FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN: 'private token' } })
		expect(refused).toThrow('FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN is missing or invalid')
		expect(refused).not.toThrow('private token')
	})
})
