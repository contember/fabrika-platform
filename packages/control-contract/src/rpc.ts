import type { RpcProcedureContract } from '@fabrika/app'
import type { ExportDescription } from '@fabrika/auth-core'
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
