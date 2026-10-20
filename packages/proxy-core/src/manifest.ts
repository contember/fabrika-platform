import {
	ANY_ORIGIN_KINDS,
	APP_ENVIRONMENT_SEPARATOR,
	type Caller,
	compileEndpointTable,
	type ContractArtifact,
	contractDigest,
	type CredentialedEndpoint,
	CROSS_ORIGIN_KINDS,
	type CrossOriginForm,
	type EndpointDelegation,
	endpointDelegation,
	type EndpointRow,
	EndpointTableError,
	FILE_RESPONSE_KINDS,
	type InstallationEndpointRow,
	type InstallationEndpointTable,
	isDigest,
	MAX_CACHE_AGE_SECONDS,
	parseAppEnvironmentId,
	requirementDigest,
} from '@fabrika/auth-core'
import { z } from 'zod'
import { type InstallationBrand, installationBrandSchema } from './brand'
import { type CspOrigins, cspOrigins, isCrossOrigin, isPolicyOrigin, MAX_CROSS_ORIGINS, MAX_CSP_ORIGINS, WORKER_BLOB_SOURCE } from './headers'
import { type OAuthProtectedResource, oauthProtectedResourceSchema, oauthScopesSchema } from './oauth-resource'

export * from './oauth-resource'

export const FABRIKA_PROXY_MANIFEST_JSON = 'FABRIKA_PROXY_MANIFEST_JSON'

interface ProxyAppBase {
	/** The IAM app id, used as the minted token audience: `<app>@<env>` for an application, a plain id for a platform service. */
	id: string
	/** Literal hostnames, lower-cased on parse; never patterns or host:port pairs. */
	hosts: string[]
	/** Private upstream dial address, for example `app:3000`. */
	upstream: string
	/** Browser-facing scheme used for login and handoff URLs, defaulting to https. */
	scheme: 'http' | 'https'
}

/** A contract application: its endpoint table, from which the proxy selects one endpoint per request (ADR-0022 rule 3). */
export interface ContractProxyApp extends ProxyAppBase {
	/** Array order carries no meaning; `planEndpoint` selects the most specific row. */
	endpoints: ProxyEndpointRow[]
	/** Literal prefixes reserved for procedures; a path under one reaches only an endpoint declared under it. */
	reservedPrefixes: string[]
	/** The digest of the contract the table was compiled from (`contractDigest`). */
	snapshot: string
	/** The contract's named CSP origins, which the proxy's header policy adds to their directives. */
	csp: CspOrigins
	/** The installation's Operations ingest origin, admitted by `connect-src`; absent when the producer knows none. */
	operationsOrigin?: string
	/**
	 * The origins the environment lists for its `crossOrigin: 'environment'` endpoints (ADR-0022 "Cross-origin
	 * endpoints"), from Control's registry, never from the contract; absent when it lists none.
	 */
	crossOrigins?: string[]
}

/**
 * An installation service protected by an endpoint table (ADR-0022 "Installation entries"). Only trusted platform
 * composition writes `installation: true`; its rows may use the forms no application may declare, and its hop keeps
 * `Authorization`, sets no proxy secret (IAM's session-owner route excepted, for attribution only) and leaves the
 * service's answers untouched.
 */
export interface InstallationProxyApp extends ProxyAppBase {
	installation: true
	/** Array order carries no meaning; `planEndpoint` selects the most specific row. */
	endpoints: InstallationProxyEndpointRow[]
	reservedPrefixes: string[]
	/** The resources a row that admits `oauth` is bound to, by the resource URI's path. */
	oauthResources?: OAuthProtectedResource[]
}

/** What a producer adds to a contract app's placement: the output of `contractProxyTable`. */
export type ContractProxyTable = Pick<ContractProxyApp, 'endpoints' | 'reservedPrefixes' | 'snapshot' | 'csp'>

/** Every entry is protected by an endpoint table: an application's, or an installation service's. */
export type ProxyApp = ContractProxyApp | InstallationProxyApp

/**
 * Whether an entry is an application: its hop carries the proxy secret, its answers get the header policy, and an
 * anonymous endpoint's request loses `Authorization`. Every other entry is an installation service.
 */
export function isApplicationEntry(app: ProxyApp): app is ContractProxyApp {
	return 'endpoints' in app && !('installation' in app)
}

interface ProxyEndpointExtras {
	/** `requirementDigest` of the row's rules and delegation; the proxy sends it as `X-Fabrika-Endpoint: <id>@<digest>`. */
	digest: string
	delegation: EndpointDelegation | null
}

/** An endpoint row as the proxy applies it: the rules without the schemas, plus the digest and the delegation. */
export type ProxyEndpointRow =
	| (
		& Pick<CredentialedEndpoint, 'id' | 'kind' | 'method' | 'path' | 'callers' | 'requirement' | 'admission' | 'crossOrigin' | 'response'>
		& ProxyEndpointExtras
	)
	| (
		& Pick<
			Extract<EndpointRow, { requirement: null }>,
			'id' | 'kind' | 'method' | 'path' | 'callers' | 'requirement' | 'admission' | 'crossOrigin' | 'response' | 'cache' | 'authorization'
		>
		& {
			digest: string
			delegation: null
		}
	)

/** An installation row as the proxy applies it: the row with its digest and no delegation. */
export type InstallationProxyEndpointRow = InstallationEndpointRow & { digest: string; delegation: null }

/** Any row an endpoint table of the manifest holds. */
export type ManifestEndpointRow = ProxyEndpointRow | InstallationProxyEndpointRow

export interface ProxyManifest {
	apps: ProxyApp[]
	/**
	 * The installation's client logo for the pages the proxy answers with (ADR-0065). Absent, a page draws the fabrika
	 * mark. A producer sends it only to a proxy whose source parses it: an older parser refuses the key.
	 */
	brand?: InstallationBrand
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Literal LDH hostnames only: Caddy reads wildcard labels and placeholders as routing patterns. */
export function isProxyHost(host: string): boolean {
	return host.length > 0 && host.length <= 253 && host.split('.').every((label) => label.length <= 63 && HOST_LABEL.test(label))
}

/** An id that holds `@` must be a whole `<app>@<env>`; a malformed one would mint for an app IAM never registered. */
const proxyAppIdSchema = z.string().min(1).refine((id) => !id.includes(APP_ENVIRONMENT_SEPARATOR) || parseAppEnvironmentId(id) !== null)

const proxyAppScheme = z.preprocess((value) => typeof value === 'string' ? value : undefined, z.enum(['http', 'https']).default('https'))
const proxyAppFields = {
	id: proxyAppIdSchema,
	hosts: z.array(z.string().toLowerCase().refine(isProxyHost)).min(1),
	upstream: z.string().min(1),
}

/** Each resource once, on one of the entry's own hosts and its scheme. */
function checkOAuthResources(app: Pick<InstallationProxyApp, 'hosts' | 'scheme' | 'oauthResources'>, ctx: z.RefinementCtx): void {
	const resources = new Set<string>()
	const metadata = new Set<string>()
	for (const resource of app.oauthResources ?? []) {
		const url = new URL(resource.resource)
		if (
			resources.has(resource.resource) || metadata.has(resource.resourceMetadata) || !app.hosts.includes(url.hostname)
			|| url.protocol !== `${app.scheme}:`
		) {
			ctx.addIssue({ code: 'custom', message: 'invalid OAuth resource binding' })
		}
		resources.add(resource.resource)
		metadata.add(resource.resourceMetadata)
	}
}

const nameSchema = z.string().min(1)
const callerSchema = z.custom<Caller>((value) =>
	value === 'human' || value === 'machine' || value === 'link' || (typeof value === 'string' && /^app:[^\s@]+$/.test(value))
)
const accessFormSchema = z.discriminatedUnion('form', [
	z.object({ form: z.literal('over'), dimension: nameSchema }).strict(),
	z.object({ form: z.literal('in'), dimension: nameSchema, from: nameSchema }).strict(),
	z.object({ form: z.literal('on'), dimension: nameSchema, from: nameSchema.nullable() }).strict(),
	z.object({ form: z.literal('creates'), dimension: nameSchema }).strict(),
	z.object({ form: z.literal('app') }).strict(),
])
const capabilityFormSchema = z.discriminatedUnion('form', [
	z.object({ form: z.literal('over'), dimension: nameSchema }).strict(),
	z.object({ form: z.literal('in'), dimension: nameSchema, from: nameSchema }).strict(),
	z.object({ form: z.literal('on'), dimension: nameSchema, from: nameSchema }).strict(),
])
const capabilitySchema = z.object({ action: nameSchema, access: capabilityFormSchema }).strict()
const requirementSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('member') }).strict(),
	z.object({ kind: z.literal('action'), action: nameSchema, access: accessFormSchema }).strict(),
	z.object({
		kind: z.literal('capabilities'),
		capabilities: z.record(nameSchema, capabilitySchema).refine((capabilities) => Object.keys(capabilities).length >= 2, 'at least two capabilities'),
	}).strict(),
])
const admissionSchema = z.object({
	contentTypes: z.array(nameSchema).nonempty(),
	maxBytes: z.number().int().positive().nullable(),
}).strict()
const endpointRuleFields = {
	id: nameSchema,
	method: z.enum(['GET', 'POST']),
	path: z.string().startsWith('/'),
	admission: admissionSchema.nullable(),
	digest: z.string().refine(isDigest),
}
/** One row of a contract app's endpoint table; it refuses a digest that does not describe the row's rules. */
export const proxyEndpointRowSchema = z.union([
	z.object({
		...endpointRuleFields,
		kind: z.enum(['query', 'mutation', 'spa', 'upload', 'download']),
		callers: z.array(callerSchema).nonempty(),
		requirement: requirementSchema,
		delegation: z.enum(['members', 'creates']).nullable(),
		crossOrigin: z.literal('environment').optional(),
		response: z.literal('file').optional(),
	}).strict(),
	z.object({
		...endpointRuleFields,
		kind: z.enum(['health', 'form', 'webhook', 'link-spa', 'public']),
		callers: z.tuple([]),
		requirement: z.null(),
		delegation: z.null(),
		crossOrigin: z.enum(['environment', 'any']).optional(),
		response: z.literal('file').optional(),
		cache: z.union([z.literal('immutable'), z.object({ maxAgeSeconds: z.number().int().min(1).max(MAX_CACHE_AGE_SECONDS) }).strict()]).optional(),
		authorization: z.literal('forward').optional(),
	}).strict(),
	// A public SPA is a fixed static row: it serves GET only and admits no body.
	z.object({
		...endpointRuleFields,
		kind: z.literal('public-spa'),
		method: z.literal('GET'),
		admission: z.null(),
		callers: z.tuple([]),
		requirement: z.null(),
		delegation: z.null(),
	}).strict(),
]).refine(
	(row) => crossOriginAllowed(row.kind, 'crossOrigin' in row ? row.crossOrigin : undefined),
	'this endpoint kind cannot be called cross-origin',
).refine(
	(row) => !('response' in row) || row.response === undefined || FILE_RESPONSE_KINDS.includes(row.kind),
	'only a procedure answers a stored file',
).refine(
	(row) => !('cache' in row) || row.cache === undefined || (row.kind === 'public' && row.method === 'GET'),
	'only a public GET query caches its answer',
).refine(
	(row) => !('authorization' in row) || row.authorization === undefined || row.kind === 'webhook',
	"only a webhook forwards the request's Authorization",
).refine(
	(row) => row.digest === requirementDigest(row),
	'endpoint digest does not match its rules',
) satisfies z.ZodType<
	ProxyEndpointRow,
	z.ZodTypeDef,
	unknown
>

/** Only an RPC procedure, a public procedure and a form open to another origin, and only the anonymous two to any (ADR-0022). */
function crossOriginAllowed(kind: ProxyEndpointRow['kind'], form: CrossOriginForm | undefined): boolean {
	return form === undefined || (CROSS_ORIGIN_KINDS.includes(kind) && (form !== 'any' || ANY_ORIGIN_KINDS.includes(kind)))
}

/** Exact origins, each once, never one of the entry's own hosts: its own pages are not cross-origin. */
function checkCrossOrigins(app: Pick<ContractProxyApp, 'hosts' | 'crossOrigins'>, ctx: z.RefinementCtx): void {
	const origins = app.crossOrigins ?? []
	// A refinement runs over an origin its element check already refused, so the host is read without throwing.
	if (new Set(origins).size !== origins.length || origins.some((origin) => !isCrossOrigin(origin) || app.hosts.includes(new URL(origin).hostname))) {
		ctx.addIssue({ code: 'custom', message: 'invalid cross-origin list' })
	}
}

const cspOriginSchema = z.string().refine((value) => isPolicyOrigin(value))
const cspDirectiveSchema = z.array(cspOriginSchema).max(MAX_CSP_ORIGINS)
const cspOriginsSchema = z.object({
	connectSrc: cspDirectiveSchema,
	imgSrc: cspDirectiveSchema,
	frameAncestors: cspDirectiveSchema,
	// A manifest written before these four directives existed names none of them.
	scriptSrc: cspDirectiveSchema.default([]),
	frameSrc: cspDirectiveSchema.default([]),
	styleSrc: cspDirectiveSchema.default([]),
	fontSrc: cspDirectiveSchema.default([]),
	// Only a challenge widget's workers need it, and its one source is `blob:`; absent everywhere else.
	workerSrc: z.tuple([z.literal(WORKER_BLOB_SOURCE)]).optional(),
}).strict() satisfies z.ZodType<CspOrigins, z.ZodTypeDef, unknown>

// Strict: a key the proxy does not read (`gates`, or an installation entry's field) is refused, never ignored.
export const contractProxyAppSchema = z.object({
	...proxyAppFields,
	scheme: proxyAppScheme,
	endpoints: z.array(proxyEndpointRowSchema),
	reservedPrefixes: z.array(z.string()),
	snapshot: z.string().refine(isDigest),
	csp: cspOriginsSchema,
	operationsOrigin: z.string().refine((value) => isPolicyOrigin(value, ['https:', 'http:'])).optional(),
	crossOrigins: z.array(z.string().refine(isCrossOrigin)).nonempty().max(MAX_CROSS_ORIGINS).optional(),
}).strict().superRefine((app, ctx) => {
	checkCrossOrigins(app, ctx)
	checkEndpointTable(app, ctx)
}) satisfies z.ZodType<ContractProxyApp, z.ZodTypeDef, unknown>

function checkEndpointTable(app: Pick<ContractProxyApp | InstallationProxyApp, 'endpoints' | 'reservedPrefixes'>, ctx: z.RefinementCtx): void {
	try {
		compileEndpointTable<ManifestEndpointRow>(app)
	} catch (error) {
		if (!(error instanceof EndpointTableError)) throw error
		ctx.addIssue({ code: 'custom', message: 'ambiguous or invalid endpoint table' })
	}
}

const installationRuleFields = {
	id: nameSchema,
	method: z.enum(['GET', 'POST', '*']),
	path: z.string().startsWith('/'),
	admission: admissionSchema.nullable(),
	delegation: z.null(),
	digest: z.string().refine(isDigest),
}
/** One row of an installation entry: the installation forms, and no application form but `health`. */
export const installationProxyEndpointRowSchema = z.union([
	z.object({
		...installationRuleFields,
		kind: z.literal('service'),
		callers: z.array(z.enum(['human', 'machine', 'oauth'])).nonempty(),
		requirement: z.object({ kind: z.literal('authenticated') }).strict(),
		oauth: z.object({ scopes: oauthScopesSchema }).strict().nullable(),
	}).strict().refine((row) => row.callers.includes('oauth') === (row.oauth !== null), 'oauth scopes belong to a row that admits oauth'),
	z.object({
		...installationRuleFields,
		kind: z.enum(['protocol', 'health']),
		callers: z.tuple([]),
		requirement: z.null(),
		oauth: z.null(),
	}).strict(),
]).refine((row) => row.digest === requirementDigest(row), 'endpoint digest does not match its rules') satisfies z.ZodType<
	InstallationProxyEndpointRow,
	z.ZodTypeDef,
	unknown
>

/** The registered resource a row that admits `oauth` is bound to: the one whose URI path is the row's path. */
export function oauthResourceOfRow(
	app: Pick<InstallationProxyApp, 'oauthResources'>,
	row: Pick<InstallationProxyEndpointRow, 'path'>,
): OAuthProtectedResource | null {
	return app.oauthResources?.find((resource) => new URL(resource.resource).pathname === row.path) ?? null
}

/**
 * An installation entry. Only platform composition writes the marker; the parser refuses one whose id holds `@`,
 * that carries what only an application has, or whose `oauth` row is bound to no registered resource.
 */
export const installationProxyAppSchema = z.object({
	...proxyAppFields,
	scheme: proxyAppScheme,
	installation: z.literal(true),
	endpoints: z.array(installationProxyEndpointRowSchema),
	reservedPrefixes: z.array(z.string()),
	oauthResources: z.array(oauthProtectedResourceSchema).min(1).optional(),
}).strict().superRefine((app, ctx) => {
	if (app.id.includes(APP_ENVIRONMENT_SEPARATOR)) {
		ctx.addIssue({ code: 'custom', message: 'an installation entry is no application environment' })
	}
	checkOAuthResources(app, ctx)
	const paths = (app.oauthResources ?? []).map((resource) => new URL(resource.resource).pathname)
	if (new Set(paths).size !== paths.length) {
		ctx.addIssue({ code: 'custom', message: 'two OAuth resources on one path' })
	}
	for (const row of app.endpoints) {
		if (row.oauth === null) continue
		const resource = oauthResourceOfRow(app, row)
		if (resource === null || !row.oauth.scopes.every((scope) => resource.scopesSupported.includes(scope))) {
			ctx.addIssue({ code: 'custom', message: 'unregistered OAuth row' })
		}
	}
	checkEndpointTable(app, ctx)
}) satisfies z.ZodType<InstallationProxyApp, z.ZodTypeDef, unknown>

export const proxyAppSchema = z.union([contractProxyAppSchema, installationProxyAppSchema]) satisfies z.ZodType<
	ProxyApp,
	z.ZodTypeDef,
	unknown
>

/**
 * The manifest form of a compiled contract: every endpoint's rules with their digest and delegation, the reserved
 * prefixes, the contract digest and the named CSP origins. Producers call this; they never assemble rows by hand.
 * `digest` is the one the application's own release computes; Control passes it for an artifact it upcast from an
 * older release's (ADR-0062).
 */
export function contractProxyTable(artifact: ContractArtifact, digest: string = contractDigest(artifact)): ContractProxyTable {
	return {
		endpoints: artifact.endpoints.map((row): ProxyEndpointRow => {
			const rules = {
				id: row.id,
				method: row.method,
				path: row.path,
				admission: row.admission,
				...(row.crossOrigin === undefined ? {} : { crossOrigin: row.crossOrigin }),
				...(row.response === undefined ? {} : { response: row.response }),
			}
			if (row.requirement === null) {
				const cache = row.cache === undefined ? {} : { cache: row.cache }
				const authorization = row.authorization === undefined ? {} : { authorization: row.authorization }
				const anonymous = { ...rules, ...cache, ...authorization, kind: row.kind, callers: row.callers, requirement: null, delegation: null }
				return { ...anonymous, digest: requirementDigest(anonymous) }
			}
			const credentialed = {
				...rules,
				kind: row.kind,
				callers: row.callers,
				requirement: row.requirement,
				delegation: endpointDelegation(artifact, row),
			}
			return { ...credentialed, digest: requirementDigest(credentialed) }
		}),
		reservedPrefixes: [...artifact.reservedPrefixes],
		snapshot: digest,
		csp: cspOrigins(artifact.csp),
	}
}

/** What a producer adds to an installation service's placement: the output of `serviceProxyTable`. */
export type InstallationProxyTable = Pick<InstallationProxyApp, 'installation' | 'endpoints' | 'reservedPrefixes'>

/**
 * The manifest form of a service contract: every row with its digest. Without an authorization server (`oauth:
 * false`) every row that admits `oauth` is dropped, because the parser refuses such a row without its registered
 * resource; the service must then serve the same table, or the dropped path answers 503 there.
 */
export function serviceProxyTable(service: InstallationEndpointTable, options: { readonly oauth: boolean }): InstallationProxyTable {
	return {
		installation: true,
		endpoints: service.endpoints
			.filter((row) => options.oauth || row.oauth === null)
			.map((row): InstallationProxyEndpointRow => {
				const rules = { ...row, delegation: null }
				return { ...rules, digest: requirementDigest(rules) }
			}),
		reservedPrefixes: [...service.reservedPrefixes],
	}
}

/** The first host two apps (or one app twice) claim, or null. A host belongs to exactly one app. */
export function findDuplicateProxyHost(apps: readonly Pick<ProxyApp, 'hosts'>[]): string | null {
	const hosts = new Set<string>()
	for (const host of apps.flatMap((app) => app.hosts)) {
		if (hosts.has(host)) return host
		hosts.add(host)
	}
	return null
}

export const proxyManifestSchema = z.object({
	apps: z.array(proxyAppSchema),
	brand: installationBrandSchema.optional(),
}).strict().superRefine(({ apps }, ctx) => {
	if (new Set(apps.map((app) => app.id)).size !== apps.length) ctx.addIssue({ code: 'custom', message: 'duplicate proxy app id' })
	if (findDuplicateProxyHost(apps) !== null) ctx.addIssue({ code: 'custom', message: 'duplicate proxy host' })
}) satisfies z.ZodType<ProxyManifest, z.ZodTypeDef, unknown>

export function parseProxyManifest(value: unknown): ProxyManifest | null {
	const result = proxyManifestSchema.safeParse(value)
	return result.success ? result.data : null
}

export function parseProxyManifestJson(value: string): ProxyManifest | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		return null
	}
	return parseProxyManifest(parsed)
}

export function encodeProxyManifestJson(manifest: ProxyManifest): string {
	return JSON.stringify(manifest)
}
