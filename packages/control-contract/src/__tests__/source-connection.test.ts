import { describe, expect, test } from 'bun:test'
import {
	GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE,
	GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH,
	githubSourceConnectionListInputSchema,
} from '../index'

describe('GitHub source connection collection contract', () => {
	test('bounds one page without limiting the total collection', () => {
		expect(githubSourceConnectionListInputSchema.parse({})).toEqual({})
		expect(githubSourceConnectionListInputSchema.parse({ cursor: 'next-page', limit: GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE })).toEqual({
			cursor: 'next-page',
			limit: GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE,
		})
		expect(() => githubSourceConnectionListInputSchema.parse({ limit: GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE + 1 })).toThrow()
		expect(() => githubSourceConnectionListInputSchema.parse({ cursor: 'x'.repeat(GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH + 1) })).toThrow()
	})
})
