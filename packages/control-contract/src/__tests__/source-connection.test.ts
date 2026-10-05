import { describe, expect, test } from 'bun:test'
import {
	decodeGitHubSourceConnectionListInput,
	GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE,
	GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH,
} from '../index'

describe('GitHub source connection collection contract', () => {
	test('bounds one page without limiting the total collection', () => {
		expect(decodeGitHubSourceConnectionListInput({})).toEqual({})
		expect(decodeGitHubSourceConnectionListInput({ cursor: 'next-page', limit: GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE })).toEqual({
			cursor: 'next-page',
			limit: GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE,
		})
		expect(() => decodeGitHubSourceConnectionListInput({ limit: GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE + 1 })).toThrow()
		expect(() => decodeGitHubSourceConnectionListInput({ cursor: 'x'.repeat(GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH + 1) })).toThrow()
	})

	test('rejects unknown input fields without echoing their names', () => {
		const secretKey = 'privateKey\nghs_must-not-leak'
		try {
			decodeGitHubSourceConnectionListInput({ [secretKey]: true })
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			expect(message).toContain('unknown field')
			expect(message).not.toContain(secretKey)
			expect(message).not.toContain('ghs_must-not-leak')
			return
		}
		throw new Error('expected decoder to reject an unknown field')
	})
})
