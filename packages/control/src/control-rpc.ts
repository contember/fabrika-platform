import { HttpError, initRpc, isStructuralError, type RpcRouterFor } from '@fabrika/app'
import type { AuthContext } from '@fabrika/auth'
import {
	BUILDER_APPROVAL_VERIFIER,
	BUILDER_CONNECTION_ATTEMPT_ID,
	BUILDER_CONNECTION_IDENTIFIER,
	type ControlRpcContract,
	githubSourceConnectionListInputSchema,
} from '@fabrika/control-contract'
import type { ControlProvider } from '@fabrika/provider-contract'
import { z } from 'zod'
import { ACTIONS } from './actions'
import { createBuilderConnectionReceipt, getBuilderConnectionReceipt } from './api/builder-connections'
import {
	approveBuilderPairing,
	type BuilderPairingContext,
	denyBuilderPairing,
	inspectBuilderPairing,
	listOwnBuilderPairings,
	revokeBuilderPairing,
} from './api/builder-pairing'
import { fail } from './api/domain'
import {
	adoptNamespaceUseCase,
	createNamespaceUseCase,
	getNamespaceUseCase,
	listNamespacesUseCase,
	type NamespaceUseCaseContext,
	planNamespaceUseCase,
	reconcileNamespaceUseCase,
	removeNamespaceUseCase,
	updateNamespaceUseCase,
} from './api/namespaces'
import { providerEnvelopeSchema } from './api/provider-envelope'
import { createAppUseCase, deleteAppUseCase, getAppUseCase, listAppsUseCase, updateAppUseCase } from './api/registry/apps'
import {
	deleteAppSecretUseCase,
	deleteAppVarUseCase,
	listAppSecretsUseCase,
	listAppVarsUseCase,
	putAppVarUseCase,
} from './api/registry/configuration'
import { type RegistryUseCaseContext } from './api/registry/context'
import { deleteAppEnvUseCase, listAppEnvsUseCase, putAppEnvUseCase } from './api/registry/environments'
import { registerAppUseCase } from './api/registry/registration'
import { APP_VAR_VALUE_MAX_LENGTH, assertAppVarValue } from './api/registry/validation'
import {
	cancelRunUseCase,
	getRunLogUseCase,
	getRunUseCase,
	listRunsUseCase,
	type RunsUseCaseContext,
	tailRunLogUseCase,
	triggerDeployUseCase,
} from './api/runs'
import {
	deleteAppSecretValueUseCase,
	putAppSecretUseCase,
	rotateAppSecretValueUseCase,
	setAppSecretValueUseCase,
	type VaultUseCaseContext,
} from './api/vault'
import {
	type ApprovalUseCaseContext,
	completeApprovalUseCase,
	getApprovalUseCase,
	listApprovalsUseCase,
	setEnvironmentProtectionUseCase,
} from './approval/api'
import { describeConnector } from './connectors'
import { consoleAccess } from './console-access'
import type { Env } from './env'
import { reconcileSourceConnection, repairSourceConnection, verifySourceInstallation } from './github/connections/installation'
import { startSourceConnection } from './github/connections/manifest'
import type { SourceConnectionPort } from './github/connections/port'
import { sourceConnectionList } from './github/connections/status'
import { appScope } from './iam'
import { jsonValueSchema } from './json-value'
import { buildControlRpcDeps } from './services'

interface ControlRpcContext {
	readonly env: Env
	readonly provider: ControlProvider
	readonly sourceConnection: SourceConnectionPort
	readonly request: Request
	readonly auth: AuthContext
}

const rpc = initRpc<ControlRpcContext>()
const receiptAttemptId = z.object({ attemptId: z.string().regex(BUILDER_CONNECTION_ATTEMPT_ID) }).strict()
const pairingProof = receiptAttemptId.extend({ approvalVerifier: z.string().regex(BUILDER_APPROVAL_VERIFIER) })
const pairingList = z.object({
	before: z.string().regex(BUILDER_CONNECTION_ATTEMPT_ID).optional(),
	limit: z.number().int().min(1).max(100).optional(),
}).strict()
const pairingRevoke = z.object({ credentialId: z.string().regex(BUILDER_CONNECTION_ATTEMPT_ID) }).strict()
const receiptIdentifier = z.string().regex(BUILDER_CONNECTION_IDENTIFIER)
const createReceiptInput = pairingProof.extend({
	appId: receiptIdentifier,
	environment: z.object({
		env: receiptIdentifier,
		namespaceId: receiptIdentifier.nullable(),
		domain: z.string().min(1).max(253).nullable(),
		publicOrigin: z.string().min(1).max(2048).nullable(),
		triggerRef: z.string().min(1).max(1024).nullable(),
	}).strict(),
})
const nonEmpty = z.string().min(1)
const nullableString = z.string().nullable().optional()
const jsonValue = jsonValueSchema
const appOptionalFields = {
	defaultBranch: z.string().optional(),
	workerDir: nullableString,
	buildCmd: nullableString,
	configPath: nullableString,
	githubInstallationId: z.number().int().nonnegative().nullable().optional(),
	resolveInstallationId: z.boolean().optional(),
}
const appId = z.object({ appId: nonEmpty })
const appEnvironment = z.object({ appId: nonEmpty, env: nonEmpty })
const appNamedValue = z.object({ appId: nonEmpty, name: nonEmpty, env: nullableString })
const updateAppInput = z.object({ appId: nonEmpty, app: z.object({ repoUrl: z.string().optional(), ...appOptionalFields }) })
const createAppInput = z.object({ id: nonEmpty, repoUrl: nonEmpty, ...appOptionalFields })
const appEnvironmentBody = z.object({
	domain: nullableString,
	publicOrigin: nullableString,
	triggerRef: nullableString,
	authoring: z.boolean().optional(),
	namespaceId: nullableString,
	target: providerEnvelopeSchema,
	artifact: providerEnvelopeSchema,
})
const putEnvironmentInput = z.object({ appId: nonEmpty, env: nonEmpty, environment: appEnvironmentBody })
const protectEnvironmentInput = z.object({ appId: nonEmpty, env: nonEmpty, protected: z.boolean() }).strict()
const accessDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const completeApprovalInput = z.object({
	runId: nonEmpty,
	decision: z.enum(['approve', 'reject']),
	candidateDigest: accessDigest,
	baselineDigest: accessDigest,
}).strict()
const secretBody = z.object({
	name: nonEmpty,
	value: z.string(),
	env: nullableString,
})
const putSecretInput = z.object({ appId: nonEmpty, secret: secretBody })
const variableBody = z.object({
	name: nonEmpty,
	value: nonEmpty.refine(refuses(assertAppVarValue), `value must be a single line of at most ${APP_VAR_VALUE_MAX_LENGTH} characters`),
	env: nullableString,
})
const putVariableInput = z.object({ appId: nonEmpty, variable: variableBody })
const secretValueInput = z.object({ appId: nonEmpty, name: nonEmpty, env: nullableString, value: z.string() })
const namespaceId = z.object({ namespaceId: nonEmpty })
const namespaceBody = z.object({ id: nonEmpty, env: nonEmpty, exclusiveAppId: nullableString, target: providerEnvelopeSchema })
const adoptNamespaceInput = z.object({ namespaceId: nonEmpty, namespace: namespaceBody.omit({ id: true }) })
const updateNamespaceInput = z.object({ namespaceId: nonEmpty, namespace: z.object({ target: providerEnvelopeSchema }) })
const planNamespaceInput = z.object({
	id: nonEmpty,
	env: nonEmpty,
	preset: nonEmpty,
	exclusiveAppId: z.string().optional(),
	options: jsonValue.optional(),
})
const runListInput = z.object({
	appId: z.string().optional(),
	env: z.string().optional(),
	before: z.string().optional(),
	limit: z.number().int().min(1).max(200).optional(),
})
const runId = z.object({ runId: nonEmpty })
const tailRunInput = z.object({ runId: nonEmpty, after: z.number().int().nonnegative().optional() })
const deployInput = z.object({ appId: nonEmpty, env: nonEmpty, ref: z.string().optional() })
const registerInput = z.object({
	id: nonEmpty,
	repoUrl: nonEmpty,
	env: nonEmpty,
	domain: nullableString,
	publicOrigin: nullableString,
	triggerRef: nullableString,
	namespaceId: nullableString,
	target: providerEnvelopeSchema,
	artifact: providerEnvelopeSchema,
	...appOptionalFields,
})
const describeConnectorInput = z.object({
	consumer: nonEmpty,
	env: nonEmpty,
	app: nonEmpty,
	export: nonEmpty,
	version: z.number().int().positive(),
}).strict()
const githubOwner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
const githubRepositoryName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)
const sourceConnectionId = z.object({ connectionId: z.string().min(1).max(128) }).strict()
const sourceConnectionListInput = githubSourceConnectionListInputSchema
const startSourceConnectionInput = z.object({
	organization: githubOwner,
	appName: z.string().min(1).max(100),
	visibility: z.enum(['private', 'public']),
	repositories: z.array(z.object({ owner: githubOwner, name: githubRepositoryName }).strict()).max(100),
}).strict()

export const controlRpcRouter = createControlRpcRouter(buildControlRpcDeps)

export function createControlRpcRouter(buildDeps: typeof buildControlRpcDeps): RpcRouterFor<ControlRpcContext, ControlRpcContract> {
	return rpc.router({
		installation: rpc.procedure.query(({ ctx }) => ({ provider: ctx.provider.id })),
		consoleAccess: rpc.procedure.query(({ ctx }) => consoleAccess(ctx.auth)),
		builderPairing: rpc.router({
			inspect: rpc.procedure.input(pairingProof).query(({ ctx, input }) => controlCall(() => inspectBuilderPairing(pairingContext(ctx), input))),
			approve: rpc.procedure.input(pairingProof).mutation(({ ctx, input }) => controlCall(() => approveBuilderPairing(pairingContext(ctx), input))),
			deny: rpc.procedure.input(pairingProof).mutation(({ ctx, input }) => controlCall(() => denyBuilderPairing(pairingContext(ctx), input))),
			listOwn: rpc.procedure.input(pairingList).query(({ ctx, input }) => controlCall(() => listOwnBuilderPairings(pairingContext(ctx), input))),
			revoke: rpc.procedure.input(pairingRevoke).mutation(({ ctx, input }) => controlCall(() => revokeBuilderPairing(pairingContext(ctx), input))),
		}),
		builderConnections: rpc.router({
			createReceipt: rpc.procedure.input(createReceiptInput).mutation(({ ctx, input }) =>
				controlCall(() => createBuilderConnectionReceipt(registryContext(ctx), pairingContext(ctx), input))
			),
			getReceipt: rpc.procedure.input(receiptAttemptId).query(({ ctx, input }) =>
				controlCall(() => getBuilderConnectionReceipt(registryContext(ctx), input.attemptId))
			),
		}),
		sourceConnection: rpc.router({
			list: rpc.procedure.input(sourceConnectionListInput).require(ACTIONS.SOURCE_CONNECTION_MANAGE).query(({ ctx, input }) =>
				controlCall(() => sourceConnectionList(sourceConnectionContext(ctx), input))
			),
			start: rpc.procedure.input(startSourceConnectionInput).require(ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => startSourceConnection(sourceConnectionContext(ctx), input))
			),
			verifyInstallation: rpc.procedure.input(sourceConnectionId).require(ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => verifySourceInstallation(sourceConnectionContext(ctx), input.connectionId))
			),
			repair: rpc.procedure.input(sourceConnectionId).require(ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => repairSourceConnection(sourceConnectionContext(ctx), input.connectionId))
			),
			reconcile: rpc.procedure.input(sourceConnectionId).require(ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => reconcileSourceConnection(sourceConnectionContext(ctx), input.connectionId))
			),
		}),
		apps: rpc.router({
			list: rpc.procedure.require(ACTIONS.APP_MANAGE).query(({ ctx }) => controlCall(() => listAppsUseCase(registryContext(ctx)))),
			get: rpc.procedure.input(appId).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
				controlCall(() => getAppUseCase(registryContext(ctx), input.appId))
			),
			create: rpc.procedure.input(createAppInput).require(ACTIONS.APP_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => createAppUseCase(registryContext(ctx), input))
			),
			update: rpc.procedure.input(updateAppInput).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => updateAppUseCase(registryContext(ctx), input.appId, input.app))
			),
			delete: rpc.procedure.input(appId).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => deleteAppUseCase(registryContext(ctx), input.appId))
			),
			environments: rpc.router({
				list: rpc.procedure.input(appId).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
					controlCall(() => listAppEnvsUseCase(registryContext(ctx), input.appId))
				),
				put: rpc.procedure.input(putEnvironmentInput).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => putAppEnvUseCase(registryContext(ctx), input.appId, input.env, input.environment))
				),
				delete: rpc.procedure.input(appEnvironment).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => deleteAppEnvUseCase(registryContext(ctx), input.appId, input.env))
				),
				// `access.approve` is checked at the coordinates inside, with the human and origin rules (ADR-0050 §4).
				protect: rpc.procedure.input(protectEnvironmentInput).mutation(({ ctx, input }) =>
					controlCall(() => setEnvironmentProtectionUseCase(approvalContext(ctx), input))
				),
			}),
			secrets: rpc.router({
				list: rpc.procedure.input(appId).require(ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
					controlCall(() => listAppSecretsUseCase(registryContext(ctx), input.appId))
				),
				put: rpc.procedure.input(putSecretInput).require(ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => putAppSecretUseCase(vaultContext(ctx), input.appId, input.secret))
				),
				delete: rpc.procedure.input(appNamedValue).require(ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => deleteAppSecretUseCase(registryContext(ctx), input.appId, input.name, input.env ?? null))
				),
			}),
			variables: rpc.router({
				list: rpc.procedure.input(appId).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
					controlCall(() => listAppVarsUseCase(registryContext(ctx), input.appId))
				),
				put: rpc.procedure.input(putVariableInput).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => putAppVarUseCase(registryContext(ctx), input.appId, input.variable))
				),
				delete: rpc.procedure.input(appNamedValue).require(ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => deleteAppVarUseCase(registryContext(ctx), input.appId, input.name, input.env ?? null))
				),
			}),
		}),
		vault: rpc.router({
			set: rpc.procedure.input(secretValueInput).require(ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => setAppSecretValueUseCase(vaultContext(ctx), input.appId, input.name, { value: input.value, env: input.env ?? null }))
			),
			rotate: rpc.procedure.input(secretValueInput).require(ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => rotateAppSecretValueUseCase(vaultContext(ctx), input.appId, input.name, { value: input.value, env: input.env ?? null }))
			),
			delete: rpc.procedure.input(appNamedValue).require(ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => deleteAppSecretValueUseCase(vaultContext(ctx), input.appId, input.name, input.env ?? null))
			),
		}),
		namespaces: rpc.router({
			list: rpc.procedure.require(ACTIONS.NAMESPACE_MANAGE).query(({ ctx }) => controlCall(() => listNamespacesUseCase(namespaceContext(ctx)))),
			get: rpc.procedure.input(namespaceId).require(ACTIONS.NAMESPACE_MANAGE).query(({ ctx, input }) =>
				controlCall(() => getNamespaceUseCase(namespaceContext(ctx), input.namespaceId))
			),
			plan: rpc.procedure.input(planNamespaceInput).require(ACTIONS.NAMESPACE_MANAGE).query(({ ctx, input }) =>
				controlCall(() => planNamespaceUseCase(namespaceContext(ctx), input))
			),
			create: rpc.procedure.input(namespaceBody).require(ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => createNamespaceUseCase(namespaceContext(ctx), input))
			),
			adopt: rpc.procedure.input(adoptNamespaceInput).require(ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => adoptNamespaceUseCase(namespaceContext(ctx), input.namespaceId, input.namespace))
			),
			reconcile: rpc.procedure.input(namespaceId).require(ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => reconcileNamespaceUseCase(namespaceContext(ctx), input.namespaceId))
			),
			update: rpc.procedure.input(updateNamespaceInput).require(ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => updateNamespaceUseCase(namespaceContext(ctx), input.namespaceId, input.namespace))
			),
			remove: rpc.procedure.input(namespaceId).require(ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => removeNamespaceUseCase(namespaceContext(ctx), input.namespaceId))
			),
		}),
		runs: rpc.router({
			list: rpc.procedure.input(runListInput).query(({ ctx, input }) => controlCall(() => listRunsUseCase(runsContext(ctx), input))),
			get: rpc.procedure.input(runId).query(({ ctx, input }) => controlCall(() => getRunUseCase(runsContext(ctx), input.runId))),
			log: rpc.procedure.input(runId).query(({ ctx, input }) => controlCall(() => getRunLogUseCase(runsContext(ctx), input.runId))),
			tail: rpc.procedure.input(tailRunInput).query(({ ctx, input }) =>
				controlCall(() => tailRunLogUseCase(runsContext(ctx), input.runId, input.after ?? 0))
			),
			cancel: rpc.procedure.input(runId).mutation(({ ctx, input }) => controlCall(() => cancelRunUseCase(runsContext(ctx), input.runId))),
		}),
		approvals: rpc.router({
			list: rpc.procedure.query(({ ctx }) => controlCall(() => listApprovalsUseCase(approvalContext(ctx)))),
			get: rpc.procedure.input(runId).query(({ ctx, input }) => controlCall(() => getApprovalUseCase(approvalContext(ctx), input.runId))),
			complete: rpc.procedure.input(completeApprovalInput).mutation(({ ctx, input }) =>
				controlCall(() => completeApprovalUseCase(approvalContext(ctx), input))
			),
		}),
		deploy: rpc.procedure.input(deployInput).mutation(({ ctx, input }) => controlCall(() => triggerDeployUseCase(runsContext(ctx), input))),
		register: rpc.procedure.input(registerInput).require(ACTIONS.APP_MANAGE).mutation(({ ctx, input }) =>
			controlCall(() => registerAppUseCase(registryContext(ctx), input))
		),
		connectors: rpc.router({
			describe: rpc.procedure.input(describeConnectorInput).require(ACTIONS.DEPLOY_READ, ({ consumer }) => appScope(consumer)).query(({ ctx, input }) =>
				controlCall(async () => {
					const description = await describeConnector(buildDeps(ctx.env, ctx.provider, ctx.auth).repositories.registry, input)
					return description ?? fail(404, `${input.app}@${input.env} has approved no export ${input.export}@${input.version} for ${input.consumer}`)
				})
			),
		}),
	})

	function pairingContext(ctx: ControlRpcContext): BuilderPairingContext {
		const deps = buildDeps(ctx.env, ctx.provider, ctx.auth)
		const iam = deps.builderPairingIam ?? ctx.env.IAM
		if (iam === undefined) fail(503, 'builder pairing unavailable')
		return { iam, auth: ctx.auth, request: ctx.request, repositories: deps.repositories }
	}

	function registryContext(ctx: ControlRpcContext): RegistryUseCaseContext {
		const deps = buildDeps(ctx.env, ctx.provider, ctx.auth)
		return {
			repositories: deps.repositories,
			provider: deps.provider,
			auth: ctx.auth,
			signal: ctx.request.signal,
			...(deps.catalogChanged === undefined ? {} : { catalogChanged: deps.catalogChanged }),
			...(deps.namespaceProxyChanged === undefined ? {} : { namespaceProxyChanged: deps.namespaceProxyChanged }),
			...(deps.commits === undefined ? {} : { commits: deps.commits }),
			admission: { request: ctx.request },
		}
	}

	function namespaceContext(ctx: ControlRpcContext): NamespaceUseCaseContext {
		const deps = buildDeps(ctx.env, ctx.provider, ctx.auth)
		return {
			repositories: deps.repositories,
			provider: deps.provider,
			auth: ctx.auth,
			signal: ctx.request.signal,
			queue: deps.queue,
			...(deps.namespaceProxyChanged === undefined ? {} : { namespaceProxyChanged: deps.namespaceProxyChanged }),
		}
	}

	function runsContext(ctx: ControlRpcContext): RunsUseCaseContext {
		const deps = buildDeps(ctx.env, ctx.provider, ctx.auth)
		return { repositories: deps.repositories, queue: deps.queue, logs: deps.logs, cancel: deps.cancelRun, auth: ctx.auth }
	}

	function approvalContext(ctx: ControlRpcContext): ApprovalUseCaseContext {
		const deps = buildDeps(ctx.env, ctx.provider, ctx.auth)
		if (deps.lock === undefined) fail(503, 'approvals unavailable')
		return {
			repositories: deps.repositories,
			auth: ctx.auth,
			queue: deps.queue,
			lock: deps.lock,
			request: ctx.request,
		}
	}

	function vaultContext(ctx: ControlRpcContext): VaultUseCaseContext {
		const deps = buildDeps(ctx.env, ctx.provider, ctx.auth)
		return {
			repositories: deps.repositories,
			provider: deps.provider,
			auth: ctx.auth,
			...(deps.vault === undefined ? {} : { vault: deps.vault }),
		}
	}
}

function sourceConnectionContext(ctx: ControlRpcContext) {
	return { env: ctx.env, source: ctx.sourceConnection, auth: ctx.auth, request: ctx.request }
}

/** Apply domain value constraints at the RPC input boundary. */
function refuses(assert: (value: string) => void): (value: string) => boolean {
	return (value) => {
		try {
			assert(value)
			return true
		} catch {
			return false
		}
	}
}

async function controlCall<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run()
	} catch (cause) {
		if (isStructuralError(cause)) throw cause
		console.error('control RPC request failed')
		throw new HttpError(500, 'internal', 'internal error')
	}
}
