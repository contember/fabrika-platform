import { z } from 'zod'

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
