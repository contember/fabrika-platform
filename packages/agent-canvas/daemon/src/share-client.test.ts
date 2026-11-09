import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
	answeredResponses,
	createShare,
	decryptFeedbackEntry,
	decryptString,
	encryptString,
	fetchShareFeedback,
	generateShareKey,
	importShareKey,
	revokeShareOnWorker,
	type SharedFeedbackEntry,
	type SharedResponse,
	ShareGoneError,
	type SharePayload,
	type WireFeedbackEntry,
} from './share-client'
import { stubFetch } from './stubFetch'

const payload: SharePayload = {
	version: 1,
	origin: { sessionId: 'session-1', revision: 2, label: 'Draft', createdAt: '2026-01-01T00:00:00Z' },
	canvasFiles: [{ filename: 'plan.jsx', compiledJs: 'export default 1' }],
	runtime: { componentsVersion: '1.0.0' },
}

const originalFetch = globalThis.fetch
afterEach(() => {
	globalThis.fetch = originalFetch
})

function recordFetch(handler: () => Response): Array<{ url: string; init: RequestInit | undefined }> {
	const calls: Array<{ url: string; init: RequestInit | undefined }> = []
	stubFetch((url, init) => {
		calls.push({ url, init })
		return handler()
	})
	return calls
}

const sentBody = (call: { init: RequestInit | undefined } | undefined): unknown => JSON.parse(String(call?.init?.body))

describe('createShare', () => {
	test('encrypts by default and puts the key in the URL fragment', async () => {
		const calls = recordFetch(() =>
			Response.json({ shareId: 'abc123', url: 'https://share.test/s/abc123', ownerToken: 'owner', expiresAt: '2026-02-01T00:00:00Z' })
		)
		const share = await createShare(payload, { endpoint: 'https://share.test', authToken: 'token' })

		expect(share.shareId).toBe('abc123')
		expect(share.ownerToken).toBe('owner')
		expect(share.expiresAt).toBe('2026-02-01T00:00:00Z')
		expect(share.url).toBe(`https://share.test/s/abc123#k=${share.encryptionKey}`)
		expect(calls[0]?.url).toBe('https://share.test/shares')
		expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe('Bearer token')

		const sent = sentBody(calls[0])
		expect(sent).toMatchObject({ encryption: { alg: 'AES-GCM', v: 1 }, canvasFiles: [{ filename: 'plan.jsx' }] })
		expect(JSON.stringify(sent)).not.toContain('export default')
		expect(JSON.stringify(sent)).not.toContain('session-1')
		const key = await importShareKey(share.encryptionKey ?? '')
		const compiled = z.object({ canvasFiles: z.array(z.object({ compiledJs: z.string() })) }).parse(sent).canvasFiles[0]?.compiledJs ?? ''
		expect(await decryptString(key, compiled)).toBe('export default 1')
	})

	test('sends plaintext only when encryption is turned off', async () => {
		const calls = recordFetch(() => Response.json({ shareId: 'abc123', url: 'https://share.test/s/abc123' }))
		const share = await createShare(payload, { endpoint: 'https://share.test', encryption: false })
		expect(share).toEqual({ shareId: 'abc123', url: 'https://share.test/s/abc123' })
		expect(sentBody(calls[0])).toEqual(payload)
	})

	test('fails on an error status or a response that is not a share', async () => {
		recordFetch(() => new Response('too many', { status: 429 }))
		await expect(createShare(payload, { endpoint: 'https://share.test' })).rejects.toThrow('429')
		recordFetch(() => Response.json({ url: 'https://share.test/s/x' }))
		await expect(createShare(payload, { endpoint: 'https://share.test' })).rejects.toThrow('invalid response')
	})
})

describe('revokeShareOnWorker', () => {
	test('sends the owner token and fails when the worker refuses', async () => {
		const calls = recordFetch(() => Response.json({ ok: true }))
		await revokeShareOnWorker('https://share.test', 'abc123', 'owner')
		expect(calls[0]?.url).toBe('https://share.test/shares/abc123/revoke')
		expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe('Bearer owner')

		recordFetch(() => Response.json({ error: 'Unauthorized' }, { status: 401 }))
		await expect(revokeShareOnWorker('https://share.test', 'abc123', 'wrong')).rejects.toThrow('401')
	})
})

const wireEntry = (overrides: Partial<WireFeedbackEntry> = {}): WireFeedbackEntry => ({
	id: 'e1',
	shareId: 'abc123',
	revision: 1,
	submittedAt: '2026-01-02T00:00:00Z',
	author: { id: 'r1', name: 'Reviewer' },
	annotations: [],
	...overrides,
})

describe('fetchShareFeedback', () => {
	test('passes `since`, returns the page and skips malformed entries', async () => {
		const calls = recordFetch(() =>
			Response.json({ entries: [wireEntry(), { id: 'bad', revision: 'one' }, 'garbage'], latestAt: '2026-01-02T00:00:00Z' })
		)
		const page = await fetchShareFeedback('https://share.test', 'abc123', '2026-01-01T00:00:00Z')
		expect(page).toEqual({ entries: [wireEntry()], malformed: ['bad', '(no id)'], latestAt: '2026-01-02T00:00:00Z' })
		expect(calls[0]?.url).toBe('https://share.test/shares/abc123/feedback?since=2026-01-01T00%3A00%3A00Z')
	})

	test('a missing share is ShareGoneError; other failures are plain errors', async () => {
		recordFetch(() => Response.json({ error: 'Not found' }, { status: 404 }))
		await expect(fetchShareFeedback('https://share.test', 'abc123', '')).rejects.toBeInstanceOf(ShareGoneError)
		recordFetch(() => new Response('down', { status: 503 }))
		await expect(fetchShareFeedback('https://share.test', 'abc123', '')).rejects.toThrow('HTTP 503')
		recordFetch(() => Response.json({ entries: 'nope' }))
		await expect(fetchShareFeedback('https://share.test', 'abc123', '')).rejects.toThrow('invalid response')
	})
})

describe('decryptFeedbackEntry', () => {
	const responses: SharedResponse[] = [
		{ id: 'db', type: 'radio', label: 'Which database?', value: 'pg', note: 'for now' },
		{ id: 'envs', type: 'checkbox', label: 'Envs', value: ['stage', 'prod'] },
	]
	const context = { before: '', after: '', hierarchy: ['Section', 'Item'] }

	async function encryptedEntry(key: CryptoKey): Promise<WireFeedbackEntry> {
		return wireEntry({
			author: { id: 'r1', name: await encryptString(key, 'Reviewer') },
			annotations: [{
				id: 'a1',
				snippet: await encryptString(key, 'quoted'),
				note: await encryptString(key, 'comment'),
				createdAt: '2026-01-02T00:00:00Z',
				context: await encryptString(key, JSON.stringify(context)),
			}],
			generalNote: await encryptString(key, '## General notes'),
			responses: await encryptString(key, JSON.stringify(responses)),
			encryption: { alg: 'AES-GCM', v: 1 },
		})
	}

	test('decrypts every secret field, structured responses included', async () => {
		const key = await generateShareKey()
		expect(await decryptFeedbackEntry(await encryptedEntry(key), key)).toEqual({
			id: 'e1',
			shareId: 'abc123',
			revision: 1,
			submittedAt: '2026-01-02T00:00:00Z',
			author: { id: 'r1', name: 'Reviewer' },
			annotations: [{ id: 'a1', snippet: 'quoted', note: 'comment', createdAt: '2026-01-02T00:00:00Z', context }],
			generalNote: '## General notes',
			responses,
		})
	})

	test('passes a plaintext entry through, dropping a context that is not one', async () => {
		const expected: SharedFeedbackEntry = {
			...wireEntry(),
			annotations: [{ id: 'a1', snippet: 's', note: 'n', createdAt: '2026-01-02T00:00:00Z', context }],
			responses,
		}
		expect(await decryptFeedbackEntry(expected, null)).toEqual(expected)
		const garbled = wireEntry({ annotations: [{ id: 'a1', snippet: 's', note: 'n', createdAt: '2026-01-02T00:00:00Z', context: 'garbage' }] })
		expect((await decryptFeedbackEntry(garbled, null)).annotations).toEqual([{ id: 'a1', snippet: 's', note: 'n', createdAt: '2026-01-02T00:00:00Z' }])
	})

	test('refuses a missing or wrong key', async () => {
		const key = await generateShareKey()
		const entry = await encryptedEntry(key)
		await expect(decryptFeedbackEntry(entry, null)).rejects.toThrow('no key')
		await expect(decryptFeedbackEntry(entry, await generateShareKey())).rejects.toThrow()
	})

	test('leaves out responses that do not fit and keeps the rest of the entry', async () => {
		const key = await generateShareKey()
		const entry = await encryptedEntry(key)
		const kept = {
			annotations: [{ id: 'a1', snippet: 'quoted', note: 'comment', createdAt: '2026-01-02T00:00:00Z', context }],
			generalNote: '## General notes',
		}
		// A response type this version does not know, next to one it does.
		const newer = { ...entry, responses: await encryptString(key, JSON.stringify([{ id: 'x', type: 'slider', label: 'x', value: 1 }, responses[0]])) }
		expect(await decryptFeedbackEntry(newer, key)).toMatchObject({ ...kept, responses: [responses[0]], droppedResponses: 1 })
		// Plaintext responses in an encrypted entry, and ciphertext that does not open.
		for (const broken of [{ ...entry, responses }, { ...entry, responses: 'Y2lwaGVy' }]) {
			const opened = await decryptFeedbackEntry(broken, key)
			expect(opened).toMatchObject({ ...kept, droppedResponses: 1 })
			expect(opened.responses).toBeUndefined()
		}
		// Ciphertext in a plaintext entry.
		expect(await decryptFeedbackEntry(wireEntry({ responses: 'Y2lwaGVy' }), null)).toMatchObject({ droppedResponses: 1 })
	})
})

describe('answeredResponses', () => {
	test('keeps answered responses and notes in the wire shape', () => {
		const drafted = [
			{ id: 'db', type: 'radio', label: 'Which database?', value: 'pg', options: ['pg', 'sqlite'], required: true },
			{ id: 'envs', type: 'checkbox', label: 'Envs', value: [], note: '  none yet  ' },
			{ id: 'score', type: 'range', label: 'Score', value: 4 },
		]
		expect(answeredResponses(drafted)).toEqual([
			{ id: 'db', type: 'radio', label: 'Which database?', value: 'pg' },
			{ id: 'envs', type: 'checkbox', label: 'Envs', value: [], note: 'none yet' },
			{ id: 'score', type: 'range', label: 'Score', value: 4 },
		])
	})

	test('drops unanswered and malformed responses', () => {
		expect(answeredResponses([
			{ id: 'a', type: 'text', label: 'A', value: '   ' },
			{ id: 'b', type: 'radio', label: 'B', value: null },
			{ id: 'c', type: 'slider', label: 'C', value: 1 },
			{ id: 'd', type: 'text', label: 'D', value: { nested: true } },
			null,
			'not a response',
		])).toEqual([])
	})
})
