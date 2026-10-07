import type { LocalSourceUploadGrant } from '../local-source-contract'

export interface ProjectRecord {
	id: string
	clientId: string
	name: string
	status: 'ACTIVE'
	mode: 'LIGHT' | 'SERIOUS'
	description?: string
	tagList?: string[]
}

export interface ServiceRecord {
	id: string
	projectId: string
	name: string
	status: 'ACTIVE'
	base?: string
	activeAppVersionId?: string
	subdomainAccess?: boolean
	autoscalingProfileId?: string
}

export interface ServiceEnvRecord {
	id: string
	serviceStackId: string
	key: string
	content: string
	/** `ENV` records come from the active version's `run.envVariables`; `/env` omits them. */
	type: 'SECRET' | 'USER' | 'ENV'
	sensitive?: boolean
}

export interface AppVersionRecord {
	id: string
	serviceStackId: string
	projectId: string
	status: 'UPLOADING' | 'BUILDING' | 'ACTIVE' | 'BACKUP' | 'BUILD_FAILED' | 'CANCELLED'
	/** The reservation's `name`; Fabrika passes the run id. */
	name?: string
	hasHttpPorts?: boolean
	/** The sha256 of the root `zerops.yaml` in this version's uploaded tarball, when it was one. */
	uploadedDescriptorSha256?: string
	/** The `zeropsYamlSetup` its build request selected. */
	buildSetup?: string
	/** The selected setup's literal `run.envVariables`, applied as `ENV` records when the version activates. */
	runEnvVariables?: Record<string, string>
	syntheticFailure?: 'LOCAL_MISSING_UPLOAD'
	sequence: number
	activateAt?: number
}

/**
 * One asynchronous platform operation.
 *
 * `pendingReads` is how many more `GET /process/{id}` calls answer `PENDING` before the process reports
 * `FINISHED`; it starts at 1. Handing back `FINISHED` on the first read would be simpler, but then a
 * caller that never polls passes here and hangs on the platform — proving the wait runs is the only
 * reason to double a process at all. One PENDING read is enough to make the loop turn without making the
 * local stack sleep through every bring-up.
 */
export interface ProcessRecord {
	id: string
	actionName: string
	serviceStackId?: string
	/** Only a `stack.delete` process carries one live; nothing else here sets it. */
	projectId?: string
	appVersionId?: string
	pendingReads: number
}

/** The tiered access role shared by an integration token's request and its response. */
export type RoleCode = 'OWNER' | 'ADMIN' | 'BASIC_USER' | 'READ_ONLY' | 'NO_ACCESS'

/** One project grant carried by an integration token. `roleCode` is echoed, never defaulted — see `readGrant`. */
export interface TokenGrantRecord {
	projectId: string
	roleCode?: RoleCode
}

/**
 * One minted integration token, MINUS its value: the double derives that from the id
 * (`fakeIntegrationTokenValue`) so nothing credential-shaped is ever written to the state file or served
 * by `/__local/state`.
 */
export interface IntegrationTokenRecord {
	id: string
	clientId: string
	name: string
	created: string
	lastUpdate: string
	projects: TokenGrantRecord[]
	roleCode?: RoleCode
}

export interface EmulatorSnapshot {
	nextProject: number
	nextService: number
	nextEnv: number
	nextVersion: number
	nextProcess: number
	nextIntegrationToken: number
	projects: ProjectRecord[]
	services: ServiceRecord[]
	serviceEnv: ServiceEnvRecord[]
	appVersions: AppVersionRecord[]
	processes: ProcessRecord[]
	integrationTokens: IntegrationTokenRecord[]
	uploadGrants: LocalSourceUploadGrant[]
}

/**
 * `enableSubdomainAccess` is deliberately ABSENT. The real platform accepts the field in an import and
 * silently drops it — on a service the document creates as much as on one it overrides — so a double that
 * honoured it would let a broken provisioning path pass here and fail on an account
 * (`docs/reference/zerops-platform.md`). The subdomain is established by `enable-subdomain-access` only.
 */
export interface ImportService {
	hostname: string
	type?: string
	profile?: string
	/** Without it the platform refuses a name that already exists — the WHOLE document, not just the entry. */
	override?: boolean
	/** It asks for an EMPTY deploy, which is why a document carrying it is never a no-op on re-apply. */
	startWithoutCode?: boolean
	zeropsSetup?: string
	buildFromGit?: string
}

/** What one entry of an import document did. `process` is absent when the service was already there. */
export interface ImportOutcome {
	service: ServiceRecord
	process?: ProcessRecord
	deployment?: ProcessRecord
}

export interface ImportDocument {
	project?: {
		name: string
		corePackage?: string
		description?: string
		tags?: string[]
	}
	services: ImportService[]
}

export const emptySnapshot = (): EmulatorSnapshot => ({
	nextProject: 1,
	nextService: 1,
	nextEnv: 1,
	nextVersion: 1,
	nextProcess: 1,
	nextIntegrationToken: 1,
	projects: [],
	services: [],
	serviceEnv: [],
	appVersions: [],
	processes: [],
	integrationTokens: [],
	uploadGrants: [],
})
