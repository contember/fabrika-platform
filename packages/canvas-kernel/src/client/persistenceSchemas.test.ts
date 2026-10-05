import { expect, test } from 'bun:test'
import type { z } from 'zod'
import { feedbackResponseSchema, filePreviewResponseSchema, parsePersistedState, planResponseSchema } from './persistenceSchemas'

test('recover persisted answers independently while retaining keys, values and extensions', () => {
	const response = { id: 'control', type: 'text', label: 'Question', value: 'answer', extension: { version: 2 } } satisfies z.input<
		typeof planResponseSchema
	>
	const entry = { id: 'feedback', markdown: 'generated', extension: true }
	expect(parsePersistedState({
		annotations: [],
		generalNote: 'note',
		responses: [['stable-key', response], ['broken', {}], null],
		feedbackEntries: [['stable-feedback', entry], [12, entry]],
		hostField: 'preserved',
	})).toEqual({
		annotations: [],
		generalNote: 'note',
		responses: [['stable-key', response]],
		feedbackEntries: [['stable-feedback', entry]],
		hostField: 'preserved',
	})
	expect(parsePersistedState({ generalNote: 'legacy' })).toEqual({ annotations: [], generalNote: 'legacy', responses: [] })
	expect(parsePersistedState(null)).toBeNull()
	expect(parsePersistedState([])).toBeNull()
})

test('preview and feedback responses reject malformed consumed fields', () => {
	expect(filePreviewResponseSchema.parse({ content: 'line one\nline two', language: 'typescript', size: 17 }))
		.toEqual({ content: 'line one\nline two', language: 'typescript' })
	expect(filePreviewResponseSchema.parse({ error: 'Not found', content: 42 })).toEqual({ error: 'Not found' })
	expect(feedbackResponseSchema.parse({ feedback: null })).toEqual({ feedback: null })
	expect(feedbackResponseSchema.parse({ feedback: 'review', future: 1 })).toEqual({ feedback: 'review' })
	for (const value of [null, [], { content: {} }, { error: 123 }, { language: 'ts' }]) {
		expect(filePreviewResponseSchema.safeParse(value).success).toBe(false)
	}
	expect(feedbackResponseSchema.safeParse({ feedback: {} }).success).toBe(false)
})
