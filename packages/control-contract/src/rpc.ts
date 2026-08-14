import type { RpcProcedureContract } from '@fabrika/app'
import type {
	AdoptDeploymentNamespaceRequest,
	AppDto,
	AppEnvDto,
	AppSecretDto,
	AppVarDto,
	CreateDeploymentNamespaceRequest,
	CursorList,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceListResponse,
	GitHubSourceConnectionListInput,
	GitHubSourceConnectionListResponse,
	GitHubSourceConnectionStatusDto,
	ListResponse,
	PlanDeploymentNamespaceRequest,
	PlanDeploymentNamespaceResponse,
	PutAppEnvRequest,
	PutAppSecretRequest,
	PutAppVarRequest,
	RegisterAppRequest,
	RegisterAppResponse,
	RunDto,
	RunLogResponse,
	RunTailResponse,
	SetSecretValueRequest,
	StartGitHubSourceConnectionRequest,
	StartGitHubSourceConnectionResponse,
	TriggerDeployRequest,
	UpdateAppRequest,
} from './index.js'

type RpcProcedure<TInput, TOutput> = RpcProcedureContract<TInput, TOutput>

export interface AppIdInput {
	readonly appId: string
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

export interface RunListInput {
	readonly appId?: string
	readonly env?: string
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
	status: RpcProcedure<void, GitHubSourceConnectionStatusDto>
	list: RpcProcedure<GitHubSourceConnectionListInput, GitHubSourceConnectionListResponse>
	start: RpcProcedure<StartGitHubSourceConnectionRequest, StartGitHubSourceConnectionResponse>
	adoptExisting: RpcProcedure<void, GitHubSourceConnectionStatusDto>
	verifyInstallation: RpcProcedure<GitHubSourceConnectionInput, GitHubSourceConnectionStatusDto>
	repair: RpcProcedure<GitHubSourceConnectionInput, GitHubSourceConnectionStatusDto>
}

/** Portable Delivery control API, implemented alongside the backward-compatible REST transport. */
export interface ControlRpcContract {
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
		}
		secrets: {
			list: RpcProcedure<AppIdInput, ListResponse<AppSecretDto>>
			put: RpcProcedure<PutAppSecretInput, AppSecretDto>
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
		delete: RpcProcedure<AppNamedValueInput, OkResponse>
	}
	namespaces: {
		list: RpcProcedure<void, DeploymentNamespaceListResponse>
		get: RpcProcedure<NamespaceIdInput, DeploymentNamespaceDetailDto>
		plan: RpcProcedure<PlanDeploymentNamespaceRequest, PlanDeploymentNamespaceResponse>
		create: RpcProcedure<CreateDeploymentNamespaceRequest, DeploymentNamespaceDetailDto>
		adopt: RpcProcedure<AdoptNamespaceInput, DeploymentNamespaceDetailDto>
		reconcile: RpcProcedure<NamespaceIdInput, DeploymentNamespaceDetailDto>
	}
	runs: {
		list: RpcProcedure<RunListInput, CursorList<RunDto>>
		get: RpcProcedure<RunIdInput, RunDto>
		log: RpcProcedure<RunIdInput, RunLogResponse>
		tail: RpcProcedure<TailRunInput, RunTailResponse>
		cancel: RpcProcedure<RunIdInput, RunDto>
	}
	deploy: RpcProcedure<TriggerDeployRequest, RunDto>
	register: RpcProcedure<RegisterAppRequest, RegisterAppResponse>
}
