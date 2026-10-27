// The platform sender's own contract beside the conformance kit: where it posts, with which credential, and which
// receiver URLs and keys it refuses before any request.

import { describe, expect, test } from 'bun:test'
import { EmailDeliveryError, type EmailFetch } from '../email.js'
import {
	encodePlatformMailRequest,
	installationMailKey,
	installationMailSender,
	PlatformEmailSender,
	platformMailAnswerResponse,
} from '../platform.js'

const KEY = 'px_unit_secret_31f0'
const message = { to: 'ada@example.com', subject: 'Welcome', text: 'Hello Ada', idempotencyKey: 'fabrika:abc:n-1' }

function recording(): { readonly fetch: EmailFetch; readonly requests: Request[] } {
	const requests: Request[] = []
	return {
		requests,
		fetch: (input, init) => {
			requests.push(new Request(input, init))
			return Promise.resolve(platformMailAnswerResponse({ status: 'accepted', messageId: 'm-1' }))
		},
	}
}

describe('PlatformEmailSender', () => {
	test("posts the canonical body to the relay's send path under the bearer key", async () => {
		const { fetch, requests } = recording()
		const sender = new PlatformEmailSender({ url: 'http://control:3000', key: KEY, fetch })
		expect(await sender.send(message, new AbortController().signal)).toEqual({ status: 'accepted', provider: 'platform', messageId: 'm-1' })
		const [request] = requests
		expect(request?.method).toBe('POST')
		expect(request?.url).toBe('http://control:3000/platform/mail/send')
		expect(request?.headers.get('authorization')).toBe(`Bearer ${KEY}`)
		expect(request?.headers.get('content-type')).toBe('application/json')
		expect(await request?.text()).toBe(encodePlatformMailRequest(message))
	})

	test.each([
		['a path', 'http://control:3000/base'],
		['a trailing slash', 'https://control.example/'],
		['credentials', 'http://user:pw@control:3000'],
		['another scheme', 'ftp://control:3000'],
		['no URL at all', 'control:3000'],
		['an empty value', ''],
	])('refuses a URL with %s as invalid_configuration', (_problem, url) => {
		expect(() => new PlatformEmailSender({ url, key: KEY })).toThrow(EmailDeliveryError)
		expect(() => new PlatformEmailSender({ url, key: KEY })).toThrow(expect.objectContaining({ code: 'invalid_configuration' }))
	})

	test('refuses an empty key or one with a space, and the refusal holds no key', () => {
		for (const key of ['', 'px with space']) {
			let refusal: unknown
			try {
				new PlatformEmailSender({ url: 'http://control:3000', key })
			} catch (error) {
				refusal = error
			}
			expect(refusal).toMatchObject({ code: 'invalid_configuration' })
			if (key !== '') expect(JSON.stringify(refusal) + String(refusal)).not.toContain(key)
		}
	})
})

describe('installationMailSender', () => {
	test('posts under the key derived from the secret, and derives it once', async () => {
		const { fetch, requests } = recording()
		const sender = installationMailSender({ url: 'https://control.example', secret: 'installation-secret', fetch })
		await sender.send(message, new AbortController().signal)
		await sender.send({ ...message, idempotencyKey: 'fabrika:abc:n-2' }, new AbortController().signal)
		const key = await installationMailKey('installation-secret')
		expect(requests.map((request) => [request.url, request.headers.get('authorization')])).toEqual([
			['https://control.example/platform/mail/send', `Bearer ${key}`],
			['https://control.example/platform/mail/send', `Bearer ${key}`],
		])
	})

	test('a URL that is not an origin fails each send as invalid_configuration, not once for good', async () => {
		const { fetch, requests } = recording()
		const sender = installationMailSender({ url: 'https://control.example/', secret: 'installation-secret', fetch })
		for (let attempt = 0; attempt < 2; attempt++) {
			const refusal = await sender.send(message, new AbortController().signal).then(() => undefined, (error: unknown) => error)
			expect(refusal).toMatchObject({ code: 'invalid_configuration' })
		}
		expect(requests).toEqual([])
	})
})
