import type { JsonValue, ProviderEnvelope } from '@fabrika/provider-contract'
import { z } from 'zod'

export * from './builder-bootstrap.js'
export * from './builder-connections.js'
export * from './builder-pairing.js'

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

/** What the console needs to know about the installation it runs in. */
export interface InstallationDto {
	/** The id of the one provider bundle this installation composes (ADR-0011). */
	readonly provider: string
}

/**
 * The console actions the caller's verified token holds, in the shape of an application's caller document. The
 * console shows and hides by it; it decides nothing, because every procedure checks its own action.
 */
export interface ConsoleAccessDto {
	/** Null for a credential bound to no principal. */
	readonly principal: { readonly id: string; readonly label: string } | null
	/** The actions held as a global grant, so in every scope value. */
	readonly global: readonly string[]
	/** Each scope value the caller holds an action in, with those actions; sorted by dimension, then value. */
	readonly scopes: readonly ConsoleScopedActionsDto[]
}

export interface ConsoleScopedActionsDto {
	readonly type: string
	readonly value: string
	readonly actions: readonly string[]
}

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

/**
 * The query parameter Control's GitHub setup URL adds when it sends the browser to the console's source page. It reports
 * what that one return from GitHub found; the page still reads the connection state from the API.
 */
export const GITHUB_SETUP_OUTCOME_PARAM = 'github-setup'

export type GitHubSetupOutcome = 'connected' | 'approval-requested' | 'unverified'

export interface GitHubSourceConnectionConnectedDto extends GitHubSourceConnectionBaseDto {
	readonly state: 'connected'
	readonly connectionId: string
	readonly app: GitHubSourceConnectionAppDto
	readonly installation: GitHubSourceConnectionInstallationDto
}

export type GitHubSourceConnectionWorkflowDto = Exclude<GitHubSourceConnectionStatusDto, GitHubSourceConnectionConnectedDto>

export * from './source-connection-list.js'

export interface GitHubSourceConnectionListInput {
	readonly cursor?: string
	readonly limit?: number
}

export interface GitHubSourceConnectionListResponse {
	readonly items: readonly GitHubSourceConnectionConnectedDto[]
	readonly nextCursor: string | null
	/** The one global non-connected workflow state, when present. */
	readonly workflow: GitHubSourceConnectionWorkflowDto | null
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

/** One redacted line of deploy output: the runner's NDJSON log line and the control API's view of it. */
export const runLogLineSchema = z.object({
	ts: z.number().finite(),
	stream: z.enum(['stdout', 'stderr', 'meta']),
	text: z.string(),
})

export type RunLogLine = z.infer<typeof runLogLineSchema>

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
	githubConnectionId?: string | null
	githubInstallationId: number | null
	createdAt: number
}

export interface AppOptionalFields {
	defaultBranch?: string
	workerDir?: string | null
	buildCmd?: string | null
	configPath?: string | null
	/** Must equal the installation of the repository owner's GitHub connection. */
	githubInstallationId?: number | null
	/** Bind the app to the repository owner's GitHub connection (one per owner). */
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
	/** An MCP authoring target (ADR-0049): users with `source.workspace.*` grants may edit and deploy it. */
	authoring: boolean
	/** A widening of access waits for a human's approval here (ADR-0050); `prod` is protected by default. */
	protected: boolean
	/** The run whose snapshot is this environment's active access; null until a run publishes one. */
	publishedRunId: string | null
	/**
	 * The published snapshot's steps off the paved road, one line each: the reach its sites declare and the database code
	 * its migrations declare. Each needs closer review; listed whether or not the environment is protected.
	 */
	deviations: string[]
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
	/** Omitted keeps the stored value. Only a Zerops environment of an app with a GitHub connection qualifies. */
	authoring?: boolean
	namespaceId?: string | null
	target: ProviderEnvelopeDto
	artifact: ProviderEnvelopeDto
}

export type DeploymentNamespaceState = 'pending' | 'provisioning' | 'ready' | 'failed'

export interface DeploymentNamespaceDto {
	id: string
	env: string
	provider: string
	exclusiveAppId: string | null
	target: ProviderEnvelopeDto
	state: DeploymentNamespaceState
	/**
	 * The last lifecycle failure, redacted and bounded, with its class in `lastErrorCode`: a stable
	 * identifier — a provider error code such as `insufficientPermissions`, or `internal` when the cause
	 * was not a typed provider failure — so a console can tell two failures apart without matching prose.
	 * A row written before the codes existed carries a message and no code.
	 */
	lastError: string | null
	lastErrorCode: string | null
	/**
	 * Present only while a `namespaces.update` is unconfirmed (`lastErrorCode` `namespaceUpdateUnconfirmed`):
	 * the target that update was moving to. Retrying `namespaces.update` with it finishes the update.
	 */
	unconfirmedTarget?: ProviderEnvelopeDto
	createdAt: number
}

export interface DeploymentNamespaceDetailDto extends DeploymentNamespaceDto {
	presentation: DeploymentNamespacePresentationDto | null
	/**
	 * The public hosts this namespace serves, with the environment that already claimed each one. Absent
	 * where the provider names none — a placement whose domains are bound out of band, or one whose entry
	 * point is not published yet.
	 */
	readonly hosts?: readonly DeploymentNamespaceHostDto[]
}

/** One host a namespace serves, and the application environment whose domain already takes it. */
export interface DeploymentNamespaceHostDto {
	readonly host: string
	readonly port: number
	readonly takenBy?: {
		readonly appId: string
		readonly environment: string
	}
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

/**
 * A namespace's new provider target. Its payload may name only what changes; the provider merges it over
 * the stored one. Only what the provider can change in place is accepted — on Zerops the PostgreSQL
 * profile. A field the target does not have is a 400; any other change is a 409 that names the supported
 * path, a new namespace under a new id.
 */
export interface UpdateDeploymentNamespaceRequest {
	target: ProviderEnvelopeDto
}

export interface DeploymentNamespaceFactDto {
	readonly label: string
	readonly value: string
	/** Set when the value names a LIVE provider resource that outlives the namespace row (see removal). */
	readonly resource?: boolean
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

/**
 * What removal leaves behind. Fabrika deletes no provider resource: it holds OWNER on the projects it
 * creates ([ADR-0034](../../../docs/decisions/0034-the-control-plane-creates-the-projects-it-owns.md)),
 * so deleting one is a destructive act on live state that stays with the operator. The removed row is
 * returned whole — its provider target and presentation name what is now unowned.
 */
export interface RemoveDeploymentNamespaceResponse {
	readonly removed: DeploymentNamespaceDetailDto
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

/**
 * Where an app secret's value is kept: `vault` (control's vault), `provider` (the provider's own storage),
 * or `legacy` — a row from before secrets were vault-only, which no deploy resolves until it is set again.
 */
export type AppSecretStorage = 'vault' | 'provider' | 'legacy'

export interface AppSecretDto {
	appId: string
	env: string | null
	name: string
	storage: AppSecretStorage
	/** The `vault:` ref; null for any other storage, whose stored ref control cannot vouch for. */
	valueRef: string | null
	createdAt: number
}

/** The plaintext is write-only: control seals it and stores only the resulting ref. */
export interface PutAppSecretRequest {
	name: string
	value: string
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
/** `awaiting_approval`: the run widens access on a protected environment and waits for a human (ADR-0050). */
export type RunStatus = 'pending' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed'

export interface RunDto {
	id: string
	appId: string
	env: string
	ref: string
	commitSha: string | null
	trigger: RunTrigger
	/** Who created the run: `user:<id>`, `service:<id>`, `oauth:<id>` (an MCP client acting for a user), `webhook:<connection>` or `poll`. */
	actor: string | null
	status: RunStatus
	exitCode: number | null
	externalRunId: string | null
	logKey: string | null
	createdAt: number
	startedAt: number | null
	finishedAt: number | null
}

/**
 * One plain-language line of an access change; `widens` when it can grant access the baseline did not. `review: 'closer'`
 * marks a step off the paved road (declared reach, database code) or a change the diff cannot classify.
 */
export interface AccessChangeDto {
	widens: boolean
	line: string
	review?: 'closer'
}

/** A run's access change against its environment's active snapshot (ADR-0050 §3). */
export interface ApprovalDto {
	run: RunDto
	outcome: 'unchanged' | 'removal' | 'widening'
	changes: AccessChangeDto[]
	/** The digest of the run's snapshot and of the active one it was compared with: an approval is bound to both. */
	candidateDigest: string
	baselineDigest: string
	/** The published run the change was compared with; null when nothing was published. */
	baselineRunId: string | null
	protected: boolean
	/** The human who approved it, once one did. */
	approval: { principalId: string; label: string; approvedAt: number } | null
}

/** Approve or refuse one parked run. The digests are the ones the approver read; a reclassified run refuses them. */
export interface CompleteApprovalRequest {
	runId: string
	decision: 'approve' | 'reject'
	candidateDigest: string
	baselineDigest: string
}

/** Change whether a widening waits for approval on one environment (ADR-0050 §4). */
export interface SetEnvironmentProtectionRequest {
	appId: string
	env: string
	protected: boolean
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
	DescribeConnectorRequest,
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
	UpdateNamespaceInput,
} from './rpc.js'
