// The platform transport's mail wire: the request a sender encodes is the one the relay parses back, the parser ends in
// the package's own validation, and the answer carries an error code with its status both ways.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import type { EmailMessage } from '../email'
import {
	encodePlatformMailRequest,
	parsePlatformMailAnswer,
	parsePlatformMailRequest,
	PLATFORM_MAIL_CAPABILITIES,
	PLATFORM_MAIL_ERROR_STATUS,
	platformMailAnswerResponse,
	platformMailFingerprint,
} from '../platform'

const message: EmailMessage = {
	to: 'ada@example.com',
	subject: 'Your invoice',
	text: 'See the attachment.',
	html: '<p>See the attachment.</p>',
	idempotencyKey: 'invoice:42',
	replyTo: 'billing@example.com',
	fromName: 'Billing',
	unsubscribeUrl: 'https://notes.example/unsubscribe?t=abc',
	attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: new Uint8Array([0, 1, 2, 250, 255]) }],
}

const minimal: EmailMessage = { to: 'ada@example.com', subject: 'Hi', text: 'Hello.', idempotencyKey: 'k1' }

const body = (value: EmailMessage): Record<string, unknown> => z.record(z.string(), z.unknown()).parse(JSON.parse(encodePlatformMailRequest(value)))

describe('the request', () => {
	test('round-trips every field, attachments as base64', () => {
		const wire = body(message)
		expect(wire).toMatchObject({ attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', contentBase64: 'AAEC+v8=' }] })
		expect(parsePlatformMailRequest(wire)).toEqual({ ok: true, message })
		expect(parsePlatformMailRequest(body(minimal))).toEqual({ ok: true, message: minimal })
	})

	test('leaves absent optional fields and an empty attachment list out', () => {
		expect(encodePlatformMailRequest({ ...minimal, attachments: [] })).toBe(encodePlatformMailRequest(minimal))
		expect(Object.keys(JSON.parse(encodePlatformMailRequest(minimal)))).toEqual(['to', 'subject', 'text', 'idempotencyKey'])
	})

	test('refuses what the package validation refuses, with a reason that names no content', () => {
		const refusals: unknown[] = [
			{ ...body(minimal), to: 'not an address' },
			{ ...body(minimal), subject: '' },
			{ ...body(minimal), text: '   ' },
			{ ...body(minimal), idempotencyKey: 'has space' },
			{ ...body(minimal), unsubscribeUrl: 'http://notes.example/u' },
			{ ...body(minimal), attachments: [{ filename: 'a/b', contentType: 'text/plain', contentBase64: '' }] },
		]
		for (const refused of refusals) {
			const result = parsePlatformMailRequest(refused)
			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.code).toBe('invalid_message')
				expect(result.reason).not.toContain('ada@')
			}
		}
	})

	test('refuses a malformed body: a missing or mistyped field, an unknown field, a body that is no object, bad base64', () => {
		const { to: _to, ...withoutTo } = { ...minimal }
		for (
			const malformed of [
				null,
				'text',
				[],
				withoutTo,
				{ ...body(minimal), text: 1 },
				{ ...body(minimal), cc: 'eve@example.com' },
				{ ...body(minimal), attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'not base64!' }] },
				{ ...body(minimal), attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'AAE' }] },
				{ ...body(minimal), attachments: [{ filename: 'a.txt', contentType: 'text/plain', contentBase64: 'AA=A' }] },
				{ ...body(minimal), attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: 'AAEC' }] },
			]
		) {
			expect(parsePlatformMailRequest(malformed)).toEqual({ ok: false, code: 'invalid_message', reason: 'Platform mail request is malformed' })
		}
	})

	test('refuses attachments over the relay limit', () => {
		const limit = PLATFORM_MAIL_CAPABILITIES.maxAttachmentBytes ?? 0
		const big: EmailMessage = {
			...minimal,
			attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', content: new Uint8Array(limit + 1) }],
		}
		const result = parsePlatformMailRequest(body(big))
		expect(result.ok).toBe(false)
		const fits: EmailMessage = {
			...minimal,
			attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', content: new Uint8Array(limit) }],
		}
		expect(parsePlatformMailRequest(body(fits)).ok).toBe(true)
	})

	test('the capabilities are the ones the relay promises', () => {
		expect(PLATFORM_MAIL_CAPABILITIES).toEqual({
			idempotent: true,
			confirmation: 'queued',
			maxBatch: 1,
			listUnsubscribe: true,
			maxAttachmentBytes: 10 * 1024 * 1024,
		})
	})
})

describe('the fingerprint', () => {
	test('is the SHA-256 hex of the canonical body, the same for the same content whatever the key order', async () => {
		const fingerprint = await platformMailFingerprint(message)
		expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
		expect(fingerprint).toBe(new Bun.CryptoHasher('sha256').update(encodePlatformMailRequest(message)).digest('hex'))
		const reordered = parsePlatformMailRequest(Object.fromEntries(Object.entries(body(message)).reverse()))
		expect(reordered.ok && (await platformMailFingerprint(reordered.message))).toBe(fingerprint)
	})

	test('differs when anything the recipient sees differs', async () => {
		const fingerprint = await platformMailFingerprint(message)
		const variants: EmailMessage[] = [
			{ ...message, to: 'bob@example.com' },
			{ ...message, html: undefined },
			{ ...message, attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: new Uint8Array([0]) }] },
		]
		for (const variant of variants) {
			expect(await platformMailFingerprint(variant)).not.toBe(fingerprint)
		}
	})
})

describe('the answer', () => {
	test('an acceptance is 200 and reads back', async () => {
		const response = platformMailAnswerResponse({ status: 'accepted', messageId: 'm-1' })
		expect(response.status).toBe(200)
		expect(parsePlatformMailAnswer(response.status, await response.json())).toEqual({ status: 'accepted', messageId: 'm-1' })
	})

	test('each error has its status and reads back with its code', async () => {
		expect(PLATFORM_MAIL_ERROR_STATUS).toEqual({
			invalid_message: 400,
			provider_unauthorized: 401,
			idempotency_conflict: 409,
			provider_unavailable: 503,
		})
		for (const code of ['invalid_message', 'provider_unauthorized', 'idempotency_conflict', 'provider_unavailable'] as const) {
			const response = platformMailAnswerResponse({ error: { code } })
			expect(response.status).toBe(PLATFORM_MAIL_ERROR_STATUS[code])
			expect(parsePlatformMailAnswer(response.status, await response.json())).toEqual({ error: { code } })
		}
	})

	test('reads any delivery error code a relay answers', () => {
		expect(parsePlatformMailAnswer(429, { error: { code: 'rate_limited' } })).toEqual({ error: { code: 'rate_limited' } })
	})

	test('is null for anything the relay does not write', () => {
		const cases: [number, unknown][] = [
			[200, { error: { code: 'invalid_message' } }],
			[200, { status: 'accepted' }],
			[200, { status: 'accepted', messageId: '' }],
			[201, { status: 'accepted', messageId: 'm-1' }],
			[503, { status: 'accepted', messageId: 'm-1' }],
			[400, { error: { code: 'no_such_code' } }],
			[400, { error: { code: 'toString' } }],
			[502, undefined],
			[500, 'internal error'],
		]
		for (const [status, value] of cases) expect(parsePlatformMailAnswer(status, value)).toBeNull()
	})
})
