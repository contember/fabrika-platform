import { describe, expect, test } from 'bun:test'
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

	test('a 409 without a code is a conflict that is not retried', async () => {
		const { fetch } = capturing(() => Response.json({ message: 'private: the key was used with a different payload' }, { status: 409 }))
		const error = await caught(new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch }).send(message, signal))
		expect([error.code, error.httpStatus, error.retryable]).toEqual(['idempotency_conflict', 409, false])
	})

	test('a body shorter than three characters is refused without a request', async () => {
		const { fetch, requests } = capturing(() => Response.json({ message_id: 'lm-3', status: 'pending' }, { status: 202 }))
		const sender = new LettermintEmailSender({ projectToken: 'lm_secret', from, fetch })
		expect((await caught(sender.send({ ...message, text: 'ok' }, signal))).code).toBe('invalid_message')
		expect((await caught(sender.send({ ...message, html: '<b' }, signal))).code).toBe('invalid_message')
		expect(requests).toHaveLength(0)
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

	test('the provider reads its token and names a bad one without its value', () => {
		const env = { FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN: 'lm_secret' }
		expect(lettermintEmailProvider.create({ from, env })).toBeInstanceOf(LettermintEmailSender)

		const refused = (): unknown => lettermintEmailProvider.create({ from, env: { FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN: 'private token' } })
		expect(refused).toThrow('FABRIKA_EMAIL_LETTERMINT_PROJECT_TOKEN is missing or invalid')
		expect(refused).not.toThrow('private token')
	})
})
