import { HttpError, initRpc, isStructuralError, type RpcRouterFor } from '@fabrika/app'
import type { AuthContext } from '@fabrika/auth'
import { DEFAULT_APPLICATION_OBJECT, type OpsContentView, type OpsView, parseAppEnvironmentId } from '@fabrika/auth-core'
import {
	APP_ENV_KINDS,
	BUILDER_APPROVAL_VERIFIER,
	BUILDER_CONNECTION_ATTEMPT_ID,
	BUILDER_CONNECTION_IDENTIFIER,
	CONTROL_ACTIONS,
	type ControlRpcContract,
	type CursorList,
	DATA_OPERATION_MAX_PAGE_SIZE,
	type DataOperationDto,
	type DataOperationListInput,
	dataOperationListInputSchema,
	githubSourceConnectionListInputSchema,
	type MailContentDto,
	type MailMessageDetailDto,
	type MailMessageDto,
	type MailRuleDto,
	type RecoverDataOperationInput,
	recoverDataOperationInputSchema,
	type StartDataOperationInput,
	startDataOperationInputSchema,
} from '@fabrika/control-contract'
import { parsePlatformMailRequest } from '@fabrika/email/platform'
import { type DeployLocks, uuidv7 } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { isProxyHost } from '@fabrika/proxy-core/manifest'
import { z } from 'zod'
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
	releaseNamespaceClaimsUseCase,
	removeNamespaceUseCase,
	republishAllNamespacesUseCase,
	updateNamespaceUseCase,
} from './api/namespaces'
import { providerEnvelopeSchema } from './api/provider-envelope'
import { createAppUseCase, deleteAppUseCase, getAppUseCase, listAppsUseCase, updateAppUseCase } from './api/registry/apps'
import { deleteAppVarUseCase, listAppSecretsUseCase, listAppVarsUseCase, putAppVarUseCase } from './api/registry/configuration'
import { type RegistryUseCaseContext } from './api/registry/context'
import { deleteAppEnvUseCase, listAppEnvsUseCase, putAppEnvUseCase, rotateTokenKeyUseCase } from './api/registry/environments'
import { registerAppUseCase } from './api/registry/registration'
import { APP_VAR_VALUE_MAX_LENGTH, assertAppVarValue } from './api/registry/validation'
import {
	canAtCoordinates,
	cancelRunUseCase,
	getRunLogUseCase,
	getRunUseCase,
	listLatestFailedRunsUseCase,
	listRunsUseCase,
	runActor,
	type RunsUseCaseContext,
	tailRunLogUseCase,
	triggerDeployUseCase,
} from './api/runs'
import {
	deleteAppSecretUseCase,
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
import {
	type DataOperationOutcome,
	listDataOperations,
	type OpsInspection,
	type OpsTransport,
	type OpsUnavailable,
	startMaintenance,
	startRecovery,
	toDataOperationDto,
} from './data-operations'
import type { ControlRepositories, MailMessageRow, MailRuleRow } from './db'
import type { Env } from './env'
import { reconcileSourceConnection, repairSourceConnection, verifySourceInstallation } from './github/connections/installation'
import { startSourceConnection } from './github/connections/manifest'
import type { SourceConnectionPort } from './github/connections/port'
import { sourceConnectionList } from './github/connections/status'
import { appScope } from './iam'
import { jsonValueSchema } from './json-value'
import { isInstallationSender, type MailRelay, mayRequeueMail, releaseMailMessage, requeueMailMessage } from './mail-relay/queue'
import { buildControlRpcDeps, type ControlRpcDeps } from './services'

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
// Shape only: `assertCrossOrigins` judges each origin against the environment's domain and answers which one is wrong.
const crossOrigins = z.array(z.string()).optional()
const appEnvironmentBody = z.object({
	domain: nullableString,
	publicOrigin: nullableString,
	crossOrigins,
	triggerRef: nullableString,
	authoring: z.boolean().optional(),
	kind: z.enum(APP_ENV_KINDS).optional(),
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
const releaseClaimsInput = z.object({ namespaceId: nonEmpty, appId: nonEmpty, env: nonEmpty })
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
	statuses: z.array(z.enum(['pending', 'running', 'awaiting_approval', 'succeeded', 'failed'])).min(1).max(5).optional(),
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
	crossOrigins,
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

const MAIL_RULE_ANY = '*'
/** A view is read live, within one request. */
const DATA_VIEW_TIMEOUT_MS = 30_000
const MAIL_PAGE_SIZE = 50

const mailMessageState = z.enum(['held', 'queued', 'sending', 'sent', 'failed', 'unknown', 'dropped'])
const mailMessageListInput = z.object({ state: mailMessageState.optional(), scope: nonEmpty.optional(), cursor: nonEmpty.optional() }).strict()
const mailId = z.object({ id: nonEmpty }).strict()
const setMailRuleInput = z.object({
	scope: z.string().refine((scope) => scope === MAIL_RULE_ANY || parseAppEnvironmentId(scope) !== null, 'scope must be * or <app>@<env>'),
	domain: z.string().refine((domain) => domain === MAIL_RULE_ANY || isProxyHost(domain), 'domain must be * or a lowercase domain'),
	action: z.enum(['pass', 'hold', 'drop']),
}).strict()

const dataOperationId = z.object({ operationId: nonEmpty }).strict()
const dataEnvironment = appEnvironment.strict()

/** The composition's deps; without an ops transport the `data.*` procedures that call an object answer 503. */
type ControlRpcDepsBuilder = (...args: Parameters<typeof buildControlRpcDeps>) => ControlRpcDeps & { readonly opsTransport?: OpsTransport }

export const controlRpcRouter = createControlRpcRouter(buildControlRpcDeps)

export function createControlRpcRouter(buildDeps: ControlRpcDepsBuilder): RpcRouterFor<ControlRpcContext, ControlRpcContract> {
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
			list: rpc.procedure.input(sourceConnectionListInput).require(CONTROL_ACTIONS.SOURCE_CONNECTION_MANAGE).query(({ ctx, input }) =>
				controlCall(() => sourceConnectionList(sourceConnectionContext(ctx), input))
			),
			start: rpc.procedure.input(startSourceConnectionInput).require(CONTROL_ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => startSourceConnection(sourceConnectionContext(ctx), input))
			),
			verifyInstallation: rpc.procedure.input(sourceConnectionId).require(CONTROL_ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => verifySourceInstallation(sourceConnectionContext(ctx), input.connectionId))
			),
			repair: rpc.procedure.input(sourceConnectionId).require(CONTROL_ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => repairSourceConnection(sourceConnectionContext(ctx), input.connectionId))
			),
			reconcile: rpc.procedure.input(sourceConnectionId).require(CONTROL_ACTIONS.SOURCE_CONNECTION_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => reconcileSourceConnection(sourceConnectionContext(ctx), input.connectionId))
			),
		}),
		apps: rpc.router({
			list: rpc.procedure.require(CONTROL_ACTIONS.APP_MANAGE).query(({ ctx }) => controlCall(() => listAppsUseCase(registryContext(ctx)))),
			get: rpc.procedure.input(appId).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
				controlCall(() => getAppUseCase(registryContext(ctx), input.appId))
			),
			create: rpc.procedure.input(createAppInput).require(CONTROL_ACTIONS.APP_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => createAppUseCase(registryContext(ctx), input))
			),
			update: rpc.procedure.input(updateAppInput).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => updateAppUseCase(registryContext(ctx), input.appId, input.app))
			),
			delete: rpc.procedure.input(appId).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => deleteAppUseCase(registryContext(ctx), input.appId))
			),
			environments: rpc.router({
				list: rpc.procedure.input(appId).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
					controlCall(() => listAppEnvsUseCase(registryContext(ctx), input.appId))
				),
				put: rpc.procedure.input(putEnvironmentInput).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => putAppEnvUseCase(registryContext(ctx), input.appId, input.env, input.environment))
				),
				delete: rpc.procedure.input(appEnvironment).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => deleteAppEnvUseCase(registryContext(ctx), input.appId, input.env))
				),
				// `access.approve` is checked at the coordinates inside, with the human and origin rules (ADR-0050 §4).
				protect: rpc.procedure.input(protectEnvironmentInput).mutation(({ ctx, input }) =>
					controlCall(() => setEnvironmentProtectionUseCase(approvalContext(ctx), input))
				),
				rotateTokenKey: rpc.procedure.input(appEnvironment).require(CONTROL_ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation((
					{ ctx, input },
				) => controlCall(() => rotateTokenKeyUseCase(registryContext(ctx), input.appId, input.env, Math.floor(Date.now() / 1000)))),
			}),
			secrets: rpc.router({
				list: rpc.procedure.input(appId).require(CONTROL_ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
					controlCall(() => listAppSecretsUseCase(registryContext(ctx), input.appId))
				),
				put: rpc.procedure.input(putSecretInput).require(CONTROL_ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => putAppSecretUseCase(vaultContext(ctx), input.appId, input.secret))
				),
				delete: rpc.procedure.input(appNamedValue).require(CONTROL_ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => deleteAppSecretUseCase(vaultContext(ctx), input.appId, input.name, input.env ?? null))
				),
			}),
			variables: rpc.router({
				list: rpc.procedure.input(appId).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).query(({ ctx, input }) =>
					controlCall(() => listAppVarsUseCase(registryContext(ctx), input.appId))
				),
				put: rpc.procedure.input(putVariableInput).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => putAppVarUseCase(registryContext(ctx), input.appId, input.variable))
				),
				delete: rpc.procedure.input(appNamedValue).require(CONTROL_ACTIONS.APP_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
					controlCall(() => deleteAppVarUseCase(registryContext(ctx), input.appId, input.name, input.env ?? null))
				),
			}),
		}),
		vault: rpc.router({
			set: rpc.procedure.input(secretValueInput).require(CONTROL_ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => setAppSecretValueUseCase(vaultContext(ctx), input.appId, input.name, { value: input.value, env: input.env ?? null }))
			),
			rotate: rpc.procedure.input(secretValueInput).require(CONTROL_ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => rotateAppSecretValueUseCase(vaultContext(ctx), input.appId, input.name, { value: input.value, env: input.env ?? null }))
			),
			delete: rpc.procedure.input(appNamedValue).require(CONTROL_ACTIONS.SECRET_MANAGE, ({ appId }) => appScope(appId)).mutation(({ ctx, input }) =>
				controlCall(() => deleteAppSecretUseCase(vaultContext(ctx), input.appId, input.name, input.env ?? null))
			),
		}),
		namespaces: rpc.router({
			list: rpc.procedure.require(CONTROL_ACTIONS.NAMESPACE_MANAGE).query(({ ctx }) => controlCall(() => listNamespacesUseCase(namespaceContext(ctx)))),
			get: rpc.procedure.input(namespaceId).require(CONTROL_ACTIONS.NAMESPACE_MANAGE).query(({ ctx, input }) =>
				controlCall(() => getNamespaceUseCase(namespaceContext(ctx), input.namespaceId))
			),
			plan: rpc.procedure.input(planNamespaceInput).require(CONTROL_ACTIONS.NAMESPACE_MANAGE).query(({ ctx, input }) =>
				controlCall(() => planNamespaceUseCase(namespaceContext(ctx), input))
			),
			create: rpc.procedure.input(namespaceBody).require(CONTROL_ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => createNamespaceUseCase(namespaceContext(ctx), input))
			),
			adopt: rpc.procedure.input(adoptNamespaceInput).require(CONTROL_ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => adoptNamespaceUseCase(namespaceContext(ctx), input.namespaceId, input.namespace))
			),
			reconcile: rpc.procedure.input(namespaceId).require(CONTROL_ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => reconcileNamespaceUseCase(namespaceContext(ctx), input.namespaceId))
			),
			update: rpc.procedure.input(updateNamespaceInput).require(CONTROL_ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => updateNamespaceUseCase(namespaceContext(ctx), input.namespaceId, input.namespace))
			),
			remove: rpc.procedure.input(namespaceId).require(CONTROL_ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => removeNamespaceUseCase(namespaceContext(ctx), input.namespaceId))
			),
			republishAll: rpc.procedure.require(CONTROL_ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx }) =>
				controlCall(() => republishAllNamespacesUseCase(namespaceContext(ctx)))
			),
			releaseClaims: rpc.procedure.input(releaseClaimsInput).require(CONTROL_ACTIONS.NAMESPACE_MANAGE).mutation(({ ctx, input }) =>
				controlCall(() => releaseNamespaceClaimsUseCase(namespaceContext(ctx), input))
			),
		}),
		runs: rpc.router({
			list: rpc.procedure.input(runListInput).query(({ ctx, input }) => controlCall(() => listRunsUseCase(runsContext(ctx), input))),
			latestFailures: rpc.procedure.query(({ ctx }) => controlCall(() => listLatestFailedRunsUseCase(runsContext(ctx)))),
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
		register: rpc.procedure.input(registerInput).require(CONTROL_ACTIONS.APP_MANAGE).mutation(({ ctx, input }) =>
			controlCall(() => registerAppUseCase(registryContext(ctx), input))
		),
		connectors: rpc.router({
			describe: rpc.procedure.input(describeConnectorInput).require(CONTROL_ACTIONS.DEPLOY_READ, ({ consumer }) => appScope(consumer)).query((
				{ ctx, input },
			) =>
				controlCall(async () => {
					const description = await describeConnector(buildDeps(ctx.env, ctx.provider, ctx.auth).repositories.registry, input)
					return description ?? fail(404, `${input.app}@${input.env} has approved no export ${input.export}@${input.version} for ${input.consumer}`)
				})
			),
		}),
		mail: rpc.router({
			messages: rpc.router({
				list: rpc.procedure.input(mailMessageListInput).query(({ ctx, input }) => controlCall(() => listMailMessages(mailContext(ctx), input))),
				get: rpc.procedure.input(mailId).query(({ ctx, input }) => controlCall(() => getMailMessage(mailContext(ctx), input.id))),
				release: rpc.procedure.input(mailId).require(CONTROL_ACTIONS.MAIL_MANAGE).mutation(({ ctx, input }) =>
					controlCall(() => releaseHeldMailMessage(mailContext(ctx), input.id))
				),
				drop: rpc.procedure.input(mailId).require(CONTROL_ACTIONS.MAIL_MANAGE).mutation(({ ctx, input }) =>
					controlCall(() => dropHeldMailMessage(mailContext(ctx), input.id))
				),
				requeue: rpc.procedure.input(mailId).require(CONTROL_ACTIONS.MAIL_MANAGE).mutation(({ ctx, input }) =>
					controlCall(() => requeueFinalMailMessage(mailContext(ctx), input.id))
				),
			}),
			rules: rpc.router({
				list: rpc.procedure.require(CONTROL_ACTIONS.MAIL_MANAGE).query(({ ctx }) =>
					controlCall(async () => ({ items: (await mailContext(ctx).repositories.mailRules.list()).map(toMailRuleDto) }))
				),
				set: rpc.procedure.input(setMailRuleInput).require(CONTROL_ACTIONS.MAIL_MANAGE).mutation(({ ctx, input }) =>
					controlCall(() => setMailRule(mailContext(ctx), input))
				),
				remove: rpc.procedure.input(mailId).require(CONTROL_ACTIONS.MAIL_MANAGE).mutation(({ ctx, input }) =>
					controlCall(async () => {
						if (!(await mailContext(ctx).repositories.mailRules.remove(input.id))) fail(404, 'mail rule not found')
						return { ok: true }
					})
				),
			}),
		}),
		// An application environment's data (ADR-0069 §2): `data.read` and `data.manage` at the coordinates, hidden as 404
		// like runs; `data.content.read` as a global grant only.
		data: rpc.router({
			operations: rpc.router({
				list: rpc.procedure.input(dataOperationListInputSchema).query(({ ctx, input }) =>
					controlCall(() => listDataOperationsUseCase(dataContext(ctx), input))
				),
				get: rpc.procedure.input(dataOperationId).query(({ ctx, input }) =>
					controlCall(() => getDataOperationUseCase(dataContext(ctx), input.operationId))
				),
			}),
			view: rpc.procedure.input(dataEnvironment).query(({ ctx, input }) => controlCall(() => readDataViewUseCase(dataContext(ctx), input))),
			content: rpc.procedure.input(dataEnvironment).query(({ ctx, input }) => controlCall(() => readDataContentUseCase(dataContext(ctx), input))),
			start: rpc.procedure.input(startDataOperationInputSchema).mutation(({ ctx, input }) =>
				controlCall(() => startDataOperationUseCase(dataContext(ctx), input))
			),
			recover: rpc.procedure.input(recoverDataOperationInputSchema).mutation(({ ctx, input }) =>
				controlCall(() => recoverDataOperationUseCase(dataContext(ctx), input))
			),
		}),
	})

	function dataContext(ctx: ControlRpcContext): DataUseCaseContext {
		const deps = buildDeps(ctx.env, ctx.provider, ctx.auth)
		return {
			repositories: deps.repositories,
			auth: ctx.auth,
			...(deps.lock === undefined ? {} : { lock: deps.lock }),
			...(deps.opsTransport === undefined ? {} : { ops: deps.opsTransport }),
		}
	}

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
			...(deps.brand === undefined ? {} : { brand: deps.brand }),
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

	function mailContext(ctx: ControlRpcContext): MailUseCaseContext {
		const deps = buildDeps(ctx.env, ctx.provider, ctx.auth)
		return { repositories: deps.repositories, auth: ctx.auth, ...(deps.mailRelay === undefined ? {} : { mailRelay: deps.mailRelay }) }
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

interface MailUseCaseContext {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
	/** Absent where no dispatcher runs (the Worker): a release or a requeue answers 503 there. */
	readonly mailRelay?: Pick<MailRelay, 'queue' | 'sender'>
}

/**
 * Whether the caller reads the messages of `sender`: an application's at its app or environment, an installation
 * service's only globally. A sender that is neither is no one's to read.
 */
function readsMailOf(auth: AuthContext, sender: string): boolean {
	if (isInstallationSender(sender)) return auth.can(CONTROL_ACTIONS.MAIL_READ)
	const coordinates = parseAppEnvironmentId(sender)
	return coordinates !== null && canAtCoordinates(auth, CONTROL_ACTIONS.MAIL_READ, coordinates.app, coordinates.env)
}

/** As `runs.list`: the whole list needs a global `mail.read`; one sender's, the grant that reads that sender. */
async function listMailMessages(c: MailUseCaseContext, input: z.infer<typeof mailMessageListInput>): Promise<CursorList<MailMessageDto>> {
	const allowed = input.scope === undefined ? c.auth.can(CONTROL_ACTIONS.MAIL_READ) : readsMailOf(c.auth, input.scope)
	if (!allowed) fail(403, `not authorized: ${CONTROL_ACTIONS.MAIL_READ}`)
	const rows = await c.repositories.mailMessages.list({
		...(input.state === undefined ? {} : { state: input.state }),
		...(input.scope === undefined ? {} : { sender: input.scope }),
		...(input.cursor === undefined ? {} : { before: input.cursor }),
		limit: MAIL_PAGE_SIZE,
	})
	const last = rows.at(-1)
	return { items: rows.map(toMailMessageDto), nextCursor: rows.length === MAIL_PAGE_SIZE && last !== undefined ? last.id : null }
}

async function getMailMessage(c: MailUseCaseContext, id: string): Promise<MailMessageDetailDto> {
	const row = await c.repositories.mailMessages.get(id)
	if (row === null || !readsMailOf(c.auth, row.sender)) fail(404, 'mail message not found')
	return {
		...toMailMessageDto(row),
		content: mailContentOf(c.auth, row),
		requeueable: c.mailRelay !== undefined && mayRequeueMail(row, c.mailRelay.sender),
	}
}

/** An installation service's mail carries one-time links (enrollment, password reset), so no caller reads it (ADR-0019 §8). */
function mailContentOf(auth: AuthContext, row: MailMessageRow): MailContentDto {
	if (isInstallationSender(row.sender) || !auth.can(CONTROL_ACTIONS.MAIL_CONTENT_READ)) return { kind: 'withheld' }
	if (row.content === null) return { kind: 'purged' }
	const parsed = parsePlatformMailRequest(JSON.parse(row.content))
	if (!parsed.ok) throw new Error('stored mail content does not parse')
	const { to, subject, text, html, replyTo, fromName, unsubscribeUrl, broadcast, attachments } = parsed.message
	return {
		kind: 'present',
		message: {
			to,
			subject,
			text,
			...(html === undefined ? {} : { html }),
			...(replyTo === undefined ? {} : { replyTo }),
			...(fromName === undefined ? {} : { fromName }),
			...(unsubscribeUrl === undefined ? {} : { unsubscribeUrl }),
			...(broadcast === true ? { broadcast: true } : {}),
			attachments: (attachments ?? []).map((attachment) => ({
				filename: attachment.filename,
				contentType: attachment.contentType,
				bytes: attachment.content.byteLength,
			})),
		},
	}
}

async function releaseHeldMailMessage(c: MailUseCaseContext, id: string): Promise<MailMessageDto> {
	if (c.mailRelay === undefined) fail(503, 'the mail relay is unavailable')
	const released = await releaseMailMessage({ messages: c.repositories.mailMessages, queue: c.mailRelay.queue }, id, runActor(c.auth), nowSeconds())
	return await decidedMailMessage(c, id, released)
}

async function dropHeldMailMessage(c: MailUseCaseContext, id: string): Promise<MailMessageDto> {
	const dropped = await c.repositories.mailMessages.drop(id, runActor(c.auth), nowSeconds())
	return await decidedMailMessage(c, id, dropped)
}

async function requeueFinalMailMessage(c: MailUseCaseContext, id: string): Promise<MailMessageDto> {
	if (c.mailRelay === undefined) fail(503, 'the mail relay is unavailable')
	const deps = { messages: c.repositories.mailMessages, queue: c.mailRelay.queue, sender: c.mailRelay.sender }
	const requeued = await requeueMailMessage(deps, id, runActor(c.auth), nowSeconds())
	return await decidedMailMessage(c, id, requeued, 'the message is not failed, or unknown over an idempotent transport, with its content kept')
}

/** The message after a decision; `decided` false means it was not in a state the decision takes, or does not exist. */
async function decidedMailMessage(
	c: MailUseCaseContext,
	id: string,
	decided: boolean,
	conflict = 'the message is not held',
): Promise<MailMessageDto> {
	const row = await c.repositories.mailMessages.get(id)
	if (row === null) fail(404, 'mail message not found')
	if (!decided) fail(409, conflict)
	return toMailMessageDto(row)
}

/** A rule's scope names an application environment that exists, so a typo cannot leave a rule that never matches. */
async function setMailRule(c: MailUseCaseContext, input: z.infer<typeof setMailRuleInput>): Promise<MailRuleDto> {
	const coordinates = parseAppEnvironmentId(input.scope)
	if (coordinates !== null && (await c.repositories.registry.getAppEnv(coordinates.app, coordinates.env)) === null) {
		fail(400, `no application environment ${input.scope}`)
	}
	return toMailRuleDto(await c.repositories.mailRules.upsert({ id: uuidv7(), ...input }, nowSeconds()))
}

interface DataUseCaseContext {
	readonly repositories: ControlRepositories
	readonly auth: AuthContext
	/** The environment's deploy lease every operation runs under; absent, operations answer 503. */
	readonly lock?: DeployLocks
	/** The ops channel; absent, the views and operations answer 503. */
	readonly ops?: OpsTransport
}

/** An environment the caller may act on with `action`; any other, existing or not, is the same 404. */
async function requireDataEnvironment(c: DataUseCaseContext, action: string, appId: string, env: string): Promise<void> {
	if (!canAtCoordinates(c.auth, action, appId, env) || (await c.repositories.registry.getAppEnv(appId, env)) === null) {
		fail(404, 'app env not found')
	}
}

async function listDataOperationsUseCase(c: DataUseCaseContext, input: DataOperationListInput): Promise<CursorList<DataOperationDto>> {
	await requireDataEnvironment(c, CONTROL_ACTIONS.DATA_READ, input.appId, input.env)
	const limit = input.limit ?? DATA_OPERATION_MAX_PAGE_SIZE
	const items = await listDataOperations(c, input, { ...(input.before === undefined ? {} : { before: input.before }), limit })
	const last = items.at(-1)
	return { items, nextCursor: items.length === limit && last !== undefined ? last.id : null }
}

async function getDataOperationUseCase(c: DataUseCaseContext, id: string): Promise<DataOperationDto> {
	const row = await c.repositories.dataOperations.get(id)
	if (row === null || !canAtCoordinates(c.auth, CONTROL_ACTIONS.DATA_READ, row.app_id, row.env)) fail(404, 'data operation not found')
	return toDataOperationDto(row)
}

/** The allowlisted projection: an answer that carries content is refused, never passed on. */
async function readDataViewUseCase(c: DataUseCaseContext, input: { appId: string; env: string }): Promise<OpsView> {
	await requireDataEnvironment(c, CONTROL_ACTIONS.DATA_READ, input.appId, input.env)
	const inspection = await inspectData(c, input, false)
	if (inspection.content) fail(502, 'the environment answered a metadata request with content')
	return inspection.view
}

/** A global `data.content.read` only: any narrower grant gets the same 404 as an environment that does not exist. */
async function readDataContentUseCase(c: DataUseCaseContext, input: { appId: string; env: string }): Promise<OpsContentView> {
	if (!c.auth.can(CONTROL_ACTIONS.DATA_CONTENT_READ) || (await c.repositories.registry.getAppEnv(input.appId, input.env)) === null) {
		fail(404, 'app env not found')
	}
	const inspection = await inspectData(c, input, true)
	if (!inspection.content) fail(502, 'the environment answered a content request without content')
	return inspection.view
}

async function inspectData(c: DataUseCaseContext, target: { appId: string; env: string }, content: boolean): Promise<OpsInspection> {
	if (c.ops === undefined) fail(503, 'data operations unavailable')
	const answer = await c.ops.inspect(target, { object: DEFAULT_APPLICATION_OBJECT, content }, AbortSignal.timeout(DATA_VIEW_TIMEOUT_MS))
	if (answer.kind === 'unavailable') failUnavailable(answer.reason)
	return answer.value
}

async function startDataOperationUseCase(c: DataUseCaseContext, input: StartDataOperationInput): Promise<DataOperationDto> {
	await requireDataEnvironment(c, CONTROL_ACTIONS.DATA_MANAGE, input.appId, input.env)
	if (input.kind === 'backup') fail(501, 'backups are not available in this release')
	const outcome = await startMaintenance(operationDeps(c), { appId: input.appId, env: input.env, mode: input.mode, actor: runActor(c.auth) })
	return dataOperationResult(outcome)
}

async function recoverDataOperationUseCase(c: DataUseCaseContext, input: RecoverDataOperationInput): Promise<DataOperationDto> {
	await requireDataEnvironment(c, CONTROL_ACTIONS.DATA_MANAGE, input.appId, input.env)
	return dataOperationResult(await startRecovery(operationDeps(c), { ...input, actor: runActor(c.auth) }))
}

function operationDeps(c: DataUseCaseContext): { repositories: ControlRepositories; lock: DeployLocks; ops: OpsTransport } {
	if (c.lock === undefined || c.ops === undefined) fail(503, 'data operations unavailable')
	return { repositories: c.repositories, lock: c.lock, ops: c.ops }
}

/** The record as the operation left it: one the object left unanswered is still `running`, at its step. */
function dataOperationResult(outcome: DataOperationOutcome): DataOperationDto {
	if (outcome.kind === 'busy') fail(409, 'a deploy or another data operation holds this environment')
	if (outcome.kind === 'driven') return toDataOperationDto(outcome.operation)
	if (outcome.reason === 'operation_running') fail(409, 'an operation of this environment is still running: recover it first')
	if (outcome.reason === 'not_recoverable') fail(409, 'that operation is not one this environment can recover')
	if (outcome.reason === 'superseded') fail(409, 'a newer operation of this environment supersedes that one')
	failUnavailable(outcome.reason)
}

function failUnavailable(reason: OpsUnavailable): never {
	if (reason === 'no_channel') fail(409, 'the environment has no ops channel: it needs a domain and a deploy at a release that serves one')
	fail(502, reason === 'channel_refused' ? "the environment's ops channel refused Control" : "the environment's object gave no usable answer")
}

function toMailMessageDto(row: MailMessageRow): MailMessageDto {
	return {
		id: row.id,
		sender: row.sender,
		recipientDomain: row.recipient_domain,
		state: row.state,
		ruleId: row.rule_id,
		decidedBy: row.decided_by,
		attempts: row.attempts,
		nextAttemptAt: row.next_attempt_at,
		providerMessageId: row.provider_message_id,
		errorCode: row.error_code,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function toMailRuleDto(row: MailRuleRow): MailRuleDto {
	return { id: row.id, scope: row.scope, domain: row.domain, action: row.action, createdAt: row.created_at, updatedAt: row.updated_at }
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000)
}
