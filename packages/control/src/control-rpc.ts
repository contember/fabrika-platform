import { initRpc, type RpcRouterFor } from '@fabrika/app'
import type { AuthContext } from '@fabrika/auth'
import {
	type ControlRpcContract,
	GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE,
	GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH,
	type GitHubSourceConnectionListInput,
	type GitHubSourceConnectionListResponse,
	type GitHubSourceConnectionStatusDto,
	type ProviderEnvelopeDto,
} from '@fabrika/control-contract'
import type { ControlProvider, JsonValue } from '@fabrika/provider-contract'
import { z } from 'zod'
import { ACTIONS } from './actions'
import {
	adoptNamespaceUseCase,
	createNamespaceUseCase,
	getNamespaceUseCase,
	listNamespacesUseCase,
	type NamespaceUseCaseContext,
	planNamespaceUseCase,
	reconcileNamespaceUseCase,
} from './api/namespaces'
import { isJsonValue, readProviderEnvelope } from './api/provider-envelope'
import {
	createAppUseCase,
	deleteAppEnvUseCase,
	deleteAppSecretUseCase,
	deleteAppUseCase,
	deleteAppVarUseCase,
	getAppUseCase,
	listAppEnvsUseCase,
	listAppSecretsUseCase,
	listAppsUseCase,
	listAppVarsUseCase,
	putAppEnvUseCase,
	putAppSecretUseCase,
	putAppVarUseCase,
	registerAppUseCase,
	type RegistryUseCaseContext,
	updateAppUseCase,
} from './api/registry'
import {
	cancelRunUseCase,
	getRunLogUseCase,
	getRunUseCase,
	listRunsUseCase,
	type RunsUseCaseContext,
	tailRunLogUseCase,
	triggerDeployUseCase,
} from './api/runs'
import { deleteAppSecretValueUseCase, rotateAppSecretValueUseCase, setAppSecretValueUseCase, type VaultUseCaseContext } from './api/vault'
import type { Env } from './env'
import { appScope } from './iam'
import { buildApiDeps } from './services'
import {
	adoptExistingSourceConnection,
	reconcileSourceConnection,
	repairSourceConnection,
	sourceConnectionList,
	sourceConnectionStatus,
	startSourceConnection,
	verifySourceInstallation,
} from './source-connection'
import type { SourceConnectionPort } from './source-connection-port'

interface ControlRpcContext {
	readonly env: Env
	readonly provider: ControlProvider
	readonly sourceConnection: SourceConnectionPort
	readonly request: Request
	readonly auth: AuthContext
}

const rpc = initRpc<ControlRpcContext>()
const nonEmpty = z.string().min(1)
const nullableString = z.string().nullable().optional()
const providerEnvelope = z.custom<ProviderEnvelopeDto>((value) => readProviderEnvelope(value) !== null, 'expected a versioned provider envelope')
const jsonValue = z.custom<JsonValue>(isJsonValue, 'expected JSON')
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
	namespaceId: nullableString,
	target: providerEnvelope,
	artifact: providerEnvelope,
})
const putEnvironmentInput = z.object({ appId: nonEmpty, env: nonEmpty, environment: appEnvironmentBody })
const secretBody = z.object({ name: nonEmpty, valueRef: nonEmpty, env: nullableString })
const putSecretInput = z.object({ appId: nonEmpty, secret: secretBody })
const variableBody = z.object({ name: nonEmpty, value: nonEmpty, env: nullableString })
const putVariableInput = z.object({ appId: nonEmpty, variable: variableBody })
const secretValueInput = z.object({ appId: nonEmpty, name: nonEmpty, env: nullableString, value: z.string() })
const namespaceId = z.object({ namespaceId: nonEmpty })
const namespaceBody = z.object({ id: nonEmpty, env: nonEmpty, exclusiveAppId: nullableString, target: providerEnvelope })
const adoptNamespaceInput = z.object({ namespaceId: nonEmpty, namespace: namespaceBody.omit({ id: true }) })
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
	target: providerEnvelope,
	artifact: providerEnvelope,
	...appOptionalFields,
})
const githubOwner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
const githubRepositoryName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)
const sourceConnectionId = z.object({ connectionId: z.string().min(1).max(128) }).strict()
const sourceConnectionListInput = z.object({
	cursor: z.string().min(1).max(GITHUB_SOURCE_CONNECTION_PAGE_CURSOR_MAX_LENGTH).optional(),
	limit: z.number().int().min(1).max(GITHUB_SOURCE_CONNECTION_MAX_PAGE_SIZE).optional(),
}).strict()
const startSourceConnectionInput = z.object({
	organization: githubOwner,
	appName: z.string().min(1).max(100),
	visibility: z.enum(['private', 'public']),
	repositories: z.array(z.object({ owner: githubOwner, name: githubRepositoryName }).strict()).max(100),
}).strict()

export const controlRpcRouter: RpcRouterFor<ControlRpcContext, ControlRpcContract> = rpc.router({
	sourceConnection: rpc.router({
		status: rpc.procedure.require(ACTIONS.SOURCE_CONNECTION_MANAGE).query(({ ctx }) =>
			controlCall(() => sourceConnectionStatus(sourceConnectionContext(ctx)))
		),
		list: rpc.procedure.input(sourceConnectionListInput).require(ACTIONS.SOURCE_CONNECTION_MANAGE).query(({ ctx, input }) =>
			controlCall(() => sourceConnectionList(sourceConnectionContext(ctx), input))
		),
		start: rpc.procedure.input(startSourceConnectionInput).require(ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
			controlCall(() => startSourceConnection(sourceConnectionContext(ctx), input))
		),
		adoptExisting: rpc.procedure.require(ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx }) =>
			controlCall(() => adoptExistingSourceConnection(sourceConnectionContext(ctx)))
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
		}),
		secrets: rpc.router({
			list: rpc.procedure.input(appId).require(ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
				controlCall(() => listAppSecretsUseCase(registryContext(ctx), input.appId))
			),
			put: rpc.procedure.input(putSecretInput).require(ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => putAppSecretUseCase(registryContext(ctx), input.appId, input.secret))
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
	deploy: rpc.procedure.input(deployInput).mutation(({ ctx, input }) => controlCall(() => triggerDeployUseCase(runsContext(ctx), input))),
	register: rpc.procedure.input(registerInput).require(ACTIONS.APP_MANAGE).mutation(({ ctx, input }) =>
		controlCall(() => registerAppUseCase(registryContext(ctx), input))
	),
})

/** Frozen compatibility helper for older direct callers; the RPC list uses keyed persistence. */
export function projectSingletonSourceConnectionPage(
	status: GitHubSourceConnectionStatusDto,
	input: GitHubSourceConnectionListInput,
): GitHubSourceConnectionListResponse {
	if (status.state === 'connected') {
		return { items: input.cursor === undefined ? [status] : [], nextCursor: null, workflow: null }
	}
	return { items: [], nextCursor: null, workflow: status }
}

function sourceConnectionContext(ctx: ControlRpcContext) {
	return { env: ctx.env, source: ctx.sourceConnection, auth: ctx.auth, request: ctx.request }
}

function registryContext(ctx: ControlRpcContext): RegistryUseCaseContext {
	const deps = buildApiDeps(ctx.env, ctx.provider, ctx.auth)
	return {
		repositories: deps.repositories,
		repoSource: deps.repoSource,
		provider: deps.provider,
		auth: ctx.auth,
		signal: ctx.request.signal,
		...(deps.catalogChanged === undefined ? {} : { catalogChanged: deps.catalogChanged }),
	}
}

function namespaceContext(ctx: ControlRpcContext): NamespaceUseCaseContext {
	const deps = buildApiDeps(ctx.env, ctx.provider, ctx.auth)
	return { repositories: deps.repositories, provider: deps.provider, auth: ctx.auth, signal: ctx.request.signal }
}

function runsContext(ctx: ControlRpcContext): RunsUseCaseContext {
	const deps = buildApiDeps(ctx.env, ctx.provider, ctx.auth)
	return { repositories: deps.repositories, queue: deps.queue, logs: deps.logs, cancel: deps.cancelRun, auth: ctx.auth }
}

function vaultContext(ctx: ControlRpcContext): VaultUseCaseContext {
	const deps = buildApiDeps(ctx.env, ctx.provider, ctx.auth)
	return {
		repositories: deps.repositories,
		provider: deps.provider,
		auth: ctx.auth,
		...(deps.vault === undefined ? {} : { vault: deps.vault }),
	}
}

async function controlCall<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run()
	} catch (cause) {
		if (isStructuralError(cause)) throw cause
		console.error('control RPC request failed')
		throw Object.assign(new Error('internal error'), { httpStatus: 500, type: 'internal' })
	}
}

function isStructuralError(cause: unknown): boolean {
	return typeof cause === 'object'
		&& cause !== null
		&& typeof Reflect.get(cause, 'httpStatus') === 'number'
		&& typeof Reflect.get(cause, 'type') === 'string'
}
