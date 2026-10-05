import { z } from 'zod'

const nonempty = z.string().min(1)
const positiveInteger = z.number().int().safe().positive()
export const issueStatusSchema = z.enum(['open', 'resolved', 'ignored'])
export const alertKindSchema = z.enum(['new_issue', 'regression', 'spike', 'failed_check', 'recovery', 'unhealthy_telemetry'])
export const issueMutationSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('status'), status: issueStatusSchema }),
	z.object({ kind: z.literal('comment'), text: nonempty }),
	z.object({ kind: z.literal('assign'), principalId: nonempty.nullable() }),
	z.object({ kind: z.literal('snooze_until'), until: positiveInteger }),
	z.object({ kind: z.literal('snooze_count'), additional: positiveInteger }),
	z.object({ kind: z.literal('resolve_in_release'), releaseId: nonempty.nullable() }),
	z.object({ kind: z.literal('merge'), targetIssueId: nonempty }),
])
export const bulkIssueStatusSchema = z.object({ issueIds: z.array(nonempty), status: issueStatusSchema })
export const healthCheckSchema = z.object({
	path: nonempty,
	enabled: z.boolean(),
	intervalMs: positiveInteger,
	timeoutMs: positiveInteger,
	expectedStatus: positiveInteger,
	failureThreshold: positiveInteger,
	recoveryThreshold: positiveInteger,
	staleAfterMs: positiveInteger,
})
export const spikeAlertSchema = z.object({ threshold: positiveInteger, enabled: z.boolean() })
export const alertRuleSchema = z.object({ enabled: z.boolean() })
export const channelSchema = z.object({ scope: alertKindSchema, type: z.literal('webhook'), target: z.string().optional(), enabled: z.boolean() })

export function alertKind(value: unknown) {
	const result = alertKindSchema.safeParse(value)
	return result.success ? result.data : null
}
