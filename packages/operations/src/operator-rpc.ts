import { HttpError, initRpc, isStructuralError, type RpcRouterFor } from '@fabrika/app'
import type { AuthContext } from '@fabrika/auth'
import type { OperationsRpcContract } from '@fabrika/operations-contract/rpc'
import type { OperationsAppEnv } from './app.js'
import { OperationsOperatorUseCases } from './operator-api.js'
import * as schemas from './operator-rpc-input.js'
import { operatorInput } from './operator-rpc-validation.js'

interface OperationsRpcContext {
	readonly env: OperationsAppEnv
	readonly request: Request
	auth?: AuthContext | null
}

const rpc = initRpc<OperationsRpcContext>()

const inputs = {
	sourceInput: operatorInput(schemas.sourceInput),
	issueInput: operatorInput(schemas.issueInput),
	eventInput: operatorInput(schemas.eventInput),
	issueOccurrencesInput: operatorInput(schemas.issueOccurrencesInput, { order: ['', 'cursor', 'limit', 'issueId'] }),
	issueQuery: operatorInput(schemas.issueQuery, { query: true }),
	releaseQuery: operatorInput(schemas.releaseQuery, { query: true }),
	releaseInput: operatorInput(schemas.releaseInput),
	mutateIssueInput: operatorInput(schemas.mutateIssueInput),
	bulkIssueStatusInput: operatorInput(schemas.bulkIssueStatusInput),
	healthCheckMutationInput: operatorInput(schemas.healthCheckMutationInput),
	healthCheckUpdateInput: operatorInput(schemas.healthCheckUpdateInput),
	healthCheckDeleteInput: operatorInput(schemas.healthCheckDeleteInput),
	spikeAlertInput: operatorInput(schemas.spikeAlertInput, { order: ['', 'input', 'sourceId', 'input.threshold', 'input.enabled'] }),
	alertRuleInput: operatorInput(schemas.alertRuleInput, { order: ['', 'input', 'sourceId', 'kind', 'input.enabled'] }),
	alertChannelCreateInput: operatorInput(schemas.alertChannelCreateInput, {
		requireTarget: true,
		order: ['', 'sourceId', 'input', 'input.type', 'input.target', 'input.scope', 'input.enabled'],
	}),
	alertChannelUpdateInput: operatorInput(schemas.alertChannelUpdateInput, {
		order: ['', 'sourceId', 'channelId', 'input', 'input.type', 'input.target', 'input.scope', 'input.enabled'],
	}),
	alertChannelDeleteInput: operatorInput(schemas.alertChannelDeleteInput),
}

export const operationsRpcRouter: RpcRouterFor<OperationsRpcContext, OperationsRpcContract> = rpc.router({
	sources: rpc.procedure.query(({ ctx }) => operatorCall(ctx, (operations) => operations.sources())),
	source: rpc.procedure.input(inputs.sourceInput).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.source(input.sourceId))),
	issues: rpc.procedure.input(inputs.issueQuery).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.issues(input))),
	issue: rpc.procedure.input(inputs.issueInput).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.issue(input.issueId))),
	issueOccurrences: rpc.procedure.input(inputs.issueOccurrencesInput).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.issueOccurrences(input.issueId, input.cursor, input.limit))
	),
	latestEvent: rpc.procedure.input(inputs.issueInput).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.latestEvent(input.issueId))
	),
	event: rpc.procedure.input(inputs.eventInput).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.event(input.issueId, input.occurrenceId))
	),
	mutateIssue: rpc.procedure.input(inputs.mutateIssueInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.mutateIssue(input.issueId, input.mutation))
	),
	bulkIssueStatus: rpc.procedure.input(inputs.bulkIssueStatusInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.bulkIssueStatus(input))
	),
	assignees: rpc.procedure.input(inputs.sourceInput).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.assignees(input.sourceId))
	),
	releases: rpc.procedure.input(inputs.releaseQuery).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.releases(input))),
	release: rpc.procedure.input(inputs.releaseInput).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.release(input.releaseId))),
	health: rpc.procedure.query(({ ctx }) => operatorCall(ctx, (operations) => operations.health())),
	sourceHealth: rpc.procedure.input(inputs.sourceInput).query(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.sourceHealth(input.sourceId))
	),
	createHealthCheck: rpc.procedure.input(inputs.healthCheckMutationInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.createHealthCheck(input.sourceId, input.input))
	),
	updateHealthCheck: rpc.procedure.input(inputs.healthCheckUpdateInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.updateHealthCheck(input.sourceId, input.checkId, input.input))
	),
	deleteHealthCheck: rpc.procedure.input(inputs.healthCheckDeleteInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.deleteHealthCheck(input.sourceId, input.checkId))
	),
	alerts: rpc.procedure.input(inputs.sourceInput).query(({ ctx, input }) => operatorCall(ctx, (operations) => operations.alerts(input.sourceId))),
	updateSpikeAlert: rpc.procedure.input(inputs.spikeAlertInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.updateSpikeAlert(input.sourceId, input.input))
	),
	updateAlertRule: rpc.procedure.input(inputs.alertRuleInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.updateAlertRule(input.sourceId, input.kind, input.input))
	),
	createAlertChannel: rpc.procedure.input(inputs.alertChannelCreateInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.createAlertChannel(input.sourceId, input.input))
	),
	updateAlertChannel: rpc.procedure.input(inputs.alertChannelUpdateInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.updateAlertChannel(input.sourceId, input.channelId, input.input))
	),
	deleteAlertChannel: rpc.procedure.input(inputs.alertChannelDeleteInput).mutation(({ ctx, input }) =>
		operatorCall(ctx, (operations) => operations.deleteAlertChannel(input.sourceId, input.channelId))
	),
})

async function operatorCall<T>(ctx: OperationsRpcContext, run: (operations: OperationsOperatorUseCases) => Promise<T>): Promise<T> {
	try {
		return await run(operatorUseCases(ctx))
	} catch (error) {
		if (isStructuralError(error)) throw error
		if (error instanceof RangeError) throw new HttpError(400, 'bad_request', error.message)
		console.error('operations operator RPC failed')
		throw new HttpError(500, 'internal', 'internal error')
	}
}

function operatorUseCases(ctx: OperationsRpcContext): OperationsOperatorUseCases {
	const auth = ctx.auth
	if (auth === undefined || auth === null) throw new HttpError(401, 'auth', 'authentication required')
	return new OperationsOperatorUseCases(ctx.request, {
		repositories: ctx.env.repositories,
		health: ctx.env.health,
		payloads: ctx.env.payloads,
		auth,
		principals: ctx.env.iam,
	})
}
