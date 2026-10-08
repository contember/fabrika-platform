import {
	APP_ENVIRONMENT_SEPARATOR,
	type AppGates,
	type Caller,
	compileEndpointTable,
	type ContractArtifact,
	contractDigest,
	type CredentialedEndpoint,
	type CredentialLocation,
	type EndpointRow,
	EndpointTableError,
	type GateRule,
	isDigest,
	isOAuthResourceUri,
	parseAppEnvironmentId,
	requirementDigest,
} from '@fabrika/auth-core'
import { z } from 'zod'
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

/** An installation service (IAM, Control, Operations): ordered gate rules. */
export interface GateProxyApp extends ProxyAppBase {
	/** Ordered rules; evaluated only by auth-core in the proxy. */
	gates: AppGates
	oauthResources?: OAuthProtectedResource[]
}

/** A contract application: its endpoint table, from which the proxy selects one endpoint per request (ADR-0022 rule 3). */
export interface ContractProxyApp extends ProxyAppBase {
	/** Array order carries no meaning; `planEndpoint` selects the most specific row. */
	endpoints: ProxyEndpointRow[]
	/** Literal prefixes reserved for procedures; a path under one reaches only an endpoint declared under it. */
	reservedPrefixes: string[]
	/** The digest of the contract the table was compiled from (`contractDigest`). */
	snapshot: string
}

/** The manifest says which form an app is protected by: `endpoints` instead of `gates`. */
export type ProxyApp = GateProxyApp | ContractProxyApp

export function isContractProxyApp(app: ProxyApp): app is ContractProxyApp {
	return 'endpoints' in app
}

/**
 * What a membership or scope-creating endpoint spends at IAM, through the single-use grant the proxy obtains for each
 * request (ADR-0022 rule 6). `null` for every other endpoint.
 */
export type EndpointDelegation = 'members' | 'creates'

interface ProxyEndpointExtras {
	/** `requirementDigest` of the row's rules; the proxy sends it as `X-Fabrika-Endpoint: <id>@<digest>`. */
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

export interface ProxyManifest {
	apps: ProxyApp[]
}

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Literal LDH hostnames only: Caddy reads wildcard labels and placeholders as routing patterns. */
export function isProxyHost(host: string): boolean {
	return host.length > 0 && host.length <= 253 && host.split('.').every((label) => label.length <= 63 && HOST_LABEL.test(label))
}

export const proxyCredentialLocationSchema = z.object({
	in: z.enum(['header', 'query', 'cookie']),
	name: z.string().min(1),
}) satisfies z.ZodType<CredentialLocation, z.ZodTypeDef, unknown>

const gatePathSchema = z.string().startsWith('/')
/** A gate rule's fields before normalization; a producer adds its own refinements on top. */
export const proxyGateRuleFieldsSchema = z.discriminatedUnion('kind', [
	z.object({ path: gatePathSchema, kind: z.literal('public') }),
	z.object({ path: gatePathSchema, kind: z.literal('human') }),
	z.object({ path: gatePathSchema, kind: z.literal('service'), credential: proxyCredentialLocationSchema.nullish() }),
	z.object({ path: gatePathSchema, kind: z.literal('oauth'), resource: z.string().refine(isOAuthResourceUri), scopes: oauthScopesSchema }),
])

/** Drop an absent service credential, so a rule without one carries no `credential` key at all. */
export const normalizeGateRule = (rule: z.infer<typeof proxyGateRuleFieldsSchema>): GateRule => {
	if (rule.kind !== 'service') return rule
	return { path: rule.path, kind: rule.kind, ...(rule.credential == null ? {} : { credential: rule.credential }) }
}

export const proxyGateRuleSchema = proxyGateRuleFieldsSchema.transform(normalizeGateRule) satisfies z.ZodType<GateRule, z.ZodTypeDef, unknown>

export const proxyAppGatesSchema = z.object({
	rules: z.array(proxyGateRuleSchema),
}) satisfies z.ZodType<AppGates, z.ZodTypeDef, unknown>

/** An id that holds `@` must be a whole `<app>@<env>`; a malformed one would mint for an app IAM never registered. */
const proxyAppIdSchema = z.string().min(1).refine((id) => !id.includes(APP_ENVIRONMENT_SEPARATOR) || parseAppEnvironmentId(id) !== null)

const proxyAppScheme = z.preprocess((value) => typeof value === 'string' ? value : undefined, z.enum(['http', 'https']).default('https'))
const proxyAppFields = {
	id: proxyAppIdSchema,
	hosts: z.array(z.string().toLowerCase().refine(isProxyHost)).min(1),
	upstream: z.string().min(1),
}

// An app carrying both forms is refused, never read as one of them: dropping a table would leave gates nobody approved.
export const gateProxyAppSchema = z.object({
	...proxyAppFields,
	gates: proxyAppGatesSchema,
	scheme: proxyAppScheme,
	oauthResources: z.array(oauthProtectedResourceSchema).min(1).optional(),
	endpoints: z.undefined(),
}).transform(({ endpoints: _endpoints, ...app }) => app).superRefine((app, ctx) => {
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
	for (const rule of app.gates.rules) {
		if (rule.kind !== 'oauth') continue
		const resource = app.oauthResources?.find((entry) => entry.resource === rule.resource)
		if (resource === undefined || !rule.scopes.every((scope) => resource.scopesSupported.includes(scope))) {
			ctx.addIssue({ code: 'custom', message: 'unregistered OAuth gate' })
		}
	}
}) satisfies z.ZodType<GateProxyApp, z.ZodTypeDef, unknown>

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
const proxyEndpointRowSchema = z.union([
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
]).refine((row) => row.digest === requirementDigest(row), 'endpoint digest does not match its rules') satisfies z.ZodType<
	ProxyEndpointRow,
	z.ZodTypeDef,
	unknown
>

export const contractProxyAppSchema = z.object({
	...proxyAppFields,
	scheme: proxyAppScheme,
	endpoints: z.array(proxyEndpointRowSchema),
	reservedPrefixes: z.array(z.string()),
	snapshot: z.string().refine(isDigest),
	gates: z.undefined(),
	oauthResources: z.undefined(),
}).transform(({ gates: _gates, oauthResources: _oauthResources, ...app }) => app).superRefine((app, ctx) => {
	try {
		compileEndpointTable(app)
	} catch (error) {
		if (!(error instanceof EndpointTableError)) throw error
		ctx.addIssue({ code: 'custom', message: 'ambiguous or invalid endpoint table' })
	}
}) satisfies z.ZodType<ContractProxyApp, z.ZodTypeDef, unknown>

export const proxyAppSchema = z.union([gateProxyAppSchema, contractProxyAppSchema]) satisfies z.ZodType<ProxyApp, z.ZodTypeDef, unknown>

/**
 * The manifest form of a compiled contract: every endpoint's rules with their digest and delegation, the reserved
 * prefixes, and the contract digest. Producers call this; they never assemble rows by hand.
 */
export function contractProxyTable(artifact: ContractArtifact): Pick<ContractProxyApp, 'endpoints' | 'reservedPrefixes' | 'snapshot'> {
	return {
		endpoints: artifact.endpoints.map((row): ProxyEndpointRow => {
			const rules = { id: row.id, method: row.method, path: row.path, admission: row.admission, digest: requirementDigest(row) }
			if (row.requirement === null) {
				return { ...rules, kind: row.kind, callers: row.callers, requirement: null, delegation: null }
			}
			return { ...rules, kind: row.kind, callers: row.callers, requirement: row.requirement, delegation: delegationOf(artifact, row) }
		}),
		reservedPrefixes: [...artifact.reservedPrefixes],
		snapshot: contractDigest(artifact),
	}
}

/** `creates` for an endpoint that creates a value; `members` for one whose action is its dimension's `members.manage`. */
function delegationOf(artifact: ContractArtifact, row: CredentialedEndpoint): EndpointDelegation | null {
	if (row.requirement.kind !== 'action') return null
	const { action, access } = row.requirement
	if (access.form === 'creates') return 'creates'
	return artifact.dimensions[access.dimension]?.members?.manage === action ? 'members' : null
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
}).superRefine(({ apps }, ctx) => {
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
