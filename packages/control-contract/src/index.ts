import type { JsonValue, ProviderEnvelope } from '@fabrika/provider-contract'

export type { JsonValue }

/** A plain list response. */
export interface ListResponse<T> {
	items: T[]
}

/** A keyset-paginated list. */
export interface CursorList<T> {
	items: T[]
	nextCursor: string | null
}

export type ProviderEnvelopeDto = ProviderEnvelope

export interface GitHubSourceRepositoryDto {
	readonly owner: string
	readonly name: string
}

export interface GitHubSourceConnectionAppDto {
	readonly id: number
	readonly slug: string
	readonly htmlUrl: string
	readonly public: boolean
	readonly owner: {
		readonly login: string
		readonly type: 'Organization'
	}
	readonly permissions: {
		readonly contents: 'read'
	}
	readonly events: readonly ['push']
}

export interface GitHubSourceConnectionInstallationDto {
	readonly id: number
	readonly accountLogin: string
	readonly repositorySelection: 'all' | 'selected'
	readonly verifiedRepositories: readonly GitHubSourceRepositoryDto[]
}

interface GitHubSourceConnectionBaseDto {
	readonly provider: string
	readonly kind: 'github-app'
}

export interface GitHubSourceConnectionAnonymousDto extends GitHubSourceConnectionBaseDto {
	readonly state: 'anonymous'
}

export interface GitHubSourceConnectionUnavailableDto extends GitHubSourceConnectionBaseDto {
	readonly state: 'unavailable'
}

export interface GitHubSourceConnectionAdoptionRequiredDto extends GitHubSourceConnectionBaseDto {
	readonly state: 'adoption-required'
}

export interface GitHubSourceConnectionSetupPendingDto extends GitHubSourceConnectionBaseDto {
	readonly state: 'setup-pending'
	readonly connectionId: string
	readonly phase: 'starting' | 'awaiting-manifest-callback' | 'persisting' | 'activating'
	/** Present only while the same-origin manifest handoff can be resumed. */
	readonly continuePath?: string
}

export interface GitHubSourceConnectionInstallationRequiredDto extends GitHubSourceConnectionBaseDto {
	readonly state: 'installation-required'
	readonly connectionId: string
	readonly app: GitHubSourceConnectionAppDto
	readonly installationUrl: string
}

export interface GitHubSourceConnectionConnectedDto extends GitHubSourceConnectionBaseDto {
	readonly state: 'connected'
	readonly connectionId: string
	readonly app: GitHubSourceConnectionAppDto
	readonly installation: GitHubSourceConnectionInstallationDto
}

export interface GitHubSourceConnectionRepairRequiredDto extends GitHubSourceConnectionBaseDto {
	readonly state: 'repair-required'
	readonly connectionId: string
	readonly reason: 'interrupted-setup' | 'credential-activation' | 'installation-verification'
	readonly app?: GitHubSourceConnectionAppDto
}

/** Browser-safe setup state. It never carries a private key, webhook secret, token, or source RPC key. */
export type GitHubSourceConnectionStatusDto =
	| GitHubSourceConnectionAnonymousDto
	| GitHubSourceConnectionUnavailableDto
	| GitHubSourceConnectionAdoptionRequiredDto
	| GitHubSourceConnectionSetupPendingDto
	| GitHubSourceConnectionInstallationRequiredDto
	| GitHubSourceConnectionConnectedDto
	| GitHubSourceConnectionRepairRequiredDto

export interface StartGitHubSourceConnectionRequest {
	readonly organization: string
	readonly appName: string
	readonly visibility: 'private' | 'public'
	readonly repositories: readonly GitHubSourceRepositoryDto[]
}

export interface StartGitHubSourceConnectionResponse {
	readonly connectionId: string
	/** Same-origin path that starts the GitHub manifest handoff. */
	readonly continuePath: string
}

/** One redacted line of deploy output exposed by the control API. */
export interface RunLogLine {
	readonly ts: number
	readonly stream: 'stdout' | 'stderr' | 'meta'
	readonly text: string
}

/** Backward-compatible short name for browser consumers. */
export type LogLine = RunLogLine

export interface SetSecretValueRequest {
	value: string
	env?: string | null
}

export interface AppDto {
	id: string
	repoUrl: string
	defaultBranch: string
	workerDir: string | null
	buildCmd: string | null
	configPath: string | null
	githubInstallationId: number | null
	createdAt: number
}

export interface AppOptionalFields {
	defaultBranch?: string
	workerDir?: string | null
	buildCmd?: string | null
	configPath?: string | null
	githubInstallationId?: number | null
	resolveInstallationId?: boolean
}

export interface UpdateAppRequest extends AppOptionalFields {
	repoUrl?: string
}

export interface AppEnvDto {
	appId: string
	env: string
	domain: string | null
	publicOrigin: string | null
	triggerRef: string | null
	namespaceId: string | null
	provider: string
	target: ProviderEnvelopeDto
	artifact: ProviderEnvelopeDto
	createdAt: number
}

export interface PutAppEnvRequest {
	domain?: string | null
	publicOrigin?: string | null
	triggerRef?: string | null
	namespaceId?: string | null
	target: ProviderEnvelopeDto
	artifact: ProviderEnvelopeDto
}

export interface CloudflareTargetEnvelope extends ProviderEnvelopeDto {
	provider: 'cloudflare'
	version: 1
	payload: {
		stateNamespace?: string
	}
}

export interface CloudflareArtifactEnvelope extends ProviderEnvelopeDto {
	provider: 'cloudflare'
	version: 1
	payload: {
		configPath: string
	}
}

export type DeploymentNamespaceState = 'pending' | 'provisioning' | 'ready' | 'failed'

export interface DeploymentNamespaceDto {
	id: string
	env: string
	provider: string
	exclusiveAppId: string | null
	target: ProviderEnvelopeDto
	state: DeploymentNamespaceState
	lastError: string | null
	createdAt: number
}

export interface DeploymentNamespaceDetailDto extends DeploymentNamespaceDto {
	presentation: DeploymentNamespacePresentationDto | null
}

export interface CreateDeploymentNamespaceRequest {
	id: string
	env: string
	exclusiveAppId?: string | null
	target: ProviderEnvelopeDto
}

export interface AdoptDeploymentNamespaceRequest {
	env: string
	exclusiveAppId?: string | null
	target: ProviderEnvelopeDto
}

export interface DeploymentNamespaceFactDto {
	readonly label: string
	readonly value: string
}

export interface DeploymentNamespacePresentationDto {
	readonly preset: string
	readonly title: string
	readonly facts: readonly DeploymentNamespaceFactDto[]
	readonly instructions: readonly string[]
}

export interface DeploymentNamespacePresetDto {
	readonly id: string
	readonly label: string
	readonly description: string
	readonly requiresExclusiveApp: boolean
}

export interface DeploymentNamespaceOperatorDto {
	readonly presets: readonly DeploymentNamespacePresetDto[]
}

export interface DeploymentNamespaceListResponse {
	items: DeploymentNamespaceDto[]
	operator: DeploymentNamespaceOperatorDto | null
}

export interface PlanDeploymentNamespaceRequest {
	id: string
	env: string
	preset: string
	exclusiveAppId?: string
	options?: JsonValue
}

export interface PlannedDeploymentNamespaceDto {
	readonly id: string
	readonly env: string
	readonly exclusiveAppId?: string
	readonly target: ProviderEnvelopeDto
}

export interface PlanDeploymentNamespaceResponse {
	readonly namespace: PlannedDeploymentNamespaceDto
	readonly presentation: DeploymentNamespacePresentationDto
}

export interface AppSecretDto {
	appId: string
	env: string | null
	name: string
	valueRef: string
	createdAt: number
}

export interface PutAppSecretRequest {
	name: string
	valueRef: string
	env?: string | null
}

export interface AppVarDto {
	appId: string
	env: string | null
	name: string
	value: string
	createdAt: number
}

export interface PutAppVarRequest {
	name: string
	value: string
	env?: string | null
}

export interface RegisterAppRequest extends AppOptionalFields {
	id: string
	repoUrl: string
	env: string
	domain?: string | null
	publicOrigin?: string | null
	triggerRef?: string | null
	namespaceId?: string | null
	target: ProviderEnvelopeDto
	artifact: ProviderEnvelopeDto
}

export interface RegisterAppResponse {
	app: AppDto
	env: AppEnvDto
}

export type RunTrigger = 'webhook' | 'manual' | 'poll'
export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface RunDto {
	id: string
	appId: string
	env: string
	ref: string
	commitSha: string | null
	trigger: RunTrigger
	status: RunStatus
	exitCode: number | null
	externalRunId: string | null
	logKey: string | null
	createdAt: number
	startedAt: number | null
	finishedAt: number | null
}

export interface TriggerDeployRequest {
	appId: string
	env: string
	ref?: string
}

export interface RunTailResponse {
	lines: RunLogLine[]
	cursor: number
	done: boolean
	status: RunStatus
}

export interface RunLogResponse {
	lines: RunLogLine[]
	status?: RunStatus
}

export type {
	AdoptNamespaceInput,
	AppEnvironmentInput,
	AppIdInput,
	AppNamedValueInput,
	ControlRpcContract,
	CreateAppRequest,
	GitHubSourceConnectionInput,
	GitHubSourceConnectionRpcContract,
	NamespaceIdInput,
	OkResponse,
	PutAppEnvironmentInput,
	PutAppSecretInput,
	PutAppVarInput,
	RunIdInput,
	RunListInput,
	SecretValueInput,
	SecretValueResponse,
	TailRunInput,
} from './rpc.js'
