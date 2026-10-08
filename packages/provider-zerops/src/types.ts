import type { AppGates, ContractArtifact } from '@fabrika/auth-core'
import type { AppConfigBase } from '@fabrika/provider-contract'
import type { ContractProxyApp } from '@fabrika/proxy-core/manifest'
import type { ZeropsRuntimePackage } from './execution'
import type {
	ZeropsHealthCheck,
	ZeropsImportProject,
	ZeropsImportService,
	ZeropsReadinessCheck,
	ZeropsYamlDeploy,
	ZeropsYamlRun,
	ZeropsYamlSetup,
} from './schema.generated'
import type { ZeropsSourceRepository } from './source'
import type { ZeropsSourcePrivateBinding } from './source/port'

export interface ZeropsResourceContext {
	env: string
	domain?: string
}

/**
 * A probe interval or timeout, as the PLATFORM takes it — a Go duration with a unit, e.g. `30s`.
 *
 * The published JSON schema types all six of these as `integer`, and the platform refuses an integer:
 * `POST /service-stack/zerops-yaml-validation` answers `yamlValidationInvalidYaml` with
 * `cannot unmarshal !!int into time.Duration`. The account wins, so this type does. Every value is also
 * bounded to **[10s, 1h]** — `5s` is refused with `invalid execPeriod <10s, 1h0m0s>` — which no
 * published document states; see `docs/reference/zerops-platform.md`.
 */
export type ZeropsDuration = `${number}${'s' | 'm' | 'h'}`

/** `run.healthCheck`, with the four duration fields corrected to what the platform accepts. */
export interface ZeropsHealthCheckSpec extends Omit<ZeropsHealthCheck, ZeropsHealthCheckDurationField> {
	failureTimeout?: ZeropsDuration
	disconnectTimeout?: ZeropsDuration
	recoveryTimeout?: ZeropsDuration
	execPeriod?: ZeropsDuration
}

type ZeropsHealthCheckDurationField = 'failureTimeout' | 'disconnectTimeout' | 'recoveryTimeout' | 'execPeriod'

/** `deploy.readinessCheck`, with its two duration fields corrected. */
export interface ZeropsReadinessCheckSpec extends Omit<ZeropsReadinessCheck, 'failureTimeout' | 'retryPeriod'> {
	failureTimeout?: ZeropsDuration
	retryPeriod?: ZeropsDuration
}

export interface ZeropsYamlRunSpec extends Omit<ZeropsYamlRun, 'healthCheck'> {
	healthCheck?: ZeropsHealthCheckSpec
}

export interface ZeropsYamlDeploySpec extends Omit<ZeropsYamlDeploy, 'readinessCheck'> {
	readinessCheck?: ZeropsReadinessCheckSpec
}

export interface ZeropsYamlSetupSpec extends Omit<ZeropsYamlSetup, 'run' | 'deploy'> {
	run?: ZeropsYamlRunSpec
	deploy?: ZeropsYamlDeploySpec
}

/**
 * A `zerops.yaml` as fabrika AUTHORS it.
 *
 * Same relationship to `ZeropsYaml` that `ZeropsServiceSpec` has to `ZeropsImportService`: the generated
 * transcription is the platform's published contract, and this is the authoring surface, which diverges
 * from it only where a live account has proved the publication wrong.
 */
export interface ZeropsYamlSpec {
	zerops: ZeropsYamlSetupSpec[]
}

export type ZeropsCompilerOwnedServiceField =
	| 'envIsolation'
	| 'override'
	| 'envSecrets'
	| 'dotEnvSecrets'
	| 'mode'
	| 'os'

export type ZeropsCompilerOwnedProjectField = 'envVariables' | 'envIsolation'

export type ZeropsServiceSpec = Omit<ZeropsImportService, ZeropsCompilerOwnedServiceField>

export type ZeropsProjectSpec = Omit<ZeropsImportProject, ZeropsCompilerOwnedProjectField>

/** What the namespace proxy applies to the app: ordered gates, or a contract application's endpoint table. */
export type ZeropsProxySpec = ZeropsGateProxySpec | ZeropsContractProxySpec

export interface ZeropsGateProxySpec {
	upstream: string
	gates: AppGates
}

/** A contract application: the manifest form of its compiled contract, from `contractProxyTable`. */
export interface ZeropsContractProxySpec extends Pick<ContractProxyApp, 'endpoints' | 'reservedPrefixes' | 'snapshot'> {
	upstream: string
}

/**
 * A typed reference to the namespace-owned PostgreSQL service; it never contains its credential.
 *
 * The reference names its DATABASE and its TLS MODE rather than inheriting either from the driver — see
 * `ZEROPS_SHARED_POSTGRES_CONNECTION_STRING` in `./namespace.ts` for what the account proved about both.
 */
export interface ZeropsSharedPostgresBinding {
	readonly resourceKey: 'service:postgres'
	readonly hostname: 'postgres'
	readonly connectionString: '${postgres_connectionTlsString}/${postgres_dbName}?sslmode=require'
}

export type ZeropsNamespaceResourceRequirement = ZeropsSharedPostgresBinding

export interface ZeropsSourceTarget {
	platform: 'zerops'
	deployService?: string
	zeropsSetup?: string
	proxy?: ZeropsProxySpec
	namespaceResources?: ZeropsNamespaceResourceRequirement[]
	/**
	 * The compiled contract of a contract application. Its presence locks the setup down (ADR-0043): the platform
	 * generates the run section and the server build, and the authored `zerops.yaml` keeps only the SPA build.
	 */
	contract?: ContractArtifact
	/** System packages for the runtime image of a contract application, from a closed list. */
	runtimePackages?: ZeropsRuntimePackage[]
	services: (ctx: ZeropsResourceContext) => ZeropsServiceSpec[]
	project?: ZeropsProjectSpec
}

export interface ZeropsAppConfig extends AppConfigBase {
	target: ZeropsSourceTarget
}

/** Exact, credential-free source coordinates composed for one non-dry runtime invocation. */
export interface ZeropsRuntimeSource {
	runId: string
	repository: ZeropsSourceRepository
	commitSha: string
	/** Absent for a public repository. */
	privateBinding?: ZeropsSourcePrivateBinding
}

/** The run checkpoint (ADR-0044): the reserved version, and whether its build request may have been sent. */
export interface ZeropsRunState {
	appVersionId: string
	triggered: boolean
}

/** Ephemeral runtime coordinates. This value is encoded only after credentials are composed. */
export interface ZeropsRuntimeTarget {
	projectId: string
	serviceId: string
	accessToken: string
	/** Absent only for dry runs, which perform no source or Zerops mutation. */
	source?: ZeropsRuntimeSource
	apiBaseUrl?: string
	propustkaUrl?: string
	adminKey?: string
}
