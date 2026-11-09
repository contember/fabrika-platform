import { describe, expect, test } from 'bun:test'
import { decryptFeedbackEntry, generateShareKey, wireFeedbackEntrySchema } from '../src/share-client'
import type { SharedResponse } from '../src/share-responses'
import { encryptFeedback } from './clientApi'

describe('encryptFeedback', () => {
	const responses: SharedResponse[] = [
		{ id: 'db', type: 'radio', label: 'Which database is secret?', value: 'pg', note: 'for now' },
		{ id: 'envs', type: 'checkbox', label: 'Envs', value: ['stage'] },
	]
	const payload = {
		author: { id: 'r1', name: 'Reviewer' },
		revision: 2,
		annotations: [{
			id: 'a1',
			snippet: 'quoted text',
			note: 'a comment',
			createdAt: '2026-01-02T00:00:00Z',
			context: { before: '', after: '', hierarchy: ['Section'] },
		}],
		generalNote: 'overall',
		responses,
	}

	test('sends the responses as one ciphertext that the daemon reads back', async () => {
		const key = await generateShareKey()
		const body = await encryptFeedback(payload, key)
		expect(typeof body.responses).toBe('string')
		const wire = JSON.stringify(body)
		for (const plain of ['Which database is secret?', 'for now', 'Reviewer', 'quoted text', 'a comment', 'overall', 'Section']) {
			expect(wire).not.toContain(plain)
		}

		// What the worker stores and returns: the body plus the fields it assigns.
		const stored = wireFeedbackEntrySchema.parse({ ...body, id: 'e1', shareId: 's1', submittedAt: '2026-01-02T00:00:00Z' })
		const opened = await decryptFeedbackEntry(stored, key)
		expect(opened.responses).toEqual(responses)
		expect(opened.author.name).toBe('Reviewer')
		expect(opened.annotations[0]?.context?.hierarchy).toEqual(['Section'])
	})

	test('sends no responses field when nothing was answered', async () => {
		const body = await encryptFeedback({ ...payload, responses: [] }, await generateShareKey())
		expect('responses' in body).toBe(false)
	})
})
