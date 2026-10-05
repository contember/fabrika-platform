import type { PlanResponse } from '@fabrika/canvas-kernel/client'
import { expect, test } from 'bun:test'
import { parseBuilderPersistedState } from '../src/lib/persistedState'

test('legacy draft eligibility stays all-or-nothing before Canvas recovery', () => {
	const draft = { generalNote: 'note', annotations: [], responses: [] }
	expect(parseBuilderPersistedState(draft)).toEqual(draft)
	expect(parseBuilderPersistedState({ ...draft, generalNote: 2 })).toBeNull()
	expect(parseBuilderPersistedState({ ...draft, annotations: [{}] })).toBeNull()
	expect(parseBuilderPersistedState({ ...draft, responses: [['id', { id: 'id', type: 'text', label: 'Name' }, 'extra']] })).toBeNull()
	expect(parseBuilderPersistedState({ ...draft, feedbackEntries: null })).toBeNull()
	expect(parseBuilderPersistedState({ ...draft, feedbackEntries: [['id', { id: 'id' }]] })).toBeNull()
})

test('Canvas recovery filters unsupported entries only after legacy eligibility and retains unknown extensions', () => {
	const annotation = { id: 'a', snippet: 'code', note: 'fix', createdAt: 'legacy date', futureAnnotation: { offset: 42 } }
	const response = { id: 'r', type: 'text', label: 'Name', value: { futureValue: [1, null] }, futureWidget: 'kept' } satisfies PlanResponse & {
		futureWidget: string
	}
	const feedback = { id: 'f', markdown: 'feedback', futureFeedback: ['kept'] }
	const draft = {
		generalNote: 'note',
		annotations: [annotation, { ...annotation, id: 'bad', context: 4 }],
		responses: [['r', response], ['future', { id: 'future', type: 'future-widget', label: 'Future' }]],
		feedbackEntries: [['f', feedback]],
		futureDraft: { nested: true },
	}
	expect(parseBuilderPersistedState(draft)).toEqual({
		generalNote: 'note',
		annotations: [annotation],
		responses: [['r', response]],
		feedbackEntries: [['f', feedback]],
		futureDraft: { nested: true },
	})
})
