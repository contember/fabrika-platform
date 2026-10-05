import type { StandardSchemaV1 } from '@fabrika/app'
import type { z } from 'zod'

interface OperatorValidationOptions {
	order?: readonly string[]
	query?: boolean
	requireTarget?: boolean
}

/** Preserve the operator wire errors while Zod owns all structural validation. */
export function operatorInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, options: OperatorValidationOptions = {}): StandardSchemaV1<unknown, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'fabrika-operations',
			validate(value) {
				const result = schema.safeParse(value)
				if (result.success) return { value: result.data }
				const issues = result.error.issues
				const first = options.order?.map((path) => issues.find((issue) => issue.path.join('.') === path)).find((issue) => issue !== undefined)
					?? issues[0]
				return { issues: [{ message: first === undefined ? 'invalid input' : operatorIssueMessage(first, options) }] }
			},
		},
	}
}

function operatorIssueMessage(issue: z.ZodIssue, options: OperatorValidationOptions): string {
	if (issue.code === 'invalid_type' && issue.expected === 'object') return 'input must be an object'
	const field = issue.path.at(-1)
	if (issue.path[0] === 'issueIds') return issue.path.length === 1 ? 'issueIds must be an array' : 'issueId must be a non-empty string'
	switch (field) {
		case 'kind':
			return issue.path[0] === 'mutation' ? 'invalid issue mutation' : 'invalid alert kind'
		case 'scope':
			return 'invalid alert kind'
		case 'status':
		case 'level':
		case 'window':
		case 'assignee':
		case 'sort':
			return `invalid issue ${field}`
		case 'limit':
			return 'limit must be between 1 and 100'
		case 'type':
			return 'type must be webhook'
		case 'target':
			return options.requireTarget ? 'target is required' : 'target must be a string'
		case 'enabled':
			return 'enabled must be a boolean'
		case 'until':
		case 'additional':
		case 'intervalMs':
		case 'timeoutMs':
		case 'expectedStatus':
		case 'failureThreshold':
		case 'recoveryThreshold':
		case 'staleAfterMs':
		case 'threshold':
			return `${field} must be a positive integer`
		case 'cursor':
		case 'query':
			return `${field} must be a string`
		case 'sourceId':
			return options.query ? 'sourceId must be a string' : 'sourceId must be a non-empty string'
		default:
			return `${field} must be a non-empty string`
	}
}
