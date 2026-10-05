import { z } from 'zod'
import type { GitHubSourceConnectionListInput } from './index.js'

export const GITHUB_SOURCE_CONNECTION_DEFAULT_PAGE_SIZE = 50
export const GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE = 100
export const GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH = 512

export const githubSourceConnectionListInputSchema = z.object({
	cursor: z.string().min(1).max(GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH).optional(),
	limit: z.number().int().safe().min(1).max(GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE).optional(),
}).strict().transform(({ cursor, limit }) => ({
	...(cursor === undefined ? {} : { cursor }),
	...(limit === undefined ? {} : { limit }),
}))

export function decodeGitHubSourceConnectionListInput(value: unknown): GitHubSourceConnectionListInput {
	const result = githubSourceConnectionListInputSchema.safeParse(value)
	if (result.success) return result.data
	const issues = result.error.issues
	if (issues.some((issue) => issue.path.length === 0 && issue.code === 'invalid_type')) {
		throw new Error('source connection list input must be an object')
	}
	if (issues.some((issue) => issue.code === 'unrecognized_keys')) {
		throw new Error('source connection list input contains an unknown field')
	}
	if (issues.some((issue) => issue.path[0] === 'cursor')) {
		throw new Error(`source connection list cursor must be a non-empty string of at most ${GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH} characters`)
	}
	throw new Error(`source connection list limit must be an integer from 1 to ${GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE}`)
}
