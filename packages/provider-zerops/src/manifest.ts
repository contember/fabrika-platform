import { appSchemaSchema } from '@fabrika/auth'
import type { AppSchema } from '@fabrika/auth-core'
import type { JsonValue, ProviderCodec } from '@fabrika/provider-contract'
import { normalizeGateRule, proxyGateRuleFieldsSchema } from '@fabrika/proxy-core/manifest'
import { z } from 'zod'
import { compileImport, ENV_ISOLATION, OVERRIDE, renderYaml } from './compile'
import { parseZeropsDescriptor, selectZeropsDescriptorSetup } from './descriptor'
import { assertAuthoredManagedDocument, assertAuthoredManagedInputs } from './managed-env'
import { allowedReferenceHosts, foreignReferenceHost } from './service-references'
import type { ZeropsAppConfig, ZeropsNamespaceResourceRequirement, ZeropsProxySpec, ZeropsSharedPostgresBinding } from './types'

export const FABRIKA_MANIFEST_VERSION = 3
export const ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES = 256 * 1024
export const ZEROPS_SERVICE_HOSTNAME_PATTERN = /^[a-z0-9]{1,25}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

/**
 * The one reference an app may declare for the namespace-owned PostgreSQL service.
 *
 * Restated here rather than imported from `./namespace` — that module imports THIS one, and the
 * literal is part of the manifest's parse contract, so it belongs on the parsing side. The reasoning
 * for the database path and the TLS mode lives with `ZEROPS_SHARED_POSTGRES_CONNECTION_STRING`; a test
 * asserts the two never diverge.
 */
const SHARED_POSTGRES_CONNECTION_STRING: ZeropsSharedPostgresBinding['connectionString'] =
	'${postgres_connectionTlsString}/${postgres_dbName}?sslmode=require'

export interface FabrikaImportDocument {
	readonly project?: { readonly [key: string]: JsonValue }
	readonly services: ReadonlyArray<{ readonly [key: string]: JsonValue }>
}

export interface ZeropsArtifactSourceDescriptor {
	readonly path: 'zerops.yaml'
	readonly contents: string
	readonly sha256: string
}

export interface FabrikaManifest {
	manifestVersion: typeof FABRIKA_MANIFEST_VERSION
	app: {
		id: string
		env: string
		schema?: AppSchema
		pipeline: {
			secrets: string[]
			vars: string[]
		}
	}
	target: {
		platform: 'zerops'
		/** The exact repository-root build descriptor used for this artifact. */
		sourceDescriptor: ZeropsArtifactSourceDescriptor
		/** The canonical document used both for resource claims and the Zerops API payload. */
		importDocument: FabrikaManifestImportDocument
		deployService: string
		zeropsSetup?: string
		proxy?: ZeropsProxySpec
		namespaceResources?: ZeropsNamespaceResourceRequirement[]
	}
}

export interface ManifestExpectation {
	appId?: string
	env?: string
}

export const assertFabrikaManifestCoordinates = (app: Pick<FabrikaManifest['app'], 'id' | 'env'>, expected: ManifestExpectation): void => {
	if (expected.appId !== undefined && expected.appId !== app.id) {
		throw new Error(`manifest app drift: expected \`${expected.appId}\`, got \`${app.id}\``)
	}
	if (expected.env !== undefined && expected.env !== app.env) {
		throw new Error(`manifest environment drift: expected \`${expected.env}\`, got \`${app.env}\``)
	}
}

const manifestJsonSchema: z.ZodType<JsonValue, z.ZodTypeDef, unknown> = z.lazy(() =>
	z.union([
		z.null(),
		z.string(),
		z.number(),
		z.nan(),
		z.boolean(),
		z.array(manifestJsonSchema),
		z.preprocess((value) =>
			typeof value === 'object' && value !== null && !Array.isArray(value)
				? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
				: value, z.record(manifestJsonSchema)),
	])
)
const jsonValue = (value: unknown): JsonValue => {
	const parsed = manifestJsonSchema.safeParse(value)
	if (!parsed.success) throw new Error('Fabrika manifest contains a non-JSON value')
	return parsed.data
}

const nonEmptyStringsSchema = z.array(z.string().min(1))
// Unlike the proxy wire contract, the manifest refuses a null service credential.
const manifestGateSchema = proxyGateRuleFieldsSchema
	.refine((rule) => rule.kind !== 'service' || rule.credential !== null)
	.transform(normalizeGateRule)
const manifestProxySchema = z.object({ upstream: z.string().min(1), gates: z.object({ rules: z.array(manifestGateSchema) }) })
const namespaceResourcesSchema = z.array(z.object({
	resourceKey: z.literal('service:postgres'),
	hostname: z.literal('postgres'),
	connectionString: z.literal(SHARED_POSTGRES_CONNECTION_STRING),
})).max(1)

const manifestAppSchema = z.object({
	id: z.string().min(1),
	env: z.string().min(1),
	schema: appSchemaSchema.optional(),
	pipeline: z.object({ secrets: nonEmptyStringsSchema, vars: nonEmptyStringsSchema }),
})
const manifestEnvelopeSchema = z.object({ manifestVersion: z.literal(FABRIKA_MANIFEST_VERSION), app: manifestAppSchema, target: z.unknown() })

export const zeropsArtifactSourceDescriptorSchema = z.object({
	path: z.literal('zerops.yaml'),
	contents: z.string().min(1).refine((contents) => new TextEncoder().encode(contents).byteLength <= ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES),
	sha256: z.string().regex(SHA256_PATTERN),
}).strict()

/** Refuse fields fabrika owns, so an authored document can never set them. */
const forbidFields = (fields: readonly string[], message: string) => (record: Record<string, JsonValue>, ctx: z.RefinementCtx): void => {
	for (const field of fields) {
		if (Object.hasOwn(record, field)) ctx.addIssue({ code: 'custom', path: [field], message })
	}
}

interface RefusedServiceField {
	readonly field: string
	readonly accepts: (value: JsonValue) => boolean
	readonly reason: string
	readonly allowedForm: string
}

const refusedOutright = (): boolean => false

/**
 * Import fields an APPLICATION service may not set, with no approval path (ADR-0043). The installation and
 * the namespace proxy compile their own documents and never pass through this manifest, so they keep them.
 */
const REFUSED_APPLICATION_SERVICE_FIELDS: readonly RefusedServiceField[] = [
	{
		field: 'objectStoragePolicy',
		accepts: (value) => value === 'private',
		reason: 'a bucket that is not private is read past the namespace proxy',
		allowedForm: 'omit it or set `private`',
	},
	{
		field: 'objectStorageRawPolicy',
		accepts: refusedOutright,
		reason: 'a raw bucket policy cannot be checked to be private',
		allowedForm: 'omit it',
	},
	{
		field: 'enableSubdomainAccess',
		accepts: (value) => value === false,
		reason: 'a `.zerops.app` subdomain reaches the service past the namespace proxy',
		allowedForm: 'omit it or set `false`',
	},
	{
		field: 'buildFromGit',
		accepts: refusedOutright,
		reason: "the platform builds the run's recorded commit, never a repository the import names",
		allowedForm: 'omit it',
	},
	{
		field: 'zeropsYaml',
		accepts: refusedOutright,
		reason: "the build descriptor is the repository's `zerops.yaml`, never an inline copy",
		allowedForm: 'omit it',
	},
	{
		field: 'mount',
		accepts: refusedOutright,
		reason: 'a shared-storage mount reaches a volume outside the application',
		allowedForm: 'omit it',
	},
	{
		field: 'enableCdn',
		accepts: (value) => value === false,
		reason: 'a CDN serves the service past the namespace proxy',
		allowedForm: 'omit it or set `false`',
	},
]

const refuseApplicationExposure = (service: { readonly hostname: string } & Record<string, JsonValue>, ctx: z.RefinementCtx): void => {
	for (const { field, accepts, reason, allowedForm } of REFUSED_APPLICATION_SERVICE_FIELDS) {
		const value = service[field]
		if (value === undefined || accepts(value)) continue
		ctx.addIssue({
			code: 'custom',
			path: [field],
			message: `invalid fabrika manifest: Zerops service \`${service.hostname}\` sets \`${field}\`; ${reason} (${allowedForm})`,
		})
	}
}

const OBJECT_STORAGE_TYPES: ReadonlySet<string> = new Set(['object-storage', 'objectstorage'])

/** Nothing establishes what Zerops does with an omitted policy, so an application bucket always says `private`. */
const withExplicitPrivateStorage = <Service extends { readonly type: string } & Record<string, JsonValue>>(service: Service): Service =>
	OBJECT_STORAGE_TYPES.has(service.type) && service['objectStoragePolicy'] === undefined
		? { ...service, objectStoragePolicy: 'private' }
		: service

const importServiceSchema = z.intersection(
	z.record(manifestJsonSchema),
	z.object({
		hostname: z.string().regex(ZEROPS_SERVICE_HOSTNAME_PATTERN),
		type: z.string().min(1),
		envIsolation: z.literal(ENV_ISOLATION),
		override: z.literal(OVERRIDE),
	}),
)
	.superRefine(forbidFields(['envSecrets', 'dotEnvSecrets'], 'invalid fabrika manifest: Zerops import contains a forbidden environment field'))
	.superRefine(refuseApplicationExposure)
	.transform(withExplicitPrivateStorage)
const importProjectSchema = z.intersection(z.record(manifestJsonSchema), z.object({ envIsolation: z.literal(ENV_ISOLATION) }))
	.superRefine(forbidFields(['envVariables'], 'invalid fabrika manifest: Zerops import contains a forbidden project environment field'))

/** The first foreign host referenced by any string leaf OR key of `value`, however deeply nested. */
const foreignReferenceInValue = (value: unknown, allowed: ReadonlySet<string>): string | null => {
	if (typeof value === 'string') {
		return foreignReferenceHost(value, allowed)
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			const host = foreignReferenceInValue(entry, allowed)
			if (host !== null) return host
		}
		return null
	}
	if (typeof value === 'object' && value !== null) {
		for (const [key, entry] of Object.entries(value)) {
			const host = foreignReferenceHost(key, allowed) ?? foreignReferenceInValue(entry, allowed)
			if (host !== null) return host
		}
	}
	return null
}

const importDocumentSchema = z.object({ project: importProjectSchema.optional(), services: z.array(importServiceSchema).min(1) })
	.strict()
	.superRefine(({ services }, ctx) => {
		const hostnames = services.map((service) => service.hostname)
		const duplicate = hostnames.find((hostname, index) => hostnames.indexOf(hostname) !== index)
		if (duplicate !== undefined) {
			ctx.addIssue({ code: 'custom', message: `invalid fabrika manifest: duplicate Zerops service hostname \`${duplicate}\`` })
			return
		}
		// A `${host_KEY}` reference crosses `envIsolation: service` by design, so the declared hostnames are the
		// boundary. They are never rewritten at deploy: a shared namespace's app prefix is authored INTO the
		// hostname (`service-names.ts`), which `registrationResourceClaims` then enforces.
		const allowed = allowedReferenceHosts(hostnames)
		for (const service of services) {
			const foreign = foreignReferenceInValue(service, allowed)
			if (foreign !== null) {
				ctx.addIssue({
					code: 'custom',
					message: `invalid fabrika manifest: Zerops service \`${service.hostname}\` references service \`${foreign}\`, which this app does not own`,
				})
				return
			}
		}
	})

/** The import document a manifest carries: every service already holds the ADR-0004 invariants. */
export type FabrikaManifestImportDocument = z.infer<typeof importDocumentSchema>

const manifestTargetSchema = z.object({
	sourceDescriptor: zeropsArtifactSourceDescriptorSchema,
	platform: z.literal('zerops'),
	deployService: z.string().min(1),
	importDocument: importDocumentSchema,
	zeropsSetup: z.string().min(1).optional(),
	proxy: manifestProxySchema.optional(),
	namespaceResources: namespaceResourcesSchema.optional(),
})

const importDocumentError = (issue: z.ZodIssue, path: readonly (string | number)[]): string => {
	const [section, index, field] = path
	if (issue.code === 'custom') return issue.message
	if (issue.code === 'unrecognized_keys' && section === undefined) return `invalid fabrika manifest Zerops import document field \`${issue.keys[0]}\``
	if (section === 'project') {
		return index === 'envIsolation'
			? 'invalid fabrika manifest: Zerops import contains a forbidden project environment field'
			: 'invalid fabrika manifest Zerops import project'
	}
	if (typeof index !== 'number') return 'invalid fabrika manifest Zerops import services'
	if (field === 'hostname') return `invalid fabrika manifest Zerops service hostname at index ${index}`
	return `invalid fabrika manifest Zerops service ${field === 'type' ? 'type' : 'invariants'} at index ${index}`
}

const targetError = (issue: z.ZodIssue | undefined): string => {
	const [section, ...rest] = issue?.path ?? []
	if (issue === undefined) return 'invalid fabrika manifest Zerops target'
	switch (section) {
		case 'sourceDescriptor':
			return issue.code === 'unrecognized_keys' && rest.length === 0
				? `invalid fabrika manifest Zerops source descriptor field \`${issue.keys[0]}\``
				: 'invalid fabrika manifest Zerops source descriptor'
		case 'importDocument':
			return importDocumentError(issue, rest)
		case 'zeropsSetup':
			return 'invalid fabrika manifest zeropsSetup'
		case 'proxy':
			return 'invalid fabrika manifest proxy declaration'
		case 'namespaceResources':
			return 'invalid fabrika manifest namespace resources'
		default:
			return 'invalid fabrika manifest Zerops target'
	}
}

export const createZeropsArtifactSourceDescriptor = async (contents: string): Promise<ZeropsArtifactSourceDescriptor> => {
	const bytes = new TextEncoder().encode(contents)
	if (bytes.byteLength === 0) {
		throw new Error('Zerops source descriptor must not be empty')
	}
	if (bytes.byteLength > ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES) {
		throw new Error(`Zerops source descriptor exceeds ${ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES} bytes`)
	}
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
	const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
	return { path: 'zerops.yaml', contents, sha256 }
}

export const verifyZeropsArtifactSourceDescriptor = async (descriptor: ZeropsArtifactSourceDescriptor): Promise<void> => {
	const actual = await createZeropsArtifactSourceDescriptor(descriptor.contents)
	if (actual.sha256 !== descriptor.sha256) {
		throw new Error('Zerops artifact source descriptor digest mismatch')
	}
}

export const manifestServiceHostnames = (manifest: FabrikaManifest): string[] =>
	manifest.target.importDocument.services.map((service) => service.hostname)

export const renderFabrikaImportYaml = (manifest: FabrikaManifest): string => renderYaml(manifest.target.importDocument)

/** Render the codeless import used before registration has a deploy-service id. */
export const renderFabrikaProvisioningYaml = (manifest: FabrikaManifest): string =>
	renderYaml({
		...(manifest.target.importDocument.project === undefined ? {} : { project: manifest.target.importDocument.project }),
		services: manifest.target.importDocument.services.map((service) => ({ ...service, override: false, startWithoutCode: true })),
	})

export function parseFabrikaManifest(value: unknown, expected: ManifestExpectation = {}): FabrikaManifest {
	const envelope = manifestEnvelopeSchema.safeParse(value)
	if (!envelope.success) {
		const [section, field] = envelope.error.issues[0]?.path ?? []
		if (section !== 'app') throw new Error(`unsupported fabrika manifest version (expected ${FABRIKA_MANIFEST_VERSION})`)
		throw new Error(field === 'schema' ? 'invalid fabrika manifest schema' : 'invalid fabrika manifest app metadata')
	}
	const { id, env, schema, pipeline: { secrets, vars } } = envelope.data.app
	assertFabrikaManifestCoordinates({ id, env }, expected)

	const target = manifestTargetSchema.safeParse(envelope.data.target)
	if (!target.success) {
		throw new Error(targetError(target.error.issues[0]))
	}
	const { sourceDescriptor, deployService, importDocument, zeropsSetup, proxy, namespaceResources } = target.data
	assertAuthoredManagedDocument(importDocument.services)
	if (importDocument.project !== undefined) assertAuthoredManagedDocument(importDocument.project)
	assertAuthoredManagedInputs({ variableNames: vars, secretNames: secrets })
	const parsedDescriptor = parseZeropsDescriptor(sourceDescriptor.contents)
	assertAuthoredManagedDocument(parsedDescriptor.document)
	const serviceHostnames = importDocument.services.map((service) => service.hostname)
	if (!serviceHostnames.includes(deployService)) {
		throw new Error('invalid fabrika manifest Zerops deploy service')
	}
	const foreignInDescriptor = foreignReferenceInValue(
		parsedDescriptor.document,
		allowedReferenceHosts(serviceHostnames),
	)
	if (foreignInDescriptor !== null) {
		throw new Error(`invalid fabrika manifest: zerops.yaml references service \`${foreignInDescriptor}\`, which this app does not own`)
	}
	selectZeropsDescriptorSetup(parsedDescriptor, zeropsSetup)
	if (proxy !== undefined) {
		const separator = proxy.upstream.indexOf(':')
		const upstreamHostname = separator === -1 ? proxy.upstream : proxy.upstream.slice(0, separator)
		if (!serviceHostnames.includes(upstreamHostname)) {
			throw new Error(`invalid fabrika manifest: proxy upstream service \`${upstreamHostname}\` is not owned by this app`)
		}
	}
	if (namespaceResources?.some((resource) => serviceHostnames.includes(resource.hostname)) === true) {
		throw new Error('invalid fabrika manifest: an app cannot declare a namespace-owned service')
	}

	return {
		manifestVersion: FABRIKA_MANIFEST_VERSION,
		app: {
			id,
			env,
			...(schema !== undefined ? { schema } : {}),
			pipeline: { secrets, vars },
		},
		target: {
			platform: 'zerops',
			sourceDescriptor,
			importDocument,
			deployService,
			...(zeropsSetup !== undefined ? { zeropsSetup } : {}),
			...(proxy !== undefined ? { proxy } : {}),
			...(namespaceResources !== undefined ? { namespaceResources } : {}),
		},
	}
}

export function compileFabrikaManifest(config: ZeropsAppConfig, env: string, sourceDescriptor: ZeropsArtifactSourceDescriptor): FabrikaManifest {
	if (config.target.services === undefined) {
		throw new Error('fabrika app build requires a source Zerops config')
	}
	const declaredVars = config.pipeline?.vars ?? []
	const prior: Record<string, string | undefined> = {}
	for (const name of declaredVars) {
		prior[name] = process.env[name]
		process.env[name] = `\${${name}}`
	}
	try {
		const document = compileImport({ target: config.target, ctx: { env } })
		const serviceHostnames = document.services.map((service) => service.hostname)
		const deployService = config.target.deployService ?? (serviceHostnames.length === 1 ? serviceHostnames[0] : undefined)
		if (deployService === undefined || !serviceHostnames.includes(deployService)) {
			throw new Error('fabrika app build: a multi-service Zerops app must name a valid deployService')
		}
		const candidate = {
			manifestVersion: FABRIKA_MANIFEST_VERSION,
			app: { id: config.id, env, schema: config.schema, pipeline: { secrets: config.pipeline?.secrets ?? [], vars: declaredVars } },
			target: {
				platform: 'zerops',
				sourceDescriptor,
				importDocument: document,
				deployService,
				zeropsSetup: config.target.zeropsSetup,
				proxy: config.target.proxy,
				namespaceResources: config.target.namespaceResources,
			},
		}
		// The JSON copy is the artifact's own form: authored objects lose inherited fields and undefined keys once, here.
		return parseFabrikaManifest(jsonValue(candidate), { appId: config.id, env })
	} finally {
		for (const name of declaredVars) {
			const value = prior[name]
			if (value === undefined) {
				delete process.env[name]
			} else {
				process.env[name] = value
			}
		}
	}
}

/** Provider artifact codec. Its envelope version and manifest payload version advance independently. */
export const zeropsArtifactCodec: ProviderCodec<FabrikaManifest> = {
	version: 3,
	encode: jsonValue,
	decode: (payload) => parseFabrikaManifest(payload),
}

/** Hash the original validated artifact, never an interpolated import or execution overlay. */
export async function hashFabrikaManifest(manifest: FabrikaManifest): Promise<string> {
	const canonical = (value: JsonValue): JsonValue => {
		if (Array.isArray(value)) return value.map(canonical)
		if (typeof value !== 'object' || value === null) return value
		return Object.fromEntries(
			Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]),
		)
	}
	const bytes = new TextEncoder().encode(JSON.stringify(canonical(zeropsArtifactCodec.encode(manifest))))
	return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
