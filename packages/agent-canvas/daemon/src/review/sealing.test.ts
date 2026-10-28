import { describe, expect, test } from 'bun:test'
import { exportShareKey, generateShareKey } from '../../client/shareCrypto'
import type { ReviewAnchor } from './model'
import { formatReviewCredentials, parseReviewCredentials, type SealedThread } from './remote'
import { openThread, sealAnchor, sealText } from './sealing'

const anchor: ReviewAnchor = { url: 'https://app.example.com/orders', selector: 'main > h1', role: 'heading', name: 'Orders' }

async function sealedThread(key: CryptoKey, body: string): Promise<SealedThread> {
	return {
		id: '01a1826b-55ac-7d97-93cb-2202741e7dd5',
		anchor: await sealAnchor(key, anchor),
		state: 'queued',
		comments: [{ id: '01a1826b-55ac-7d97-93cb-2202741e7dd6', author: 'user', body: await sealText(key, body), createdAt: '2026-10-28T10:00:00.000Z' }],
		screenshot: false,
		createdAt: '2026-10-28T10:00:00.000Z',
		updatedAt: '2026-10-28T10:00:00.000Z',
	}
}

describe('sealing', () => {
	test('a sealed thread carries none of its text and opens with the project key', async () => {
		const key = await generateShareKey()
		const sealed = await sealedThread(key, 'Make the header green')
		expect(JSON.stringify(sealed)).not.toContain('green')
		expect(JSON.stringify(sealed)).not.toContain('Orders')

		const opened = await openThread(key, sealed)
		expect(opened.anchor).toEqual(anchor)
		expect(opened.comments.map((comment) => comment.body)).toEqual(['Make the header green'])
	})

	test('a thread sealed with another key does not open', async () => {
		const sealed = await sealedThread(await generateShareKey(), 'Make the header green')
		await expect(openThread(await generateShareKey(), sealed)).rejects.toThrow()
	})
})

describe('review credentials', () => {
	test('round-trip through the link fragment', async () => {
		const credentials = { projectId: 'a'.repeat(24), key: await exportShareKey(await generateShareKey()) }
		expect(parseReviewCredentials(formatReviewCredentials(credentials))).toEqual(credentials)
	})

	test('refuse anything else', () => {
		expect(parseReviewCredentials('off')).toBeNull()
		expect(parseReviewCredentials(`${'a'.repeat(24)}.short`)).toBeNull()
		expect(parseReviewCredentials(`${'A'.repeat(24)}.${'k'.repeat(43)}`)).toBeNull()
		expect(parseReviewCredentials(`${'a'.repeat(24)}.${'k'.repeat(43)}.extra`)).toBeNull()
	})
})
