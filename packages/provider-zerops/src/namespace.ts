import type {
	JsonValue,
	ProviderCodec,
	ProviderDeploymentNamespace,
	ProviderEnvelope,
	ProviderNamespaceCapabilities,
	ProviderNamespaceMutationInput,
	ProviderNamespaceOperator,
	ProviderNamespacePlanInput,
	ProviderNamespacePresentation,
	ProviderNamespacePreset,
	ProviderRegistration,
} from '@fabrika/provider-contract'
import { encodeProxyManifestJson, FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-contract'
import {
	ZEROPS_ACTIVE,
	ZEROPS_SERVICE_NOT_HTTP,
	ZEROPS_TERMINAL,
	type ZeropsApi,
	ZeropsApiError,
	type ZeropsAppVersion,
	type ZeropsProject,
	type ZeropsProjectMode,
	type ZeropsService,
} from './api'
import { defaultSleep, type Sleeper } from './collaborators'
import { compileImportYaml, compileProvisioningYaml } from './compile'
import { manifestServiceHostnames, parseFabrikaManifest, zeropsArtifactCodec } from './manifest'
import { zeropsSharedServicePrefix } from './service-names'
import type { ZeropsServiceSpec, ZeropsSourceTarget } from './types'

export const ZEROPS_NAMESPACE_PROXY_HOSTNAME = 'proxy'
export const ZEROPS_NAMESPACE_POSTGRES_HOSTNAME = 'postgres'
export const ZEROPS_NAMESPACE_IAM_URL_VARIABLE = 'FABRIKA_IAM_URL'
export const ZEROPS_NAMESPACE_IAM_KEY_VARIABLE = 'FABRIKA_IAM_KEY'
/**
 * How an app reaches the namespace-owned PostgreSQL service — port, database and TLS mode NAMED, not
 * defaulted. Every part settled against a live account, none of it safe to infer:
 *
 *   • `${x_connectionTlsString}` is `postgresql://${user}:${password}@${hostname}:${portTls}` — no
 *     database path. With none, the libpq/postgres.js convention falls back to the USER name.
 *   • `dbName` and `user` are both literally `db` on EVERY PostgreSQL service, whatever its hostname
 *     (checked on a service named `wu2db`). So the fallback lands right today — by construction rather
 *     than by luck, but still by a rule nobody wrote down. `/${x_dbName}` says it out loud.
 *   • THE TLS PORT, NOT THE DIRECT ONE, and this is the one that changed. `postgresql:single@18`
 *     speaks TLS on both; `postgresql:ha@18` speaks it ONLY on `portTls` and answers `sslmode=require`
 *     on the direct port with "Server does not support SSL". A namespace picks `ha` for `prod` and
 *     `single` everywhere else, so a DSN naming the direct port is one preset away from failing.
 *   • `portTls` preserves SESSION state on both — same backend pid across statements, `SET SESSION`
 *     kept, advisory lock held and visible — so the migration runner's session-level lock is safe
 *     there. It is a TLS endpoint, not the transaction pool the port number suggests.
 *   • `verify-full` fails (`self signed certificate`), so `require` is the strongest mode available.
 */
export const ZEROPS_SHARED_POSTGRES_CONNECTION_STRING = '${postgres_connectionTlsString}/${postgres_dbName}?sslmode=require'

const PROXY_TYPE = 'alpine@3.21'
const EMPTY_PROXY_MANIFEST = encodeProxyManifestJson({ apps: [] })
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 70 * 60 * 1000
/** The live enable finishes in under a second, but one run still read `false` once before flipping; ten reads is slack. */
const SUBDOMAIN_READBACK_ATTEMPTS = 10

export type ZeropsNamespacePublicAccess = 'custom-domain' | 'zerops-subdomain'

export type ZeropsNamespacePostgres =
	| {
		readonly type: 'postgresql:ha@18'
		readonly profile?: 'oltp-staging' | 'oltp-production' | 'oltp-enterprise' | 'olap-production' | 'writeheavy-production'
	}
	| {
		readonly type: 'postgresql:single@18'
		readonly profile?: 'oltp-hobby' | 'oltp-staging' | 'oltp-production' | 'olap-production' | 'writeheavy-production'
	}

/**
 * Provider-owned namespace state. Optional fields are durable progress checkpoints; values that are
 * absent are resolved by `normalize()` before a mutation starts.
 */
export interface ZeropsNamespaceTarget {
	readonly projectName?: string
	readonly corePackage?: ZeropsProjectMode
	readonly publicAccess?: ZeropsNamespacePublicAccess
	readonly proxyBuildFromGit?: string
	readonly postgres?: ZeropsNamespacePostgres
	readonly managed?: boolean
	readonly projectId?: string
	readonly proxyServiceId?: string
	readonly postgresServiceId?: string
	readonly proxyConfigured?: boolean
	readonly proxyBaselineSequence?: number
	readonly proxyAppVersionId?: string
	readonly ready?: boolean
}

interface NormalizedZeropsNamespaceTarget extends ZeropsNamespaceTarget {
	readonly projectName: string
	readonly corePackage: ZeropsProjectMode
	readonly publicAccess: ZeropsNamespacePublicAccess
	readonly proxyBuildFromGit: string
	readonly managed: boolean
	readonly ready: boolean
}

export interface ZeropsNamespaceOptions {
	readonly clientId: string
	readonly proxyBuildFromGit: string
	/** Public IAM origin reachable from an app project. */
	readonly iamUrl: string
	/** Same credential IAM receives as `FABRIKA_IAM_PROXY_KEY`. */
	readonly iamKey: string
	readonly api: ZeropsApi
	readonly sleep?: Sleeper
}

export interface ZeropsNamespaceTopology {
	readonly source: ZeropsSourceTarget
	readonly createYaml: string
	readonly servicesProvisionYaml: string
	readonly servicesSteadyYaml: string
}

export interface ZeropsNamespacePresetInput {
	readonly preset: 'cheap' | 'mid' | 'full'
	readonly env: string
	readonly projectName: string
	readonly corePackage?: ZeropsProjectMode
	readonly publicAccess?: ZeropsNamespacePublicAccess
	readonly proxyBuildFromGit: string
	readonly postgres?: ZeropsNamespacePostgres
}

export interface ZeropsNamespaceOperatorOptions {
	readonly proxyBuildFromGit: string
}

export interface ZeropsNamespacePlanOptions {
	readonly projectName?: string
	readonly corePackage?: ZeropsProjectMode
	readonly publicAccess?: ZeropsNamespacePublicAccess
	readonly postgres?: ZeropsNamespacePostgres
}

const property = (payload: JsonValue, key: string): JsonValue | undefined => {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
		throw new Error('Zerops namespace target must be an object')
	}
	return payload[key]
}

const optionalString = (payload: JsonValue, key: string): string | undefined => {
	const value = property(payload, key)
	if (value === undefined) return undefined
	if (typeof value !== 'string' || value === '') {
		throw new Error(`Zerops namespace target ${key} must be a non-empty string`)
	}
	return value
}

const optionalBoolean = (payload: JsonValue, key: string): boolean | undefined => {
	const value = property(payload, key)
	if (value === undefined) return undefined
	if (typeof value !== 'boolean') {
		throw new Error(`Zerops namespace target ${key} must be a boolean`)
	}
	return value
}

const optionalInteger = (payload: JsonValue, key: string): number | undefined => {
	const value = property(payload, key)
	if (value === undefined) return undefined
	if (typeof value !== 'number' || !Number.isInteger(value) || value < -1) {
		throw new Error(`Zerops namespace target ${key} must be an integer greater than or equal to -1`)
	}
	return value
}

const postgresProfiles = {
	'postgresql:ha@18': new Set(['oltp-staging', 'oltp-production', 'oltp-enterprise', 'olap-production', 'writeheavy-production']),
	'postgresql:single@18': new Set(['oltp-hobby', 'oltp-staging', 'oltp-production', 'olap-production', 'writeheavy-production']),
}

const parsePostgres = (payload: JsonValue): ZeropsNamespacePostgres | undefined => {
	const value = property(payload, 'postgres')
	if (value === undefined) return undefined
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Zerops namespace target postgres must be an object')
	}
	const type = property(value, 'type')
	const profile = property(value, 'profile')
	if (type !== 'postgresql:ha@18' && type !== 'postgresql:single@18') {
		throw new Error('Zerops namespace PostgreSQL type must be postgresql:ha@18 or postgresql:single@18')
	}
	if (profile !== undefined && (typeof profile !== 'string' || !postgresProfiles[type].has(profile))) {
		throw new Error(`Zerops namespace PostgreSQL profile is not supported by ${type}`)
	}
	if (type === 'postgresql:ha@18') {
		if (
			profile !== undefined
			&& profile !== 'oltp-staging'
			&& profile !== 'oltp-production'
			&& profile !== 'oltp-enterprise'
			&& profile !== 'olap-production'
			&& profile !== 'writeheavy-production'
		) {
			throw new Error(`Zerops namespace PostgreSQL profile is not supported by ${type}`)
		}
		return profile === undefined ? { type } : { type, profile }
	}
	if (
		profile !== undefined
		&& profile !== 'oltp-hobby'
		&& profile !== 'oltp-staging'
		&& profile !== 'oltp-production'
		&& profile !== 'olap-production'
		&& profile !== 'writeheavy-production'
	) {
		throw new Error(`Zerops namespace PostgreSQL profile is not supported by ${type}`)
	}
	return profile === undefined ? { type } : { type, profile }
}

export const zeropsNamespaceTargetCodec: ProviderCodec<ZeropsNamespaceTarget> = {
	version: 1,
	encode: (target) => ({
		...(target.projectName !== undefined ? { projectName: target.projectName } : {}),
		...(target.corePackage !== undefined ? { corePackage: target.corePackage } : {}),
		...(target.publicAccess !== undefined ? { publicAccess: target.publicAccess } : {}),
		...(target.proxyBuildFromGit !== undefined ? { proxyBuildFromGit: target.proxyBuildFromGit } : {}),
		...(target.postgres !== undefined
			? { postgres: { type: target.postgres.type, ...(target.postgres.profile !== undefined ? { profile: target.postgres.profile } : {}) } }
			: {}),
		...(target.managed !== undefined ? { managed: target.managed } : {}),
		...(target.projectId !== undefined ? { projectId: target.projectId } : {}),
		...(target.proxyServiceId !== undefined ? { proxyServiceId: target.proxyServiceId } : {}),
		...(target.postgresServiceId !== undefined ? { postgresServiceId: target.postgresServiceId } : {}),
		...(target.proxyConfigured !== undefined ? { proxyConfigured: target.proxyConfigured } : {}),
		...(target.proxyBaselineSequence !== undefined ? { proxyBaselineSequence: target.proxyBaselineSequence } : {}),
		...(target.proxyAppVersionId !== undefined ? { proxyAppVersionId: target.proxyAppVersionId } : {}),
		...(target.ready !== undefined ? { ready: target.ready } : {}),
	}),
	decode: (payload) => {
		const corePackage = optionalString(payload, 'corePackage')
		if (corePackage !== undefined && corePackage !== 'LIGHT' && corePackage !== 'SERIOUS') {
			throw new Error('Zerops namespace target corePackage must be LIGHT or SERIOUS')
		}
		const publicAccess = optionalString(payload, 'publicAccess')
		if (publicAccess !== undefined && publicAccess !== 'custom-domain' && publicAccess !== 'zerops-subdomain') {
			throw new Error('Zerops namespace target publicAccess is not supported')
		}
		return {
			...(optionalString(payload, 'projectName') !== undefined ? { projectName: optionalString(payload, 'projectName') } : {}),
			...(corePackage !== undefined ? { corePackage } : {}),
			...(publicAccess !== undefined ? { publicAccess } : {}),
			...(optionalString(payload, 'proxyBuildFromGit') !== undefined
				? { proxyBuildFromGit: optionalString(payload, 'proxyBuildFromGit') }
				: {}),
			...(parsePostgres(payload) !== undefined ? { postgres: parsePostgres(payload) } : {}),
			...(optionalBoolean(payload, 'managed') !== undefined ? { managed: optionalBoolean(payload, 'managed') } : {}),
			...(optionalString(payload, 'projectId') !== undefined ? { projectId: optionalString(payload, 'projectId') } : {}),
			...(optionalString(payload, 'proxyServiceId') !== undefined ? { proxyServiceId: optionalString(payload, 'proxyServiceId') } : {}),
			...(optionalString(payload, 'postgresServiceId') !== undefined
				? { postgresServiceId: optionalString(payload, 'postgresServiceId') }
				: {}),
			...(optionalBoolean(payload, 'proxyConfigured') !== undefined
				? { proxyConfigured: optionalBoolean(payload, 'proxyConfigured') }
				: {}),
			...(optionalInteger(payload, 'proxyBaselineSequence') !== undefined
				? { proxyBaselineSequence: optionalInteger(payload, 'proxyBaselineSequence') }
				: {}),
			...(optionalString(payload, 'proxyAppVersionId') !== undefined
				? { proxyAppVersionId: optionalString(payload, 'proxyAppVersionId') }
				: {}),
			...(optionalBoolean(payload, 'ready') !== undefined ? { ready: optionalBoolean(payload, 'ready') } : {}),
		}
	},
}

const envelope = (target: ZeropsNamespaceTarget): ProviderEnvelope => ({
	provider: 'zerops',
	version: zeropsNamespaceTargetCodec.version,
	payload: zeropsNamespaceTargetCodec.encode(target),
})

const decodeEnvelope = (value: ProviderEnvelope): ZeropsNamespaceTarget => {
	if (value.provider !== 'zerops') {
		throw new Error(`namespace belongs to provider "${value.provider}", expected "zerops"`)
	}
	if (value.version !== zeropsNamespaceTargetCodec.version) {
		throw new Error(`namespace schema version ${value.version} is not supported by provider "zerops"`)
	}
	return zeropsNamespaceTargetCodec.decode(value.payload)
}

const namespaceResourceClaims = (namespace: ProviderDeploymentNamespace): string[] => {
	const target = decodeEnvelope(namespace.target)
	return [
		`service:${ZEROPS_NAMESPACE_PROXY_HOSTNAME}`,
		...(target.postgres === undefined ? [] : [`service:${ZEROPS_NAMESPACE_POSTGRES_HOSTNAME}`]),
	]
}

const registrationResourceClaims = (registration: ProviderRegistration): string[] => {
	const namespace = registration.environment.namespace
	if (namespace === undefined) {
		throw new Error('Zerops registration requires a deployment namespace')
	}
	if (
		namespace.exclusiveAppId !== undefined
		&& namespace.exclusiveAppId !== registration.app.id
	) {
		throw new Error(`Zerops namespace is exclusive to app \`${namespace.exclusiveAppId}\``)
	}
	const artifactEnvelope = registration.environment.artifact
	if (artifactEnvelope.provider !== 'zerops' || artifactEnvelope.version !== zeropsArtifactCodec.version) {
		throw new Error('Zerops registration artifact envelope is not supported')
	}
	const manifest = parseFabrikaManifest(zeropsArtifactCodec.decode(artifactEnvelope.payload), {
		appId: registration.app.id,
		env: registration.environment.env,
	})
	const namespaceClaims = new Set(namespaceResourceClaims(namespace))
	for (const requirement of manifest.target.namespaceResources ?? []) {
		if (!namespaceClaims.has(requirement.resourceKey)) {
			throw new Error(`Zerops namespace does not provide required resource \`${requirement.resourceKey}\``)
		}
	}
	const hostnames = manifestServiceHostnames(manifest)
	for (const hostname of hostnames) {
		const key = `service:${hostname}`
		if (namespaceClaims.has(key)) {
			throw new Error(`Zerops service hostname \`${hostname}\` is reserved by the namespace`)
		}
	}
	if (namespace.exclusiveAppId === undefined) {
		const prefix = zeropsSharedServicePrefix(registration.app.id)
		for (const hostname of hostnames) {
			if (!hostname.startsWith(prefix) || hostname.length === prefix.length) {
				throw new Error(`Zerops shared namespace service \`${hostname}\` must use app prefix \`${prefix}\``)
			}
		}
	}
	return hostnames.map((hostname) => `service:${hostname}`).sort()
}

/**
 * The namespace-owned PostgreSQL service, sized rather than defaulted.
 *
 * Omitting `profile` is not neutral: an HA service silently gets `oltp-production` (two DEDICATED cores
 * and 4 GB per container, three containers) and a single one gets `oltp-staging`. Both verified by
 * reading the profile back off a live service. Production takes the production preset deliberately;
 * everything else takes the cheapest one its type offers, because a namespace database for a staging
 * app should cost what staging is worth.
 */
const defaultPostgres = (env: string): ZeropsNamespacePostgres =>
	env === 'prod' ? { type: 'postgresql:ha@18', profile: 'oltp-production' } : { type: 'postgresql:single@18', profile: 'oltp-hobby' }

export const zeropsNamespacePreset = (input: ZeropsNamespacePresetInput): ZeropsNamespaceTarget => ({
	projectName: input.projectName,
	corePackage: input.corePackage ?? (input.env === 'prod' ? 'SERIOUS' : 'LIGHT'),
	publicAccess: input.publicAccess ?? 'custom-domain',
	proxyBuildFromGit: input.proxyBuildFromGit,
	managed: true,
	ready: false,
	...(input.preset === 'cheap' ? { postgres: input.postgres ?? defaultPostgres(input.env) } : {}),
})

const projectMarker = (namespace: ProviderDeploymentNamespace): string => `Managed by Fabrika namespace ${namespace.id} (${namespace.env}).`

// No `zeropsSetup`: the platform reads it as pipeline configuration and rejects the whole import unless
// the service also names a `buildFromGit`, which an import that only PROVISIONS does not. The setup name
// is supplied where it is actually needed — the `triggerPipeline` call in the namespace lifecycle below,
// which passes both. `assertZeropsInvariants` refuses the invalid combination.
//
// `enableSubdomainAccess` is a DECLARATION here and not a mechanism: the platform accepts it and drops it,
// including on the service this document creates. `ensureSubdomainAccess` below is what establishes the
// subdomain, after the proxy's first deploy. Written anyway because it is what ADR-0007's
// `assertOnlyPublicService` reads to prove no other service is claimed public.
const proxyService = (publicAccess: ZeropsNamespacePublicAccess): ZeropsServiceSpec => ({
	hostname: ZEROPS_NAMESPACE_PROXY_HOSTNAME,
	type: PROXY_TYPE,
	priority: 10,
	enableSubdomainAccess: publicAccess === 'zerops-subdomain',
	minContainers: 2,
	maxContainers: 6,
})

const postgresService = (postgres: ZeropsNamespacePostgres): ZeropsServiceSpec => ({
	hostname: ZEROPS_NAMESPACE_POSTGRES_HOSTNAME,
	type: postgres.type,
	priority: 100,
	...(postgres.profile !== undefined ? { profile: postgres.profile } : {}),
})

/** Compile the one project and its namespace-owned services without depending on private deploy code. */
export const compileZeropsNamespaceTopology = (
	namespace: ProviderDeploymentNamespace,
	target: ZeropsNamespaceTarget,
): ZeropsNamespaceTopology => {
	const projectName = target.projectName
	const corePackage = target.corePackage
	const publicAccess = target.publicAccess
	if (projectName === undefined || corePackage === undefined || publicAccess === undefined) {
		throw new Error('Zerops namespace topology requires normalized project policy')
	}
	const services = (): ZeropsServiceSpec[] => [
		...(target.postgres === undefined ? [] : [postgresService(target.postgres)]),
		proxyService(publicAccess),
	]
	const source: ZeropsSourceTarget = {
		platform: 'zerops',
		project: {
			name: projectName,
			description: projectMarker(namespace),
			corePackage,
			tags: ['fabrika', 'namespace', namespace.id, namespace.env],
		},
		services,
	}
	const serviceSource: ZeropsSourceTarget = { platform: 'zerops', services }
	return {
		source,
		createYaml: compileProvisioningYaml({ target: source, ctx: { env: namespace.env } }).yaml,
		servicesProvisionYaml: compileProvisioningYaml({ target: serviceSource, ctx: { env: namespace.env } }).yaml,
		servicesSteadyYaml: compileImportYaml({ target: serviceSource, ctx: { env: namespace.env } }).yaml,
	}
}

const ZEROPS_NAMESPACE_PRESETS: readonly ProviderNamespacePreset[] = [
	{
		id: 'cheap',
		label: 'Cheap',
		description: 'Several apps share one project, proxy, and namespace-owned PostgreSQL service.',
		requiresExclusiveApp: false,
	},
	{
		id: 'mid',
		label: 'Mid',
		description: 'Several apps share one project and proxy; each app owns its prefixed database services.',
		requiresExclusiveApp: false,
	},
	{
		id: 'full',
		label: 'Full',
		description: 'One project and proxy are reserved for exactly one app.',
		requiresExclusiveApp: true,
	},
]

const parsePlanOptions = (value: JsonValue | undefined): ZeropsNamespacePlanOptions => {
	if (value === undefined) return {}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Zerops namespace plan options must be an object')
	}
	const supported = new Set(['projectName', 'corePackage', 'publicAccess', 'postgres'])
	for (const key of Object.keys(value)) {
		if (!supported.has(key)) {
			throw new Error(`Zerops namespace plan option ${key} is not supported`)
		}
	}
	const projectName = optionalString(value, 'projectName')
	const corePackage = optionalString(value, 'corePackage')
	if (corePackage !== undefined && corePackage !== 'LIGHT' && corePackage !== 'SERIOUS') {
		throw new Error('Zerops namespace plan corePackage must be LIGHT or SERIOUS')
	}
	const publicAccess = optionalString(value, 'publicAccess')
	if (publicAccess !== undefined && publicAccess !== 'custom-domain' && publicAccess !== 'zerops-subdomain') {
		throw new Error('Zerops namespace plan publicAccess is not supported')
	}
	const postgres = parsePostgres(value)
	return {
		...(projectName === undefined ? {} : { projectName }),
		...(corePackage === undefined ? {} : { corePackage }),
		...(publicAccess === undefined ? {} : { publicAccess }),
		...(postgres === undefined ? {} : { postgres }),
	}
}

const namespacePresentation = (
	namespace: ProviderDeploymentNamespace,
	target: ZeropsNamespaceTarget,
): ProviderNamespacePresentation => {
	const preset = target.postgres !== undefined ? 'cheap' : namespace.exclusiveAppId === undefined ? 'mid' : 'full'
	const projectName = target.projectName ?? namespace.id
	const corePackage = target.corePackage ?? (namespace.env === 'prod' ? 'SERIOUS' : 'LIGHT')
	const publicAccess = target.publicAccess ?? 'custom-domain'
	const postgres = target.postgres === undefined
		? 'App-owned database services'
		: `Shared ${target.postgres.type}${target.postgres.profile === undefined ? '' : ` (${target.postgres.profile})`}`
	const instructions = [
		...(publicAccess === 'custom-domain'
			? [`Bind each application domain to the \`proxy\` service in Zerops project \`${projectName}\`; keep every app service private.`]
			: ['Use the proxy Zerops subdomain only for non-production access; app services must remain private.']),
		...(target.postgres === undefined
			? []
			: ['Every app consuming the shared PostgreSQL binding shares its physical service and provider-issued credential.']),
	]
	return {
		preset,
		title: `${ZEROPS_NAMESPACE_PRESETS.find((candidate) => candidate.id === preset)?.label ?? preset} namespace`,
		facts: [
			{ label: 'Project', value: projectName },
			{ label: 'Environment', value: namespace.env },
			{ label: 'Core package', value: corePackage },
			{ label: 'Placement', value: namespace.exclusiveAppId === undefined ? 'Shared' : `Exclusive to ${namespace.exclusiveAppId}` },
			{ label: 'PostgreSQL', value: postgres },
			{ label: 'Public access', value: publicAccess },
		],
		instructions,
	}
}

/** Build the provider-owned namespace planning surface without any network collaborators. */
export const createZeropsNamespaceOperator = (
	options: ZeropsNamespaceOperatorOptions,
): ProviderNamespaceOperator => {
	if (options.proxyBuildFromGit.trim() === '') {
		throw new Error('Zerops namespace proxyBuildFromGit must be a non-empty string')
	}
	return {
		presets: ZEROPS_NAMESPACE_PRESETS,
		plan(input: ProviderNamespacePlanInput) {
			if (input.id.trim() === '' || input.env.trim() === '') {
				throw new Error('Zerops namespace plan id and env must be non-empty')
			}
			if (input.preset !== 'cheap' && input.preset !== 'mid' && input.preset !== 'full') {
				throw new Error(`Zerops namespace preset ${input.preset} is not supported`)
			}
			const exclusiveAppId = input.exclusiveAppId?.trim()
			if (input.preset === 'full' && (exclusiveAppId === undefined || exclusiveAppId === '')) {
				throw new Error('Zerops full namespace plan requires exclusiveAppId')
			}
			if (input.preset !== 'full' && exclusiveAppId !== undefined) {
				throw new Error(`Zerops ${input.preset} namespace plan cannot reserve an exclusive app`)
			}
			const planOptions = parsePlanOptions(input.options)
			if (input.preset !== 'cheap' && planOptions.postgres !== undefined) {
				throw new Error(`Zerops ${input.preset} namespace plan cannot own PostgreSQL`)
			}
			const target = zeropsNamespacePreset({
				preset: input.preset,
				env: input.env,
				projectName: planOptions.projectName ?? input.id,
				proxyBuildFromGit: options.proxyBuildFromGit,
				...(planOptions.corePackage === undefined ? {} : { corePackage: planOptions.corePackage }),
				...(planOptions.publicAccess === undefined ? {} : { publicAccess: planOptions.publicAccess }),
				...(planOptions.postgres === undefined ? {} : { postgres: planOptions.postgres }),
			})
			const namespace: ProviderDeploymentNamespace = {
				id: input.id,
				env: input.env,
				...(exclusiveAppId === undefined ? {} : { exclusiveAppId }),
				target: envelope(target),
			}
			return { namespace, presentation: namespacePresentation(namespace, target) }
		},
		present(namespace) {
			return namespacePresentation(namespace, decodeEnvelope(namespace.target))
		},
	}
}

const normalizeTarget = (
	namespace: ProviderDeploymentNamespace,
	options: ZeropsNamespaceOptions,
): NormalizedZeropsNamespaceTarget => {
	if (namespace.id.trim() === '' || namespace.env.trim() === '') {
		throw new Error('Zerops namespace id and env must be non-empty')
	}
	const decoded = decodeEnvelope(namespace.target)
	const proxyBuildFromGit = decoded.proxyBuildFromGit ?? options.proxyBuildFromGit
	if (proxyBuildFromGit.trim() === '') {
		throw new Error('Zerops namespace proxy source must be a non-empty public Git URL')
	}
	return {
		...decoded,
		projectName: decoded.projectName ?? namespace.id,
		corePackage: decoded.corePackage ?? (namespace.env === 'prod' ? 'SERIOUS' : 'LIGHT'),
		publicAccess: decoded.publicAccess ?? 'custom-domain',
		proxyBuildFromGit,
		managed: decoded.managed ?? decoded.projectId === undefined,
		ready: decoded.ready ?? false,
	}
}

const normalizedNamespace = (
	namespace: ProviderDeploymentNamespace,
	options: ZeropsNamespaceOptions,
): ProviderDeploymentNamespace => ({
	...namespace,
	target: envelope(normalizeTarget(namespace, options)),
})

const withTarget = (
	namespace: ProviderDeploymentNamespace,
	target: ZeropsNamespaceTarget,
): ProviderDeploymentNamespace => ({ ...namespace, target: envelope(target) })

const checkpoint = async (
	input: ProviderNamespaceMutationInput,
	namespace: ProviderDeploymentNamespace,
	target: ZeropsNamespaceTarget,
): Promise<ProviderDeploymentNamespace> => {
	const updated = withTarget(namespace, target)
	await input.events.checkpoint(updated)
	return updated
}

const validateProject = (
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	project: ZeropsProject,
	adopting: boolean,
): void => {
	if (project.id === '') {
		throw new Error('Zerops namespace project returned an empty id')
	}
	if (target.projectName !== project.name) {
		throw new Error(`Zerops namespace project name mismatch: expected \`${target.projectName}\`, got \`${project.name}\``)
	}
	if (project.mode !== target.corePackage) {
		throw new Error(`Zerops namespace project ${project.id} uses ${project.mode ?? 'an unknown core package'}, expected ${target.corePackage}`)
	}
	// Zerops does not expose project envIsolation. Every managed service import writes its own override.
	if (!adopting && target.managed && project.description?.includes(projectMarker(namespace)) !== true) {
		throw new Error(`Zerops namespace project ${project.id} has a different Fabrika ownership marker`)
	}
}

const managedProjectByMarker = async (
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<ZeropsProject | null> => {
	const matches = await options.api.findProjects({
		clientId: options.clientId,
		name: target.projectName,
		signal,
	})
	const owned: ZeropsProject[] = []
	for (const match of matches) {
		const project = await options.api.getProject({ projectId: match.id, signal })
		if (project.description?.includes(projectMarker(namespace)) === true) {
			owned.push(project)
		}
	}
	if (owned.length > 1) {
		throw new Error(`Zerops namespace project name \`${target.projectName}\` has multiple matching Fabrika ownership markers`)
	}
	if (owned.length === 1) {
		return owned[0] ?? null
	}
	if (matches.length > 0) {
		throw new Error(`Zerops namespace project name \`${target.projectName}\` is already used without this namespace's ownership marker`)
	}
	return null
}

const uniqueService = (services: ZeropsService[], hostname: string): ZeropsService | null => {
	const matches = services.filter((service) => service.name === hostname)
	if (matches.length > 1) {
		throw new Error(`Zerops namespace has multiple services named \`${hostname}\``)
	}
	return matches[0] ?? null
}

const validateService = (
	service: ZeropsService,
	projectId: string,
	expectedBase: string,
	adopting: boolean,
	expectedPublic?: boolean,
	expectedProfile?: string,
): void => {
	if (service.id === '') {
		throw new Error(`Zerops namespace service \`${service.name}\` returned an empty id`)
	}
	if (service.projectId !== undefined && service.projectId !== projectId) {
		throw new Error(`Zerops namespace service \`${service.name}\` belongs to another project`)
	}
	if ((adopting || service.base !== undefined) && service.base !== expectedBase) {
		throw new Error(`Zerops namespace service \`${service.name}\` uses ${service.base ?? 'an unknown type'}, expected ${expectedBase}`)
	}
	if (expectedPublic !== undefined && adopting && service.subdomainAccess !== expectedPublic) {
		throw new Error(`Zerops namespace service \`${service.name}\` has incompatible public access`)
	}
	if (expectedProfile !== undefined && service.autoscalingProfileId !== expectedProfile) {
		throw new Error(
			`Zerops namespace service \`${service.name}\` uses profile ${service.autoscalingProfileId ?? 'unknown'}, expected ${expectedProfile}`,
		)
	}
}

const resolveServices = async (
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
	adopting: boolean,
): Promise<{ proxy: ZeropsService; postgres?: ZeropsService }> => {
	const projectId = target.projectId
	if (projectId === undefined) {
		throw new Error('Zerops namespace has no project id')
	}
	const services = await options.api.listProjectServices({ projectId, signal })
	const proxy = uniqueService(services, ZEROPS_NAMESPACE_PROXY_HOSTNAME)
	if (proxy === null) {
		throw new Error(`Zerops namespace project ${projectId} has no proxy service`)
	}
	validateService(
		proxy,
		projectId,
		PROXY_TYPE,
		adopting,
		target.publicAccess === 'zerops-subdomain',
	)
	const postgres = uniqueService(services, ZEROPS_NAMESPACE_POSTGRES_HOSTNAME)
	if (target.postgres === undefined && postgres !== null && adopting) {
		throw new Error(`Zerops namespace project ${projectId} has an undeclared namespace PostgreSQL service`)
	}
	if (target.postgres !== undefined) {
		if (postgres === null) {
			throw new Error(`Zerops namespace project ${projectId} has no shared PostgreSQL service`)
		}
		validateService(postgres, projectId, target.postgres.type, adopting, undefined, target.postgres.profile)
	}
	if (adopting && namespace.exclusiveAppId !== undefined) {
		const reserved = new Set([
			ZEROPS_NAMESPACE_PROXY_HOSTNAME,
			...(target.postgres === undefined ? [] : [ZEROPS_NAMESPACE_POSTGRES_HOSTNAME]),
		])
		const unexpected = services.filter((service) => !reserved.has(service.name))
		if (unexpected.length > 0) {
			throw new Error(`exclusive Zerops namespace project ${projectId} contains unmanaged service \`${unexpected[0]?.name ?? 'unknown'}\``)
		}
	}
	return postgres === null ? { proxy } : { proxy, postgres }
}

const ensureProxyConfiguration = async (
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<boolean> => {
	const proxyServiceId = target.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	const variables = await options.api.listServiceEnv({ serviceId: proxyServiceId, signal })
	const byKey = new Map(variables.map((variable) => [variable.key, variable]))
	let deployRequired = !target.ready
	const manifest = byKey.get(FABRIKA_PROXY_MANIFEST_JSON)
	if (!target.ready || manifest === undefined) {
		await options.api.putServiceEnv({
			serviceId: proxyServiceId,
			key: FABRIKA_PROXY_MANIFEST_JSON,
			value: EMPTY_PROXY_MANIFEST,
			signal,
		})
		deployRequired = true
	}
	const iamUrl = byKey.get(ZEROPS_NAMESPACE_IAM_URL_VARIABLE)
	if (iamUrl?.content !== options.iamUrl) {
		await options.api.putServiceEnv({
			serviceId: proxyServiceId,
			key: ZEROPS_NAMESPACE_IAM_URL_VARIABLE,
			value: options.iamUrl,
			signal,
		})
	}
	// Secret read-back is not trustworthy, so overwrite it idempotently without inspecting its value.
	await options.api.putServiceEnv({
		serviceId: proxyServiceId,
		key: ZEROPS_NAMESPACE_IAM_KEY_VARIABLE,
		value: options.iamKey,
		signal,
	})
	return deployRequired
}

const latestAfterBaseline = async (
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<ZeropsAppVersion | null> => {
	const proxyServiceId = target.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	const latest = await options.api.latestAppVersion({ serviceId: proxyServiceId, signal })
	const baseline = target.proxyBaselineSequence
	if (latest === null || baseline === undefined || latest.sequence === undefined || latest.sequence <= baseline) {
		return null
	}
	return latest
}

const terminalFailure = (version: ZeropsAppVersion): Error =>
	new Error(`Zerops namespace proxy deploy ${version.id} finished as ${version.status ?? 'unknown'}`)

const waitForProxy = async (
	appVersionId: string,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<ZeropsAppVersion> => {
	const deadline = Date.now() + POLL_TIMEOUT_MS
	for (;;) {
		if (signal.aborted) {
			throw new Error('Zerops namespace provisioning was cancelled')
		}
		const version = await options.api.getAppVersion({ appVersionId, signal })
		if (version.status !== undefined && ZEROPS_TERMINAL.has(version.status)) {
			return version
		}
		if (Date.now() > deadline) {
			throw new Error(`Zerops namespace proxy deploy ${appVersionId} timed out`)
		}
		await (options.sleep ?? defaultSleep)(POLL_INTERVAL_MS, signal)
	}
}

const deployProxy = async (
	input: ProviderNamespaceMutationInput,
	namespace: ProviderDeploymentNamespace,
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
): Promise<{ namespace: ProviderDeploymentNamespace; target: NormalizedZeropsNamespaceTarget }> => {
	let currentNamespace = namespace
	let currentTarget = target
	const proxyServiceId = currentTarget.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	if (currentTarget.proxyAppVersionId !== undefined) {
		const version = await waitForProxy(currentTarget.proxyAppVersionId, options, input.signal)
		if (version.status === ZEROPS_ACTIVE) {
			return { namespace: currentNamespace, target: currentTarget }
		}
		currentTarget = {
			...currentTarget,
			proxyAppVersionId: undefined,
			proxyBaselineSequence: undefined,
			ready: false,
		}
		currentNamespace = await checkpoint(input, currentNamespace, currentTarget)
	}

	let recovered: ZeropsAppVersion | null = null
	if (currentTarget.proxyBaselineSequence !== undefined) {
		recovered = await latestAfterBaseline(currentTarget, options, input.signal)
	}
	if (recovered === null) {
		if (currentTarget.proxyBaselineSequence === undefined) {
			const prior = await options.api.latestAppVersion({ serviceId: proxyServiceId, signal: input.signal })
			currentTarget = {
				...currentTarget,
				proxyBaselineSequence: prior?.sequence ?? -1,
			}
			currentNamespace = await checkpoint(input, currentNamespace, currentTarget)
		}
		const process = await options.api.triggerPipeline({
			serviceId: proxyServiceId,
			buildFromGit: currentTarget.proxyBuildFromGit,
			zeropsSetup: ZEROPS_NAMESPACE_PROXY_HOSTNAME,
			signal: input.signal,
		})
		recovered = process?.appVersionId === undefined
			? await latestAfterBaseline(currentTarget, options, input.signal)
			: { id: process.appVersionId }
	}
	if (recovered === null || recovered.id === '') {
		throw new Error('Zerops namespace proxy pipeline did not expose a new app-version')
	}
	currentTarget = { ...currentTarget, proxyAppVersionId: recovered.id }
	currentNamespace = await checkpoint(input, currentNamespace, currentTarget)
	const version = await waitForProxy(recovered.id, options, input.signal)
	if (version.status !== ZEROPS_ACTIVE) {
		throw terminalFailure(version)
	}
	return { namespace: currentNamespace, target: currentTarget }
}

/**
 * Publish the proxy on its `*.zerops.app` subdomain — the ONE thing the import document cannot do.
 *
 * `enableSubdomainAccess: true` is accepted by the import and then silently dropped, on a service the
 * document CREATES as much as on one `override` leaves alone; a service imported with it reads back
 * `subdomainAccess: false` for ever. The subdomain is established by
 * `PUT /service-stack/{id}/enable-subdomain-access` and by nothing else, and that call needs a DEPLOYED
 * HTTP port — which is why this runs after `deployProxy` rather than beside the import.
 *
 * It runs on RECONCILE too, so a subdomain someone turned off in the GUI comes back. What it must never
 * do is finish quietly: `zerops-subdomain` is the only public entry a namespace has, so this either
 * observes `subdomainAccess === true` or throws naming what is missing.
 *
 * The decision is the READ-BACK, never the call returning. On an already-published service the platform
 * answers 2xx and then fails the process it handed back — live-verified — so a 2xx proves nothing.
 */
const ensureSubdomainAccess = async (
	target: NormalizedZeropsNamespaceTarget,
	options: ZeropsNamespaceOptions,
	signal: AbortSignal,
): Promise<void> => {
	const proxyServiceId = target.proxyServiceId
	if (proxyServiceId === undefined) {
		throw new Error('Zerops namespace has no proxy service id')
	}
	const published = async (): Promise<boolean> => (await options.api.getService({ serviceId: proxyServiceId, signal })).subdomainAccess === true
	if (await published()) {
		return
	}
	try {
		await options.api.enableSubdomainAccess({ serviceId: proxyServiceId, signal })
	} catch (error) {
		if (error instanceof ZeropsApiError && error.code === ZEROPS_SERVICE_NOT_HTTP) {
			throw new Error(
				`Zerops namespace proxy ${proxyServiceId} cannot be published on a zerops.app subdomain: it exposes no deployed HTTP port (${ZEROPS_SERVICE_NOT_HTTP})`,
			)
		}
		throw error
	}
	for (let attempt = 0;; attempt += 1) {
		if (signal.aborted) {
			throw new Error('Zerops namespace provisioning was cancelled')
		}
		if (await published()) {
			return
		}
		if (attempt >= SUBDOMAIN_READBACK_ATTEMPTS) {
			throw new Error(
				`Zerops namespace proxy ${proxyServiceId} accepted enable-subdomain-access but still reads subdomainAccess: false — the namespace has no public entry point`,
			)
		}
		await (options.sleep ?? defaultSleep)(POLL_INTERVAL_MS, signal)
	}
}

const mutateNamespace = async (
	input: ProviderNamespaceMutationInput,
	options: ZeropsNamespaceOptions,
	mode: 'provision' | 'reconcile',
): Promise<ProviderDeploymentNamespace> => {
	const suppliedTarget = decodeEnvelope(input.namespace.target)
	let namespace = normalizedNamespace(input.namespace, options)
	let target = normalizeTarget(namespace, options)
	const initiallyAdopted = target.projectId !== undefined && target.managed === false && !target.ready
	const topology = compileZeropsNamespaceTopology(namespace, target)

	if (target.projectId === undefined) {
		const recovered = await managedProjectByMarker(namespace, target, options, input.signal)
		const result = recovered === null
			? await options.api.importProject({ clientId: options.clientId, yaml: topology.createYaml, signal: input.signal })
			: { projectId: recovered.id, projectName: recovered.name, services: [] }
		if (result.projectId === '') {
			throw new Error('Zerops namespace project import returned an empty project id')
		}
		target = { ...target, projectId: result.projectId, managed: true }
		namespace = await checkpoint(input, namespace, target)
	}

	const projectId = target.projectId
	if (projectId === undefined) {
		throw new Error('Zerops namespace project id was not checkpointed')
	}
	const project = await options.api.getProject({ projectId, signal: input.signal })
	if (target.projectName !== project.name && initiallyAdopted && suppliedTarget.projectName === undefined) {
		target = { ...target, projectName: project.name }
		namespace = await checkpoint(input, namespace, target)
	}
	validateProject(namespace, target, project, initiallyAdopted)

	if (initiallyAdopted) {
		// Validate before the first mutation; the import below then enforces service-level envIsolation.
		await resolveServices(namespace, target, options, input.signal, true)
	}
	await options.api.importServices({
		projectId,
		yaml: mode === 'provision' && !target.ready ? topology.servicesProvisionYaml : topology.servicesSteadyYaml,
		signal: input.signal,
	})
	const resolved = await resolveServices(namespace, target, options, input.signal, false)
	target = {
		...target,
		proxyServiceId: resolved.proxy.id,
		...(resolved.postgres !== undefined ? { postgresServiceId: resolved.postgres.id } : {}),
	}
	namespace = await checkpoint(input, namespace, target)

	const deployRequired = await ensureProxyConfiguration(target, options, input.signal)
	target = { ...target, proxyConfigured: true }
	namespace = await checkpoint(input, namespace, target)

	if (deployRequired || !target.ready) {
		const deployed = await deployProxy(input, namespace, target, options)
		namespace = deployed.namespace
		target = deployed.target
	}
	// After the deploy, because the platform refuses a service with no HTTP port — and never before `ready`
	// is checkpointed, because a namespace with no public entry point is not ready.
	if (target.publicAccess === 'zerops-subdomain') {
		await ensureSubdomainAccess(target, options, input.signal)
	}
	target = {
		...target,
		proxyBaselineSequence: undefined,
		proxyAppVersionId: undefined,
		ready: true,
	}
	return checkpoint(input, namespace, target)
}

/** Build the provider-owned namespace lifecycle capability. */
export const createZeropsNamespaceCapabilities = (options: ZeropsNamespaceOptions): ProviderNamespaceCapabilities => {
	const required = (name: string, value: string): void => {
		if (value.trim() === '') {
			throw new Error(`Zerops namespace ${name} must be a non-empty string`)
		}
	}
	required('clientId', options.clientId)
	required('proxyBuildFromGit', options.proxyBuildFromGit)
	required('iamUrl', options.iamUrl)
	required('iamKey', options.iamKey)
	return {
		normalize: (namespace) => normalizedNamespace(namespace, options),
		namespaceResourceClaims,
		registrationResourceClaims,
		provision: (input) => mutateNamespace(input, options, 'provision'),
		reconcile: (input) => mutateNamespace(input, options, 'reconcile'),
		operator: createZeropsNamespaceOperator({ proxyBuildFromGit: options.proxyBuildFromGit }),
	}
}
