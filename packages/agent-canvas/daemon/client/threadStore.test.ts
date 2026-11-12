import { describe, expect, test } from 'bun:test'
import type { CanvasThread } from '../src/threads'
import { mergeThreads } from './threadStore'

function thread(id: string, updatedAt: string, state: CanvasThread['state'] = 'open'): CanvasThread {
	return { id, state, revision: 1, snippet: 'text', comments: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt }
}

describe('mergeThreads', () => {
	test('a stale copy does not overwrite a newer one, whichever arrives last', () => {
		const claimed = thread('a', '2026-01-01T00:00:02.000Z', 'working')
		const posted = thread('a', '2026-01-01T00:00:01.000Z', 'queued')
		expect(mergeThreads([claimed], [posted])).toEqual([claimed])
		expect(mergeThreads([posted], [claimed])).toEqual([claimed])
	})

	test('keeps threads the incoming list does not mention, and adds new ones', () => {
		const a = thread('a', '2026-01-01T00:00:01.000Z')
		const b = thread('b', '2026-01-01T00:00:01.000Z')
		expect(mergeThreads([a], [b])).toEqual([b, a])
	})
})
