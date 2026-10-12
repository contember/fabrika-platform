import {
	APP_ENVIRONMENT_SEPARATOR,
	type Caller,
	compileEndpointTable,
	type ContractArtifact,
	contractDigest,
	type CredentialedEndpoint,
	type EndpointDelegation,
	endpointDelegation,
	type EndpointRow,
	EndpointTableError,
	type InstallationEndpointRow,
	type InstallationEndpointTable,
	isDigest,
	parseAppEnvironmentId,
	requirementDigest,
} from '@fabrika/auth-core'
import { z } from 'zod'
import { type CspOrigins, cspOrigins, isPolicyOrigin, MAX_CSP_ORIGINS } from './headers'
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
}

/**
 * An installation service protected by an endpoint table (ADR-0022 "Installation entries"). Only trusted platform
 * composition writes `installation: true`; its rows may use the forms no application may declare, and its hop keeps
 * `Authorization`, sets no proxy secret and leaves the service's answers untouched.
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
	| (Pick<CredentialedEndpoint, 'id' | 'kind' | 'method' | 'path' | 'callers' | 'requirement' | 'admission'> & ProxyEndpointExtras)
	| (Pick<Extract<EndpointRow, { requirement: null }>, 'id' | 'kind' | 'method' | 'path' | 'callers' | 'requirement' | 'admission'> & {
		digest: string
		delegation: null
	})

/** An installation row as the proxy applies it: the row with its digest and no delegation. */
export type InstallationProxyEndpointRow = InstallationEndpointRow & { digest: string; delegation: null }

/** Any row an endpoint table of the manifest holds. */
export type ManifestEndpointRow = ProxyEndpointRow | InstallationProxyEndpointRow

export interface ProxyManifest {
	apps: ProxyApp[]
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
])
const requirementSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('member') }).strict(),
	z.object({ kind: z.literal('action'), action: nameSchema, access: accessFormSchema }).strict(),
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
	}).strict(),
	z.object({
		...endpointRuleFields,
		kind: z.enum(['health', 'form', 'webhook', 'link-spa']),
		callers: z.tuple([]),
		requirement: z.null(),
		delegation: z.null(),
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
]).refine((row) => row.digest === requirementDigest(row), 'endpoint digest does not match its rules') satisfies z.ZodType<
	ProxyEndpointRow,
	z.ZodTypeDef,
	unknown
>

const cspOriginSchema = z.string().refine((value) => isPolicyOrigin(value))
const cspDirectiveSchema = z.array(cspOriginSchema).max(MAX_CSP_ORIGINS)
const cspOriginsSchema = z.object({
	connectSrc: cspDirectiveSchema,
	imgSrc: cspDirectiveSchema,
	frameAncestors: cspDirectiveSchema,
	// A manifest written before these two directives existed names neither.
	scriptSrc: cspDirectiveSchema.default([]),
	frameSrc: cspDirectiveSchema.default([]),
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
}).strict().superRefine((app, ctx) => {
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
 */
export function contractProxyTable(artifact: ContractArtifact): ContractProxyTable {
	return {
		endpoints: artifact.endpoints.map((row): ProxyEndpointRow => {
			const rules = { id: row.id, method: row.method, path: row.path, admission: row.admission }
			if (row.requirement === null) {
				const anonymous = { ...rules, kind: row.kind, callers: row.callers, requirement: null, delegation: null }
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
		snapshot: contractDigest(artifact),
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
