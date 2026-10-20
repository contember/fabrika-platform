// IAM on Bun sends through Control's mail relay when it knows Control's origin and has delivery switched on, and
// otherwise keeps its own provider (or none, with the manual action-link flow).

import { installationMailKey, PLATFORM_MAIL_SEND_PATH, PlatformEmailSender } from '@fabrika/email/platform'
import { ResendEmailSender } from '@fabrika/email/resend'
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createRuntime } from '../node/runtime'
import { buildServices } from '../services'

const RPC_KEY = 'rpc-key-with-at-least-thirty-two-characters'
const CONTROL_URL = 'http://control:3000'

const base = {
	FABRIKA_IAM_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:1/iam',
	ENVIRONMENT: 'stage',
	ISSUER: 'https://iam.example.com',
	FABRIKA_IAM_OIDC_ENABLED: 'false',
	FABRIKA_IAM_PASSWORD_ENABLED: 'true',
	FABRIKA_IAM_RPC_KEY: RPC_KEY,
}
const resend = {
	FABRIKA_EMAIL_PROVIDER: 'resend',
	FABRIKA_EMAIL_FROM: 'Fabrika <auth@example.com>',
	FABRIKA_EMAIL_RESEND_API_KEY: 'private-resend-key',
}
const message = { to: 'ada@example.com', subject: 'Reset', text: 'Open the link', idempotencyKey: 'iam-reset-1' }

interface RecordedRequest {
	readonly url: string
	readonly authorization: string | null
	readonly body: unknown
}

/** Answers every request as the relay accepting it, and records what was asked. */
function stubRelay(): RecordedRequest[] {
	const requests: RecordedRequest[] = []
	const relay = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init)
		requests.push({ url: request.url, authorization: request.headers.get('Authorization'), body: await request.json() })
		return Response.json({ status: 'accepted', messageId: 'relay-message-1' })
	}
	spyOn(globalThis, 'fetch').mockImplementation(Object.assign(relay, { preconnect: fetch.preconnect }))
	return requests
}

afterEach(() => {
	mock.restore()
})

describe("IAM's mail through the platform relay", () => {
	test('with a provider and FABRIKA_CONTROL_URL, a message goes to the relay under the derived installation key', async () => {
		const requests = stubRelay()
		const runtime = await createRuntime({ ...base, ...resend, FABRIKA_CONTROL_URL: CONTROL_URL })
		try {
			const sender = buildServices(runtime.env).email
			expect(sender).toBeInstanceOf(PlatformEmailSender)
			const result = await sender?.send(message, AbortSignal.timeout(5_000))
			expect(result).toEqual({ status: 'accepted', provider: 'platform', messageId: 'relay-message-1' })
			expect(requests).toEqual([{
				url: `${CONTROL_URL}${PLATFORM_MAIL_SEND_PATH}`,
				authorization: `Bearer ${await installationMailKey(RPC_KEY)}`,
				body: message,
			}])
		} finally {
			await runtime.shutdown()
		}
	})

	test("without FABRIKA_CONTROL_URL, IAM keeps its provider's sender", async () => {
		const runtime = await createRuntime({ ...base, ...resend })
		try {
			expect(buildServices(runtime.env).email).toBeInstanceOf(ResendEmailSender)
		} finally {
			await runtime.shutdown()
		}
	})

	test('without a provider, FABRIKA_CONTROL_URL changes nothing: there is no sender and the action link is handed over', async () => {
		for (const provider of [{}, { FABRIKA_EMAIL_PROVIDER: 'none' }]) {
			const runtime = await createRuntime({ ...base, ...provider, FABRIKA_CONTROL_URL: CONTROL_URL })
			try {
				expect(buildServices(runtime.env).email).toBeNull()
			} finally {
				await runtime.shutdown()
			}
		}
	})

	test('a FABRIKA_CONTROL_URL that is not an http(s) origin refuses the boot, with or without a provider', async () => {
		for (const url of ['control:3000', 'http://control:3000/', 'http://control:3000/platform', 'ftp://control:3000', 'not a url']) {
			await expect(createRuntime({ ...base, ...resend, FABRIKA_CONTROL_URL: url })).rejects.toThrow('FABRIKA_CONTROL_URL must be an http(s) origin')
			await expect(createRuntime({ ...base, FABRIKA_CONTROL_URL: url })).rejects.toThrow('FABRIKA_CONTROL_URL must be an http(s) origin')
		}
	})

	test('the relay needs the installation secret its key is derived from', async () => {
		await expect(createRuntime({ ...base, ...resend, FABRIKA_IAM_RPC_KEY: '', FABRIKA_CONTROL_URL: CONTROL_URL })).rejects.toThrow(
			'FABRIKA_CONTROL_URL needs FABRIKA_IAM_RPC_KEY',
		)
	})
})
