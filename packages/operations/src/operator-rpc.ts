import { initRpc, type RpcRouterFor, type StandardSchemaV1 } from '@fabrika/app'
import type { AuthContext } from '@fabrika/auth'
import type {
	OperationsAlertKind,
	OperationsHealthCheckUpsertRequestDto,
	OperationsIssueMutationRequestDto,
	OperationsNotificationChannelRequestDto,
} from '@fabrika/operations-contract/operator-api'
import type { OperationsIssueQuery, OperationsReleaseQuery, OperationsRpcContract } from '@fabrika/operations-contract/rpc'
import type { OperationsAppEnv } from './app.js'
import { OperationsOperatorUseCases } from './operator-api.js'
import {
	alertRuleInput as parseAlertRule,
	bulkIssueStatusInput as parseBulkIssueStatus,
	channelInput,
	healthCheckInput as parseHealthCheck,
	issueMutation as parseIssueMutation,
	issueStatus,
	requiredAlertKind as alertKind,
	spikeAlertInput as parseSpikeAlert,
	string,
} from './operator-input.js'

interface OperationsRpcContext {
	readonly env: OperationsAppEnv
	readonly request: Request
	auth?: AuthContext | null
}

const rpc = initRpc<OperationsRpcContext>()

export const operationsRpcRouter: RpcRouterFor<OperationsRpcContext, OperationsRpcContract> = rpc.router({
	sources: rpc.procedure.query(({ ctx }) => operatorCall(ctx, (operations) => operations.sources())),
	source: rpc.procedure.input(schema(sourceInput)).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.source(input.sourceId))),
	issues: rpc.procedure.input(schema(issueQuery)).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.issues(input))),
	issue: rpc.procedure.input(schema(issueInput)).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.issue(input.issueId))),
	issueOccurrences: rpc.procedure.input(schema(issueOccurrencesInput)).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.issueOccurrences(input.issueId, input.cursor, input.limit))
	),
	latestEvent: rpc.procedure.input(schema(issueInput)).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.latestEvent(input.issueId))
	),
	event: rpc.procedure.input(schema(eventInput)).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.event(input.issueId, input.occurrenceId))
	),
	mutateIssue: rpc.procedure.input(schema(mutateIssueInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.mutateIssue(input.issueId, input.mutation))
	),
	bulkIssueStatus: rpc.procedure.input(schema(bulkIssueStatusInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.bulkIssueStatus(input))
	),
	assignees: rpc.procedure.input(schema(sourceInput)).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.assignees(input.sourceId))
	),
	releases: rpc.procedure.input(schema(releaseQuery)).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.releases(input))),
	release: rpc.procedure.input(schema(releaseInput)).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.release(input.releaseId))),
	health: rpc.procedure.query(({ ctx }) => operatorCall(ctx, (operations) => operations.health())),
	sourceHealth: rpc.procedure.input(schema(sourceInput)).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.sourceHealth(input.sourceId))
	),
	createHealthCheck: rpc.procedure.input(schema(healthCheckMutationInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.createHealthCheck(input.sourceId, input.input))
	),
	updateHealthCheck: rpc.procedure.input(schema(healthCheckUpdateInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.updateHealthCheck(input.sourceId, input.checkId, input.input))
	),
	deleteHealthCheck: rpc.procedure.input(schema(healthCheckDeleteInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.deleteHealthCheck(input.sourceId, input.checkId))
	),
	alerts: rpc.procedure.input(schema(sourceInput)).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.alerts(input.sourceId))),
	updateSpikeAlert: rpc.procedure.input(schema(spikeAlertInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.updateSpikeAlert(input.sourceId, input.input))
	),
	updateAlertRule: rpc.procedure.input(schema(alertRuleInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.updateAlertRule(input.sourceId, input.kind, input.input))
	),
	createAlertChannel: rpc.procedure.input(schema(alertChannelCreateInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.createAlertChannel(input.sourceId, input.input))
	),
	updateAlertChannel: rpc.procedure.input(schema(alertChannelUpdateInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.updateAlertChannel(input.sourceId, input.channelId, input.input))
	),
	deleteAlertChannel: rpc.procedure.input(schema(alertChannelDeleteInput)).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.deleteAlertChannel(input.sourceId, input.channelId))
	),
})

async function operatorCall<T>(
	ctx: OperationsRpcContext,
	run: (operations: OperationsOperatorUseCases) => Promise<T>,
): Promise<T> {
	try {
		return await run(operatorUseCases(ctx))
	} catch (error) {
		if (isStructuralError(error)) throw error
		if (error instanceof RangeError) throw requestError(400, 'bad_request', error.message)
		console.error('operations operator RPC failed')
		throw requestError(500, 'internal', 'internal error')
	}
}

function isStructuralError(error: unknown): boolean {
	return isRecord(error) && typeof error['httpStatus'] === 'number' && typeof error['type'] === 'string'
}

function operatorUseCases(ctx: OperationsRpcContext): OperationsOperatorUseCases {
	const auth = ctx.auth
	if (auth === undefined || auth === null) throw requestError(401, 'auth', 'authentication required')
	return new OperationsOperatorUseCases(ctx.request, {
		repositories: ctx.env.repositories,
		health: ctx.env.health,
		payloads: ctx.env.payloads,
		auth,
		principals: ctx.env.iam,
	})
}

function schema<T>(parse: (value: unknown) => T): StandardSchemaV1<unknown, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'fabrika-operations',
			validate(value) {
				try {
					return { value: parse(value) }
				} catch (error) {
					return { issues: [{ message: error instanceof Error ? error.message : 'invalid input' }] }
				}
			},
		},
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error('input must be an object')
	return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(input: Record<string, unknown>, field: string): string {
	return string(input[field], field)
}

function optionalStringField(input: Record<string, unknown>, field: string): string | undefined {
	const value = input[field]
	if (value === undefined) return undefined
	if (typeof value !== 'string') throw new Error(`${field} must be a string`)
	return value
}

function sourceInput(value: unknown): { sourceId: string } {
	const input = record(value)
	return { sourceId: stringField(input, 'sourceId') }
}

function issueInput(value: unknown): { issueId: string } {
	const input = record(value)
	return { issueId: stringField(input, 'issueId') }
}

function eventInput(value: unknown): { issueId: string; occurrenceId: string } {
	const input = record(value)
	return { issueId: stringField(input, 'issueId'), occurrenceId: stringField(input, 'occurrenceId') }
}

function issueOccurrencesInput(value: unknown): { issueId: string; cursor?: string; limit?: number } {
	const input = record(value)
	const cursor = optionalStringField(input, 'cursor')
	const limit = optionalBoundedLimit(input['limit'])
	return {
		issueId: stringField(input, 'issueId'),
		...(cursor === undefined ? {} : { cursor }),
		...(limit === undefined ? {} : { limit }),
	}
}

function releaseInput(value: unknown): { releaseId: string } {
	const input = record(value)
	return { releaseId: stringField(input, 'releaseId') }
}

function healthCheckDeleteInput(value: unknown): { sourceId: string; checkId: string } {
	const input = record(value)
	return { sourceId: stringField(input, 'sourceId'), checkId: stringField(input, 'checkId') }
}

function alertChannelDeleteInput(value: unknown): { sourceId: string; channelId: string } {
	const input = record(value)
	return { sourceId: stringField(input, 'sourceId'), channelId: stringField(input, 'channelId') }
}

function issueQuery(value: unknown): OperationsIssueQuery {
	const input = record(value)
	const sourceId = optionalStringField(input, 'sourceId')
	const query = optionalStringField(input, 'query')
	const cursor = optionalStringField(input, 'cursor')
	const statusValue = input['status']
	const status = statusValue === undefined ? undefined : issueStatus(statusValue)
	const level = issueLevel(input['level'])
	const window = issueWindow(input['window'])
	const assignee = issueAssignee(input['assignee'])
	const sort = issueSort(input['sort'])
	const limit = optionalBoundedLimit(input['limit'])
	return {
		...(sourceId === undefined ? {} : { sourceId }),
		...(status === undefined ? {} : { status }),
		...(level === undefined ? {} : { level }),
		...(window === undefined ? {} : { window }),
		...(query === undefined ? {} : { query }),
		...(assignee === undefined ? {} : { assignee }),
		...(sort === undefined ? {} : { sort }),
		...(cursor === undefined ? {} : { cursor }),
		...(limit === undefined ? {} : { limit }),
	}
}

function releaseQuery(value: unknown): OperationsReleaseQuery {
	const input = record(value)
	const sourceId = optionalStringField(input, 'sourceId')
	const cursor = optionalStringField(input, 'cursor')
	const limitValue = input['limit']
	if (limitValue !== undefined && (typeof limitValue !== 'number' || !Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100)) {
		throw new Error('limit must be between 1 and 100')
	}
	return {
		...(sourceId === undefined ? {} : { sourceId }),
		...(cursor === undefined ? {} : { cursor }),
		...(typeof limitValue === 'number' ? { limit: limitValue } : {}),
	}
}

function mutateIssueInput(value: unknown): { issueId: string; mutation: OperationsIssueMutationRequestDto } {
	const input = record(value)
	return { issueId: stringField(input, 'issueId'), mutation: issueMutation(input['mutation']) }
}

function issueMutation(value: unknown): OperationsIssueMutationRequestDto {
	return parseIssueMutation(record(value))
}

function bulkIssueStatusInput(value: unknown): { issueIds: string[]; status: 'open' | 'resolved' | 'ignored' } {
	return parseBulkIssueStatus(record(value))
}

function healthCheck(value: unknown): OperationsHealthCheckUpsertRequestDto {
	return parseHealthCheck(record(value))
}

function healthCheckMutationInput(value: unknown): { sourceId: string; input: OperationsHealthCheckUpsertRequestDto } {
	const input = record(value)
	return { sourceId: stringField(input, 'sourceId'), input: healthCheck(input['input']) }
}

function healthCheckUpdateInput(value: unknown): { sourceId: string; checkId: string; input: OperationsHealthCheckUpsertRequestDto } {
	const input = record(value)
	return {
		sourceId: stringField(input, 'sourceId'),
		checkId: stringField(input, 'checkId'),
		input: healthCheck(input['input']),
	}
}

function spikeAlertInput(value: unknown): { sourceId: string; input: { threshold: number; enabled: boolean } } {
	const input = record(value)
	const alert = record(input['input'])
	return {
		sourceId: stringField(input, 'sourceId'),
		input: parseSpikeAlert(alert),
	}
}

function alertRuleInput(value: unknown): { sourceId: string; kind: OperationsAlertKind; input: { enabled: boolean } } {
	const input = record(value)
	const rule = record(input['input'])
	return {
		sourceId: stringField(input, 'sourceId'),
		kind: alertKind(input['kind']),
		input: parseAlertRule(rule),
	}
}

function alertChannelCreateInput(value: unknown): { sourceId: string; input: OperationsNotificationChannelRequestDto } {
	const input = record(value)
	return { sourceId: stringField(input, 'sourceId'), input: alertChannel(input['input'], true) }
}

function alertChannelUpdateInput(value: unknown): {
	sourceId: string
	channelId: string
	input: OperationsNotificationChannelRequestDto
} {
	const input = record(value)
	return {
		sourceId: stringField(input, 'sourceId'),
		channelId: stringField(input, 'channelId'),
		input: alertChannel(input['input'], false),
	}
}

function alertChannel(value: unknown, requireTarget: boolean): OperationsNotificationChannelRequestDto {
	return channelInput(record(value), requireTarget)
}

function issueLevel(value: unknown): OperationsIssueQuery['level'] {
	if (value === undefined) return undefined
	if (value === 'fatal' || value === 'error' || value === 'warning' || value === 'info') return value
	throw new Error('invalid issue level')
}

function issueWindow(value: unknown): OperationsIssueQuery['window'] {
	if (value === undefined) return undefined
	if (value === 'all' || value === '24h' || value === '7d' || value === '30d') return value
	throw new Error('invalid issue window')
}

function issueAssignee(value: unknown): OperationsIssueQuery['assignee'] {
	if (value === undefined) return undefined
	if (value === 'all' || value === 'me' || value === 'none') return value
	throw new Error('invalid issue assignee')
}

function issueSort(value: unknown): OperationsIssueQuery['sort'] {
	if (value === undefined) return undefined
	if (value === 'recent' || value === 'new' || value === 'frequency') return value
	throw new Error('invalid issue sort')
}

function optionalBoundedLimit(value: unknown): number | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 100) {
		throw new Error('limit must be between 1 and 100')
	}
	return value
}

function requestError(httpStatus: number, type: string, message: string): Error & { readonly httpStatus: number; readonly type: string } {
	return Object.assign(new Error(message), { httpStatus, type })
}
