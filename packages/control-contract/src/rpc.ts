import type { RpcProcedureContract } from '@fabrika/app'
import type { ExportDescription, OpsContentView, OpsView } from '@fabrika/auth-core'
import { z } from 'zod'
import type { BuilderConnectionReceiptDto, CreateBuilderConnectionReceiptRequest, GetBuilderConnectionReceiptRequest } from './builder-connections.js'
import type {
	ApproveDeviceAuthorizationResult,
	BuilderPairingProofRequest,
	DenyDeviceAuthorizationResult,
	InspectDeviceAuthorizationResult,
	ListOwnBuilderPairingsRequest,
	ListOwnDeviceAuthorizationsResult,
	RevokeBuilderPairingRequest,
	RevokeKeyResult,
} from './builder-pairing.js'
import type {
	AdoptDeploymentNamespaceRequest,
	AppDto,
	AppEnvDto,
	ApprovalDto,
	AppSecretDto,
	AppVarDto,
	CompleteApprovalRequest,
	ConsoleAccessDto,
	CreateDeploymentNamespaceRequest,
	CursorList,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceListResponse,
	GitHubSourceConnectionListInput,
	GitHubSourceConnectionListResponse,
	GitHubSourceConnectionStatusDto,
	InstallationDto,
	ListResponse,
	PlanDeploymentNamespaceRequest,
	PlanDeploymentNamespaceResponse,
	PutAppEnvRequest,
	PutAppSecretRequest,
	PutAppVarRequest,
	RegisterAppRequest,
	RegisterAppResponse,
	ReleaseNamespaceClaimsResponse,
	RemoveDeploymentNamespaceResponse,
	RepublishAllNamespacesResponse,
	RunDto,
	RunLogResponse,
	RunStatus,
	RunTailResponse,
	SetEnvironmentProtectionRequest,
	StartGitHubSourceConnectionRequest,
	StartGitHubSourceConnectionResponse,
	TriggerDeployRequest,
	UpdateAppRequest,
	UpdateDeploymentNamespaceRequest,
} from './index.js'
import type {
	MailMessageDetailDto,
	MailMessageDto,
	MailMessageIdInput,
	MailMessageListInput,
	MailRuleDto,
	MailRuleIdInput,
	SetMailRuleInput,
} from './mail.js'

type RpcProcedure<TInput, TOutput> = RpcProcedureContract<TInput, TOutput>

export interface AppIdInput {
	readonly appId: string
}

/** Whether a rotation was recorded: `false` while the environment holds no token key. */
export interface RotateTokenKeyResponse {
	readonly requested: boolean
}

export interface AppEnvironmentInput extends AppIdInput {
	readonly env: string
}

export interface AppNamedValueInput extends AppIdInput {
	readonly name: string
	readonly env?: string | null
}

export interface CreateAppRequest extends UpdateAppRequest {
	readonly id: string
	readonly repoUrl: string
}

export interface PutAppEnvironmentInput extends AppEnvironmentInput {
	readonly environment: PutAppEnvRequest
}

export interface PutAppSecretInput extends AppIdInput {
	readonly secret: PutAppSecretRequest
}

export interface PutAppVarInput extends AppIdInput {
	readonly variable: PutAppVarRequest
}

export interface SecretValueInput extends AppNamedValueInput {
	readonly value: string
}

export interface SecretValueResponse {
	readonly ok: boolean
	readonly valueRef?: string
}

export interface OkResponse {
	readonly ok: boolean
}

export interface NamespaceIdInput {
	readonly namespaceId: string
}

export interface AdoptNamespaceInput extends NamespaceIdInput {
	readonly namespace: AdoptDeploymentNamespaceRequest
}

export interface UpdateNamespaceInput extends NamespaceIdInput {
	readonly namespace: UpdateDeploymentNamespaceRequest
}

/** The app environment whose claims in the namespace are released. */
export interface ReleaseNamespaceClaimsInput extends NamespaceIdInput {
	readonly appId: string
	readonly env: string
}

export interface RunListInput {
	readonly appId?: string
	readonly env?: string
	/** Filter before pagination, so an old queued or running deploy is not hidden by newer finished runs. */
	readonly statuses?: RunStatus[]
	readonly before?: string
	readonly limit?: number
}

export interface RunIdInput {
	readonly runId: string
}

export interface TailRunInput extends RunIdInput {
	readonly after?: number
}

export interface GitHubSourceConnectionInput {
	readonly connectionId: string
}

/** Provider-neutral admin seam. A statically composed provider implements these GitHub operations. */
export interface GitHubSourceConnectionRpcContract {
	list: RpcProcedure<GitHubSourceConnectionListInput, GitHubSourceConnectionListResponse>
	start: RpcProcedure<StartGitHubSourceConnectionRequest, StartGitHubSourceConnectionResponse>
	verifyInstallation: RpcProcedure<GitHubSourceConnectionInput, GitHubSourceConnectionStatusDto>
	repair: RpcProcedure<GitHubSourceConnectionInput, GitHubSourceConnectionStatusDto>
	reconcile: RpcProcedure<GitHubSourceConnectionInput, GitHubSourceConnectionStatusDto>
}

/** Portable Delivery control API shared by browser and machine callers. */
export interface ControlRpcContract {
	installation: RpcProcedure<void, InstallationDto>
	consoleAccess: RpcProcedure<void, ConsoleAccessDto>
	builderPairing: {
		inspect: RpcProcedure<BuilderPairingProofRequest, InspectDeviceAuthorizationResult>
		approve: RpcProcedure<BuilderPairingProofRequest, ApproveDeviceAuthorizationResult>
		deny: RpcProcedure<BuilderPairingProofRequest, DenyDeviceAuthorizationResult>
		listOwn: RpcProcedure<ListOwnBuilderPairingsRequest, ListOwnDeviceAuthorizationsResult>
		revoke: RpcProcedure<RevokeBuilderPairingRequest, RevokeKeyResult>
	}
	builderConnections: {
		createReceipt: RpcProcedure<CreateBuilderConnectionReceiptRequest, BuilderConnectionReceiptDto>
		getReceipt: RpcProcedure<GetBuilderConnectionReceiptRequest, BuilderConnectionReceiptDto>
	}
	sourceConnection: GitHubSourceConnectionRpcContract
	apps: {
		list: RpcProcedure<void, ListResponse<AppDto>>
		get: RpcProcedure<AppIdInput, AppDto>
		create: RpcProcedure<CreateAppRequest, AppDto>
		update: RpcProcedure<AppIdInput & { app: UpdateAppRequest }, AppDto>
		delete: RpcProcedure<AppIdInput, OkResponse>
		environments: {
			list: RpcProcedure<AppIdInput, ListResponse<AppEnvDto>>
			put: RpcProcedure<PutAppEnvironmentInput, AppEnvDto>
			delete: RpcProcedure<AppEnvironmentInput, OkResponse>
			/** Human user principals with `access.approve` only, from the console (ADR-0050 §4). */
			protect: RpcProcedure<SetEnvironmentProtectionRequest, AppEnvDto>
			/** The environment's next deploy retires the key its signed tokens are signed with and signs with a new one. */
			rotateTokenKey: RpcProcedure<AppEnvironmentInput, RotateTokenKeyResponse>
		}
		secrets: {
			list: RpcProcedure<AppIdInput, ListResponse<AppSecretDto>>
			put: RpcProcedure<PutAppSecretInput, AppSecretDto>
			/** Removes the value where it is stored (vault or provider), then the row; a failed value delete keeps the row. */
			delete: RpcProcedure<AppNamedValueInput, OkResponse>
		}
		variables: {
			list: RpcProcedure<AppIdInput, ListResponse<AppVarDto>>
			put: RpcProcedure<PutAppVarInput, AppVarDto>
			delete: RpcProcedure<AppNamedValueInput, OkResponse>
		}
	}
	vault: {
		set: RpcProcedure<SecretValueInput, SecretValueResponse>
		rotate: RpcProcedure<SecretValueInput, OkResponse>
		/** The same operation as `apps.secrets.delete`. */
		delete: RpcProcedure<AppNamedValueInput, OkResponse>
	}
	namespaces: {
		list: RpcProcedure<void, DeploymentNamespaceListResponse>
		get: RpcProcedure<NamespaceIdInput, DeploymentNamespaceDetailDto>
		plan: RpcProcedure<PlanDeploymentNamespaceRequest, PlanDeploymentNamespaceResponse>
		create: RpcProcedure<CreateDeploymentNamespaceRequest, DeploymentNamespaceDetailDto>
		adopt: RpcProcedure<AdoptNamespaceInput, DeploymentNamespaceDetailDto>
		reconcile: RpcProcedure<NamespaceIdInput, DeploymentNamespaceDetailDto>
		/** Change a ready namespace in place, synchronously (backlog 79); also the retry after an unconfirmed update. */
		update: RpcProcedure<UpdateNamespaceInput, DeploymentNamespaceDetailDto>
		/** Free a namespace id. Refused while any app environment is registered in it (backlog 73). */
		remove: RpcProcedure<NamespaceIdInput, RemoveDeploymentNamespaceResponse>
		/**
		 * Republish the proxy of every ready namespace, as after a change of the installation's client logo (ADR-0066).
		 * Returns once each rebuild is submitted; a failure is a 502 naming the namespaces to reconcile.
		 */
		republishAll: RpcProcedure<void, RepublishAllNamespacesResponse>
		/**
		 * Release one app environment's resource claims in the namespace, only when the provider confirms every claimed
		 * resource gone. The operator deletes the resources first; fabrika deletes none (ADR-0034).
		 */
		releaseClaims: RpcProcedure<ReleaseNamespaceClaimsInput, ReleaseNamespaceClaimsResponse>
	}
	runs: {
		list: RpcProcedure<RunListInput, CursorList<RunDto>>
		/** Per app environment, its newest finished run when that run failed: a later finished run supersedes a failure. */
		latestFailures: RpcProcedure<void, ListResponse<RunDto>>
		get: RpcProcedure<RunIdInput, RunDto>
		log: RpcProcedure<RunIdInput, RunLogResponse>
		tail: RpcProcedure<TailRunInput, RunTailResponse>
		cancel: RpcProcedure<RunIdInput, RunDto>
	}
	/** Runs whose access change waits for a human (ADR-0050 §5), behind `access.approve`. */
	approvals: {
		list: RpcProcedure<void, ListResponse<ApprovalDto>>
		get: RpcProcedure<RunIdInput, ApprovalDto>
		/** A human user principal, from the console's own origin; no key, service or OAuth token completes one. */
		complete: RpcProcedure<CompleteApprovalRequest, ApprovalDto>
	}
	deploy: RpcProcedure<TriggerDeployRequest, RunDto>
	register: RpcProcedure<RegisterAppRequest, RegisterAppResponse>
	/** What a consumer vendors (`fabrika connect add`): the export its owner's environment approved for it. */
	connectors: {
		describe: RpcProcedure<DescribeConnectorRequest, ExportDescription>
	}
	/** The mail relay: `mail.read`, `mail.content.read` and `mail.manage`. */
	mail: {
		messages: {
			list: RpcProcedure<MailMessageListInput, CursorList<MailMessageDto>>
			/** The content only with `mail.content.read`. */
			get: RpcProcedure<MailMessageIdInput, MailMessageDetailDto>
			/** A held message only. */
			release: RpcProcedure<MailMessageIdInput, MailMessageDto>
			/** A held message only. */
			drop: RpcProcedure<MailMessageIdInput, MailMessageDto>
			/** A `failed` message, or an `unknown` one over an idempotent transport, whose content is kept. */
			requeue: RpcProcedure<MailMessageIdInput, MailMessageDto>
		}
		rules: {
			list: RpcProcedure<void, ListResponse<MailRuleDto>>
			set: RpcProcedure<SetMailRuleInput, MailRuleDto>
			remove: RpcProcedure<MailRuleIdInput, OkResponse>
		}
	}
	/**
	 * An application environment's data (ADR-0069): `data.read` and `data.manage` at the coordinates,
	 * `data.content.read` as a global grant only; every denial is the 404 of an absent environment.
	 */
	data: {
		operations: {
			list: RpcProcedure<DataOperationListInput, CursorList<DataOperationDto>>
			get: RpcProcedure<{ operationId: string }, DataOperationDto>
		}
		/** The metadata view; never content. */
		view: RpcProcedure<AppEnvironmentInput, OpsView>
		content: RpcProcedure<AppEnvironmentInput, OpsContentView>
		start: RpcProcedure<StartDataOperationInput, DataOperationDto>
		recover: RpcProcedure<RecoverDataOperationInput, DataOperationDto>
		/** Consistent backups (ADR-0070): listed and their schedule read under `data.read`, the schedule set under `data.manage`. */
		backups: {
			list: RpcProcedure<DataOperationListInput, CursorList<DataBackupDto>>
			schedule: RpcProcedure<AppEnvironmentInput, DataBackupScheduleDto>
			setSchedule: RpcProcedure<SetDataBackupScheduleInput, DataBackupScheduleDto>
		}
	}
}

/**
 * One export version of `app` as the environment `env` approved it, read for its consumer `consumer`. Unknown, not
 * approved, or not exported to that consumer: 404 alike.
 */
export interface DescribeConnectorRequest {
	readonly consumer: string
	readonly env: string
	readonly app: string
	readonly export: string
	readonly version: number
}

// ── Data operations (ADR-0069) ───────────────────────────────────────────────

/** What an application environment's object admits (ADR-0069 §3). */
export type MaintenanceMode = 'open' | 'read-only' | 'closed' | 'inspect'

export type DataOperationKind = 'maintenance' | 'backup' | 'migrate' | 'recovery' | 'restore'

/**
 * Where an operation stands: `reconcile` reads the record and the object's published state (a recovery's first step),
 * `restrict` publishes a generation in a restricting mode, `backup` and `verify` take and check a consistent backup,
 * `deploy` runs the operation's own deploy, `migrate` runs the pending migrations, `resume` continues the interrupted
 * operation from its recorded step, and `open` publishes the generation that opens the object. A side restore (ADR-0070
 * §9) also `list`s its clone with a deploy, `import`s the backup into it, `promote`s it (the clone `open`, the original
 * `inspect`), `point`s ordinary traffic at it with a deploy, waits for it to `serve`, `rewind`s the original to the
 * target time and `check`s the original's schema; `revert` points traffic back at the original with a deploy.
 */
export type DataOperationStep =
	| 'reconcile'
	| 'restrict'
	| 'backup'
	| 'verify'
	| 'deploy'
	| 'migrate'
	| 'resume'
	| 'open'
	| 'list'
	| 'import'
	| 'promote'
	| 'point'
	| 'serve'
	| 'rewind'
	| 'check'
	| 'revert'

export type DataOperationState = 'running' | 'succeeded' | 'failed'

/** What a recovery does after its closed fence: resume the interrupted operation, or open the object. */
export type DataOperationResolution = 'resume' | 'open'

/**
 * One operation as `data.read` shows it: an allowlisted projection of Control's record, with identifiers, states,
 * codes and timestamps only. It carries no free text and no content.
 */
export interface DataOperationDto {
	readonly id: string
	readonly appId: string
	readonly env: string
	readonly kind: DataOperationKind
	readonly step: DataOperationStep
	/** The mode the operation requires of the object at its step; a successor publishes its fresh generation in it. */
	readonly targetMode: MaintenanceMode
	/** The latest generation the operation reserved. */
	readonly generation: number
	readonly state: DataOperationState
	/** A code once it failed, never an error message. */
	readonly errorCode: string | null
	/** An opaque principal id (as `runActor`), never an email or label. */
	readonly actor: string
	readonly createdAt: number
	readonly updatedAt: number
	readonly finishedAt: number | null
	/** A recovery's interrupted operation, of the same environment; `null` for every other kind. */
	readonly recoversOperationId: string | null
	/** A recovery's choice after its closed fence; `null` for every other kind. */
	readonly resolution: DataOperationResolution | null
	/** A `migrate` operation's deploy run; `null` for every other kind. */
	readonly runId: string | null
}

export const DATA_OPERATION_MAX_PAGE_SIZE = 100

const nonEmpty = z.string().min(1)
const maintenanceMode = z.enum(['open', 'read-only', 'closed', 'inspect'])

/** One environment's operations, newest first; `before` is the last id of the previous page. */
export const dataOperationListInputSchema = z.object({
	appId: nonEmpty,
	env: nonEmpty,
	before: nonEmpty.optional(),
	limit: z.number().int().min(1).max(DATA_OPERATION_MAX_PAGE_SIZE).optional(),
}).strict()

export type DataOperationListInput = z.infer<typeof dataOperationListInputSchema>

/**
 * An operation a person starts. A migration starts inside a deploy and a recovery has its own request, so neither is
 * started here. A restore names the time `at` (ISO 8601 with an offset) its environment's data is recovered as of.
 */
export const startDataOperationInputSchema = z.discriminatedUnion('kind', [
	z.object({ appId: nonEmpty, env: nonEmpty, kind: z.literal('maintenance'), mode: maintenanceMode }).strict(),
	z.object({ appId: nonEmpty, env: nonEmpty, kind: z.literal('backup') }).strict(),
	z.object({ appId: nonEmpty, env: nonEmpty, kind: z.literal('restore'), at: z.string().datetime({ offset: true }) }).strict(),
])

export type StartDataOperationInput = z.infer<typeof startDataOperationInputSchema>

/**
 * Recover an environment whose operation `operationId` is stuck: fence it with a fresh generation in `closed`, then
 * resume that operation from its recorded step, or open the object at a new generation.
 */
export const recoverDataOperationInputSchema = z.object({
	appId: nonEmpty,
	env: nonEmpty,
	operationId: nonEmpty,
	resolution: z.enum(['resume', 'open']),
}).strict()

export type RecoverDataOperationInput = z.infer<typeof recoverDataOperationInputSchema>

/** `succeeded` only once its rehearsal passed. */
export type DataBackupState = 'running' | 'succeeded' | 'failed'

export type DataRehearsalOutcome = 'pending' | 'passed' | 'failed'

/**
 * One consistent backup as `data.read` shows it: identifiers, states, codes, sizes and timestamps. It carries no free
 * text and no content; downloading a dump is `data.content.read`.
 */
export interface DataBackupDto {
	/** The backup's record. */
	readonly id: string
	readonly appId: string
	readonly env: string
	/** The `backup` operation that took it. */
	readonly operationId: string
	/** The object it was taken from. */
	readonly object: string
	/** The dump's key in the bucket; a resumed backup whose dump started again carries the new one. */
	readonly dumpId: string
	/** Taken by a deploy's migration phase, not by the daily schedule. */
	readonly preMigration: boolean
	readonly state: DataBackupState
	/** A code once it failed, never an error message. */
	readonly errorCode: string | null
	readonly createdAt: number
	readonly finishedAt: number | null
	/** The object's bookmark when the dump began. */
	readonly bookmark: string | null
	/** Set once the upload completed. */
	readonly sizeBytes: number | null
	readonly parts: number | null
	/** How many tables the manifest lists. */
	readonly tables: number | null
	readonly rehearsal: DataRehearsalOutcome
	/** The code the rehearsal failed with. */
	readonly rehearsalCode: string | null
	/** Past its 30-day retention: never offered for a restore. */
	readonly expired: boolean
}

/** Whether the environment takes daily backups: on unless it opted out. Opting out leaves the pre-migration backup. */
export interface DataBackupScheduleDto {
	readonly appId: string
	readonly env: string
	readonly daily: boolean
	/** When it was last set; `null` while it keeps the default. */
	readonly updatedAt: number | null
}

export interface SetDataBackupScheduleInput extends AppEnvironmentInput {
	readonly daily: boolean
}
