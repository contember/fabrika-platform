// The platform installation as data (ADR-0092): the four services, the stores they keep their state in and the hosts
// the proxy answers, with no provider's spelling. Each provider renders it into its own format (Zerops: the root
// `zerops.yaml` and the import documents; AWS: CloudFormation) and applies it from `platform install|deploy|upgrade`.
//
// What is NOT here, on purpose: sizes, probe timings, networks, build recipes, data-service hostnames and anything about
// application namespaces. Those are each provider's, or Control's (ADR-0014).
//
// The model names variables; it holds a value only for a `fixed` one. The values of the others are produced where they
// were before, by `installationServiceEnvironment` and `deployedServiceEnvironment`, and reach the services through a
// provider's applier. `__tests__/model.test.ts` holds the names here equal to the names those two functions write.

import { FABRIKA_SERVICE_TABLE_DIGEST, IAM_PROXY_SECRET_VARIABLE } from '@fabrika/auth-core'
import type { PlatformProxyService } from './proxy-manifest'
import type { InstallationSecrets } from './secrets'
import {
	IAM_OAUTH_CONFIG_VARIABLE,
	IAM_OIDC_CLIENT_SECRET_VARIABLE,
	OPERATIONS_OAUTH_RESOURCE_VARIABLE,
	type PlatformService,
} from './service-environment'

/** Every platform service, in the order the model lists them. A listing, not a deploy order (see `calls`). */
export const PLATFORM_SERVICES: readonly PlatformService[] = ['iam', 'operations', 'control', 'proxy']

/** The release's two build outputs: the workspace every Bun service runs from, and the proxy's own. */
export type PlatformArtifact = 'services' | 'proxy'

/** A database, by the service that owns it. Several may share one server: their tables and ledgers are disjoint (ADR-0017). */
export type PlatformDatabase = 'iam' | 'control' | 'operations'

/** A bucket, by what it holds. Their key prefixes are disjoint, so several may share one physical bucket. */
export type PlatformBucket = 'runLogs' | 'operationsBlobs'

/** One generated secret of `InstallationSecrets`. */
export type GeneratedSecret = keyof InstallationSecrets

/**
 * When a variable is written at all: always, or only when the installation uses what it configures. `provider-option`
 * is a provider's own variable written only when the operator gives that provider's option.
 */
export type VariableCondition = 'oidc' | 'email' | 'oauth' | 'provider-option'

/**
 * One variable a service reads, by kind (ADR-0092):
 *
 * - `fixed`: true for every installation, with its value;
 * - `address`: another service's private address, spelled whole by the renderer (`AddressOf`; `privateAddress` is the
 *   spelling where a service's name resolves and its own port is dialled);
 * - `data`: a database's DSN under `name`, or a bucket's coordinates under `prefix`, which the provider spells;
 * - `generated`: a secret generated once and shared by every reader of the same `secret`, whose entry in the model's
 *   `secrets` says whether an upgrade that finds it on no reader may generate it (`mint`) or must stop (`refuse`). A
 *   provider's own variable may carry no `secret`: a credential the provider makes for itself at install (Zerops mints
 *   Control's integration token), which an upgrade never makes;
 * - `bring-up`: the operator's choice at install, written once and never by a deploy;
 * - `derived`: computed from where the installation answers, rewritten by every deploy.
 */
export type ModelVariable =
	| { readonly kind: 'fixed'; readonly name: string; readonly value: string }
	| { readonly kind: 'address'; readonly name: string; readonly service: PlatformService }
	| { readonly kind: 'data'; readonly name: string; readonly database: PlatformDatabase }
	| { readonly kind: 'data'; readonly prefix: string; readonly bucket: PlatformBucket }
	| { readonly kind: 'generated'; readonly name: string; readonly secret?: GeneratedSecret }
	| { readonly kind: 'bring-up'; readonly name: string; readonly sensitive: boolean; readonly when?: VariableCondition }
	/** The mail transport's variables, named by the email provider the operator picks; its credentials sensitive. */
	| { readonly kind: 'bring-up'; readonly family: 'email'; readonly when: 'email' }
	| { readonly kind: 'derived'; readonly name: string; readonly sensitive: boolean; readonly when?: VariableCondition }

/** A listener of a service. */
export interface ServicePort {
	readonly name: string
	readonly port: number
	readonly http: boolean
}

/** A scheduled job: a Bun script in the services artifact, run once per schedule across the service's instances. */
export interface ScheduledJob {
	readonly command: string
	/**
	 * Five-field cron, UTC. A renderer that runs a job as a loop keeps an interval, not a time of day: it accepts every
	 * minute, every N minutes, and `M H * * *` as every 24 hours from the task's start. No job may rely on the hour it
	 * runs at.
	 */
	readonly schedule: string
}

export interface ModelService {
	readonly name: PlatformService
	readonly artifact: PlatformArtifact
	readonly ports: readonly ServicePort[]
	/** Liveness and readiness: an HTTP GET answering 2xx once the service serves. */
	readonly health: { readonly port: number; readonly path: string }
	/**
	 * Bun scripts in the services artifact: the migration run before the server, if any, and the server. Absent where
	 * the artifact starts itself (the proxy's).
	 */
	readonly entry?: { readonly migrate?: string; readonly server: string }
	readonly jobs: readonly ScheduledJob[]
	/** The services it dials over the private network. */
	readonly calls: readonly PlatformService[]
	readonly environment: readonly ModelVariable[]
	/** Publicly routed. The proxy alone (ADR-0022). */
	readonly public: boolean
}

export interface PlatformInstallationModel {
	readonly services: Readonly<Record<PlatformService, ModelService>>
	readonly databases: Readonly<Record<PlatformDatabase, { readonly owner: PlatformService }>>
	readonly buckets: Readonly<Record<PlatformBucket, { readonly owner: PlatformService }>>
	/** Each generated secret, and whether an upgrade may generate it when no reader holds it. */
	readonly secrets: Readonly<Record<GeneratedSecret, { readonly upgrade: 'mint' | 'refuse' }>>
	/** The public hosts, each routed to the public service. */
	readonly hosts: readonly PlatformProxyService[]
}

/** Control's entry points, which are its provider composition root's (`packages/control/src/<cloud>/`). */
export interface ControlEntry {
	readonly migrate: string
	readonly server: string
	readonly job: string
}

export interface PlatformInstallationModelInput {
	readonly control: ControlEntry
}

/** Every Bun service's one listener. */
export const PLATFORM_SERVICE_PORT = 3000
/** The proxy's public listener, and its health listener, which is never published. */
export const PLATFORM_PROXY_PORT = 8080
export const PLATFORM_PROXY_HEALTH_PORT = 8081
/** Liveness and readiness, on every service. */
export const PLATFORM_HEALTH_PATH = '/healthz'

const fixed = (name: string, value: string): ModelVariable => ({ kind: 'fixed', name, value })
const address = (name: string, service: PlatformService): ModelVariable => ({ kind: 'address', name, service })
const generated = (name: string, secret: GeneratedSecret): ModelVariable => ({ kind: 'generated', name, secret })
const derived = (name: string, when?: VariableCondition): ModelVariable => ({
	kind: 'derived',
	name,
	sensitive: false,
	...(when === undefined ? {} : { when }),
})
const bringUp = (name: string, options: { readonly sensitive?: boolean; readonly when?: VariableCondition } = {}): ModelVariable => ({
	kind: 'bring-up',
	name,
	sensitive: options.sensitive ?? false,
	...(options.when === undefined ? {} : { when: options.when }),
})
const EMAIL: ModelVariable = { kind: 'bring-up', family: 'email', when: 'email' }
const PORT = fixed('PORT', String(PLATFORM_SERVICE_PORT))

const bunService = (
	name: Exclude<PlatformService, 'proxy'>,
	entry: { readonly migrate: string; readonly server: string },
	job: ScheduledJob,
	calls: readonly PlatformService[],
	environment: readonly ModelVariable[],
): ModelService => ({
	name,
	artifact: 'services',
	ports: [{ name: 'http', port: PLATFORM_SERVICE_PORT, http: true }],
	health: { port: PLATFORM_SERVICE_PORT, path: PLATFORM_HEALTH_PATH },
	entry,
	jobs: [job],
	calls,
	environment,
	public: false,
})

/** The installation every release renders. Pure: the same input gives the same model. */
export const platformInstallationModel = (input: PlatformInstallationModelInput): PlatformInstallationModel =>
	checkInstallationModel({
		services: {
			iam: bunService(
				'iam',
				{ migrate: 'packages/iam/src/node/migrate.ts', server: 'packages/iam/src/node/server.ts' },
				{ command: 'packages/iam/src/node/prune.ts', schedule: '0 3 * * *' },
				// With a mail provider configured, IAM hands its mail to Control's relay.
				['control'],
				[
					PORT,
					address('FABRIKA_CONTROL_URL', 'control'),
					{ kind: 'data', name: 'FABRIKA_IAM_DATABASE_URL', database: 'iam' },
					derived('ENVIRONMENT'),
					// The `iss` of every minted token and the OIDC redirect base.
					derived('ISSUER'),
					bringUp('FABRIKA_IAM_OIDC_ENABLED'),
					bringUp('FABRIKA_IAM_PASSWORD_ENABLED'),
					bringUp('OIDC_ISSUER', { when: 'oidc' }),
					bringUp('OIDC_CLIENT_ID', { when: 'oidc' }),
					bringUp(IAM_OIDC_CLIENT_SECRET_VARIABLE, { sensitive: true, when: 'oidc' }),
					generated('FABRIKA_IAM_SIGNING_KEYS', 'signingKeys'),
					generated('FABRIKA_IAM_RPC_KEY', 'rpcKey'),
					generated('FABRIKA_IAM_PROXY_KEY', 'proxyKey'),
					generated('FABRIKA_IAM_PROVISIONING_KEY', 'provisioningKey'),
					generated('FABRIKA_IAM_DATA_KEY', 'dataKey'),
					EMAIL,
					// Derived from the provisioning key, so it is a credential: written sensitive.
					{ kind: 'derived', name: IAM_PROXY_SECRET_VARIABLE, sensitive: true },
					derived(IAM_OAUTH_CONFIG_VARIABLE, 'oauth'),
				],
			),
			operations: bunService(
				'operations',
				{ migrate: 'packages/operations/src/node/migrate.ts', server: 'packages/operations/src/node/server.ts' },
				{ command: 'packages/operations/src/node/cron.ts', schedule: '* * * * *' },
				// Control calls Operations (the catalog sync); Operations' Bun runtime calls IAM alone.
				['iam'],
				[
					PORT,
					address('FABRIKA_IAM_RPC_URL', 'iam'),
					{ kind: 'data', name: 'FABRIKA_OPERATIONS_DATABASE_URL', database: 'operations' },
					{ kind: 'data', prefix: 'FABRIKA_OPERATIONS_BLOB', bucket: 'operationsBlobs' },
					derived('FABRIKA_OPERATIONS_PUBLIC_HOST'),
					derived('ENVIRONMENT'),
					derived('FABRIKA_IAM_ISSUER'),
					generated('OPERATIONS_SYNC_KEY', 'operationsSyncKey'),
					generated('FABRIKA_IAM_RPC_KEY', 'rpcKey'),
					derived(OPERATIONS_OAUTH_RESOURCE_VARIABLE, 'oauth'),
				],
			),
			control: bunService(
				'control',
				{ migrate: input.control.migrate, server: input.control.server },
				{ command: input.control.job, schedule: '*/5 * * * *' },
				['iam', 'operations'],
				[
					PORT,
					fixed('FABRIKA_CONTROL_ASSETS_DIR', 'packages/dashboard/dist'),
					// The private transport for management RPC; the public issuer is `FABRIKA_IAM_ISSUER`.
					address('FABRIKA_IAM_RPC_URL', 'iam'),
					address('FABRIKA_OPERATIONS_URL', 'operations'),
					{ kind: 'data', name: 'FABRIKA_CONTROL_DATABASE_URL', database: 'control' },
					{ kind: 'data', prefix: 'FABRIKA_CONTROL_RUN_LOGS', bucket: 'runLogs' },
					derived('ENVIRONMENT'),
					// A bare host, not an origin.
					derived('FABRIKA_CONTROL_DOMAIN'),
					derived('FABRIKA_IAM_ISSUER'),
					derived('OPERATIONS_ARTIFACT_ORIGIN'),
					derived(FABRIKA_SERVICE_TABLE_DIGEST),
					generated('FABRIKA_IAM_RPC_KEY', 'rpcKey'),
					generated('OPERATIONS_SYNC_KEY', 'operationsSyncKey'),
					generated('FABRIKA_CONTROL_VAULT_KEY', 'vaultKey'),
					generated('FABRIKA_IAM_PROVISIONING_KEY', 'provisioningKey'),
					EMAIL,
				],
			),
			proxy: {
				name: 'proxy',
				artifact: 'proxy',
				ports: [
					{ name: 'http', port: PLATFORM_PROXY_PORT, http: true },
					{ name: 'health', port: PLATFORM_PROXY_HEALTH_PORT, http: true },
				],
				health: { port: PLATFORM_PROXY_HEALTH_PORT, path: PLATFORM_HEALTH_PATH },
				jobs: [],
				calls: ['iam', 'control', 'operations'],
				environment: [
					derived('ENVIRONMENT'),
					derived('FABRIKA_IAM_ISSUER'),
					// IAM's proxy key, under the name the proxy reads.
					generated('FABRIKA_IAM_KEY', 'proxyKey'),
					derived('FABRIKA_PROXY_SESSION_OWNER_JSON'),
					// Caddy sends it on the session owner's route.
					{ kind: 'derived', name: IAM_PROXY_SECRET_VARIABLE, sensitive: true },
				],
				public: true,
			},
		},
		databases: { iam: { owner: 'iam' }, control: { owner: 'control' }, operations: { owner: 'operations' } },
		buckets: { runLogs: { owner: 'control' }, operationsBlobs: { owner: 'operations' } },
		secrets: {
			signingKeys: { upgrade: 'refuse' },
			rpcKey: { upgrade: 'refuse' },
			proxyKey: { upgrade: 'refuse' },
			provisioningKey: { upgrade: 'refuse' },
			operationsSyncKey: { upgrade: 'refuse' },
			// A new vault key would orphan every application's secret.
			vaultKey: { upgrade: 'refuse' },
			// It seals only TOTP secrets, and an installation from before it has none to lose: its next deploy adds one.
			dataKey: { upgrade: 'mint' },
		},
		hosts: ['iam', 'control', 'operations'],
	})

/** A variable's name, or a bucket's prefix, or `email` for the mail family. */
export const variableKey = (variable: ModelVariable): string => {
	if ('name' in variable) return variable.name
	if ('prefix' in variable) return variable.prefix
	return variable.family
}

/** How a renderer spells a service's private address: the whole address, scheme and port included. */
export type AddressOf = (service: ModelService) => string

/**
 * `http://<name>:<first HTTP port>`: a service's private address where the service's name resolves on the private
 * network and its own port is dialled (Zerops' hostnames, AWS's Service Connect names). A cloud that reaches a service
 * another way (an ingress port, an `https://` URL) gives its own `AddressOf`.
 */
export const privateAddress: AddressOf = (service) => {
	const port = service.ports.find((candidate) => candidate.http)
	if (port === undefined) throw new Error(`installation model: ${service.name} has no HTTP port`)
	return `http://${service.name}:${port.port}`
}

/** A service's `fixed` and `address` variables, in the model's order, as a renderer writes them into its own document. */
export const staticEnvironment = (
	model: PlatformInstallationModel,
	service: PlatformService,
	address: AddressOf = privateAddress,
): ReadonlyArray<readonly [string, string]> =>
	model.services[service].environment.flatMap((variable): Array<readonly [string, string]> => {
		if (variable.kind === 'fixed') return [[variable.name, variable.value]]
		if (variable.kind === 'address') return [[variable.name, address(model.services[variable.service])]]
		return []
	})

/**
 * A provider's own variables on one service (ADR-0092), as given, or an error: none the model already names, each named
 * once, and each passing the checks the model's own variables pass (an address only to a service it calls, a store
 * read by its owner). A provider's `generated` variable may carry no `secret`: a credential it makes for itself.
 */
export const checkProviderVariables = (
	model: PlatformInstallationModel,
	service: PlatformService,
	variables: readonly ModelVariable[],
): readonly ModelVariable[] => {
	const taken = new Set(model.services[service].environment.map(variableKey))
	for (const variable of variables) {
		const key = variableKey(variable)
		if (taken.has(key)) throw new Error(`installation model: ${service}'s ${key} is named twice`)
		taken.add(key)
		checkVariable(model, service, variable, 'provider')
	}
	return variables
}

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/

/** One variable of `service`, the model's or a provider's: an error naming what breaks it. */
const checkVariable = (model: PlatformInstallationModel, name: PlatformService, variable: ModelVariable, whose: 'model' | 'provider'): void => {
	const fail = (message: string): never => {
		throw new Error(`installation model: ${message}`)
	}
	const key = variableKey(variable)
	if (!('family' in variable) && !VARIABLE_NAME.test(key)) fail(`${name}'s ${key} is not a variable's name`)
	if ('family' in variable && whose === 'provider') fail(`${name}'s provider variables name no family`)
	if (variable.kind === 'generated' && variable.secret === undefined && whose === 'model') {
		fail(`${name}'s ${key} is generated from no installation secret`)
	}
	if (variable.kind === 'address' && !model.services[name].calls.includes(variable.service)) {
		fail(`${name}'s ${key} addresses ${variable.service}, which it does not call`)
	}
	if ('database' in variable && model.databases[variable.database].owner !== name) {
		fail(`${name} reads the ${variable.database} database, which it does not own`)
	}
	if ('bucket' in variable && model.buckets[variable.bucket].owner !== name) fail(`${name} reads the ${variable.bucket} bucket, which it does not own`)
}

/** Each cron field's range: minute, hour, day of month, month, day of week (0 and 7 are Sunday). */
const CRON_RANGES: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

/** A five-field cron expression of `*`, `*` with a step, or one number, each in its field's range. */
const isCron = (schedule: string): boolean => {
	const fields = schedule.split(' ')
	return fields.length === CRON_RANGES.length && fields.every((field, index) => {
		const [low, high] = CRON_RANGES[index] ?? [0, -1]
		if (field === '*') return true
		const step = /^\*\/([1-9]\d*)$/.exec(field)?.[1]
		if (step !== undefined) return Number(step) <= high
		return /^\d+$/.test(field) && Number(field) >= low && Number(field) <= high
	})
}

/**
 * `model` as given, or an error naming what breaks it: one public service, the proxy; every variable named once per
 * service in a variable's form; an address only to a service it calls; a store read by its owner; a five-field cron.
 */
export const checkInstallationModel = (model: PlatformInstallationModel): PlatformInstallationModel => {
	const fail = (message: string): never => {
		throw new Error(`installation model: ${message}`)
	}
	for (const name of PLATFORM_SERVICES) {
		const service = model.services[name]
		if (service.name !== name) fail(`the ${name} entry is named ${service.name}`)
		if (service.public !== (name === 'proxy')) fail(`${name} is ${service.public ? '' : 'not '}public; the proxy alone is (ADR-0022)`)
		if (!service.ports.some((port) => port.port === service.health.port)) fail(`${name}'s health port is none of its ports`)
		if (service.calls.includes(name)) fail(`${name} calls itself`)
		const keys = service.environment.map(variableKey)
		const twice = keys.find((key, index) => keys.indexOf(key) !== index)
		if (twice !== undefined) fail(`${name} names ${twice} twice`)
		for (const variable of service.environment) checkVariable(model, name, variable, 'model')
		for (const job of service.jobs) {
			if (!isCron(job.schedule)) fail(`${name}'s job ${job.command} has a schedule of another form`)
		}
		if (service.entry === undefined && service.artifact === 'services') fail(`${name} runs from the services artifact with no entry`)
	}
	return model
}
