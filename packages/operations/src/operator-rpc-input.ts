import { z } from 'zod'
import {
	alertKindSchema,
	alertRuleSchema,
	bulkIssueStatusSchema,
	channelSchema,
	healthCheckSchema,
	issueMutationSchema,
	issueStatusSchema,
	spikeAlertSchema,
} from './operator-input.js'

const id = z.string().min(1)
const limit = z.number().int().min(1).max(100).optional()
export const sourceInput = z.object({ sourceId: id })
export const issueInput = z.object({ issueId: id })
export const eventInput = issueInput.extend({ occurrenceId: id })
export const issueOccurrencesInput = issueInput.extend({ cursor: z.string().optional(), limit }).transform(({ issueId, cursor, limit }) => ({
	issueId,
	...(cursor === undefined ? {} : { cursor }),
	...(limit === undefined ? {} : { limit }),
}))
export const releaseInput = z.object({ releaseId: id })
export const healthCheckDeleteInput = sourceInput.extend({ checkId: id })
export const alertChannelDeleteInput = sourceInput.extend({ channelId: id })
export const issueQuery = z.object({
	sourceId: z.string().optional(),
	query: z.string().optional(),
	cursor: z.string().optional(),
	status: issueStatusSchema.optional(),
	level: z.enum(['fatal', 'error', 'warning', 'info']).optional(),
	window: z.enum(['all', '24h', '7d', '30d']).optional(),
	assignee: z.enum(['all', 'me', 'none']).optional(),
	sort: z.enum(['recent', 'new', 'frequency']).optional(),
	limit,
}).transform(({ sourceId, status, level, window, query, assignee, sort, cursor, limit }) => ({
	...(sourceId === undefined ? {} : { sourceId }),
	...(status === undefined ? {} : { status }),
	...(level === undefined ? {} : { level }),
	...(window === undefined ? {} : { window }),
	...(query === undefined ? {} : { query }),
	...(assignee === undefined ? {} : { assignee }),
	...(sort === undefined ? {} : { sort }),
	...(cursor === undefined ? {} : { cursor }),
	...(limit === undefined ? {} : { limit }),
}))
export const releaseQuery = z.object({ sourceId: z.string().optional(), cursor: z.string().optional(), limit }).transform((
	{ sourceId, cursor, limit },
) => ({
	...(sourceId === undefined ? {} : { sourceId }),
	...(cursor === undefined ? {} : { cursor }),
	...(limit === undefined ? {} : { limit }),
}))
export const mutateIssueInput = issueInput.extend({ mutation: issueMutationSchema })
export const bulkIssueStatusInput = bulkIssueStatusSchema
export const healthCheckMutationInput = sourceInput.extend({ input: healthCheckSchema })
export const healthCheckUpdateInput = healthCheckDeleteInput.extend({ input: healthCheckSchema })
export const spikeAlertInput = sourceInput.extend({ input: spikeAlertSchema })
export const alertRuleInput = sourceInput.extend({ kind: alertKindSchema, input: alertRuleSchema })
export const alertChannelCreateInput = sourceInput.extend({ input: channelSchema.extend({ target: z.string() }) })
export const alertChannelUpdateInput = alertChannelDeleteInput.extend({
	input: channelSchema.transform(({ target, scope, type, enabled }) => ({
		scope,
		type,
		...(target === undefined ? {} : { target }),
		enabled,
	})),
})
