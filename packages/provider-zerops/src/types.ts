import type { AppGates } from '@fabrika/auth-core'
import type { AppConfigBase } from '@fabrika/provider-contract'
import type {
	ZeropsHealthCheck,
	ZeropsImportProject,
	ZeropsImportService,
	ZeropsReadinessCheck,
	ZeropsYamlDeploy,
	ZeropsYamlRun,
	ZeropsYamlSetup,
} from './schema.generated'

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

export interface ZeropsProxySpec {
	upstream: string
	gates: AppGates
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
	readonly connectionString: '${postgres_connectionString}/${postgres_dbName}?sslmode=require'
}

export type ZeropsNamespaceResourceRequirement = ZeropsSharedPostgresBinding

export interface ZeropsSourceTarget {
	platform: 'zerops'
	deployService?: string
	zeropsSetup?: string
	proxy?: ZeropsProxySpec
	namespaceResources?: ZeropsNamespaceResourceRequirement[]
	services: (ctx: ZeropsResourceContext) => ZeropsServiceSpec[]
	project?: ZeropsProjectSpec
}

export interface ZeropsAppConfig extends AppConfigBase {
	target: ZeropsSourceTarget
}

/** Ephemeral runtime coordinates. This value is encoded only after credentials are composed. */
export interface ZeropsRuntimeTarget {
	projectId: string
	serviceId: string
	accessToken: string
	buildFromGit?: string
	apiBaseUrl?: string
	propustkaUrl?: string
	adminKey?: string
}
