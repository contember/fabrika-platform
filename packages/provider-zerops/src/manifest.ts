import type { AppSchema } from '@fabrika/auth-core'
import type { JsonValue, ProviderCodec } from '@fabrika/provider-contract'
import { z } from 'zod'
import { compileImport, ENV_ISOLATION, OVERRIDE, renderYaml } from './compile'
import { parseZeropsDescriptor, selectZeropsDescriptorSetup } from './descriptor'
import { assertAuthoredManagedDocument, assertAuthoredManagedInputs } from './managed-environment/authored'
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
		importDocument: FabrikaImportDocument
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

const prop = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

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

const jsonObject = (value: unknown, label: string): { [key: string]: JsonValue } => {
	const parsed = jsonValue(value)
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`invalid fabrika manifest ${label}`)
	}
	return parsed
}

// Hooks historically share pipeline/permission arrays with the decoded artifact; Zod arrays would clone them.
const referencedStringArraySchema = z.custom<string[]>((value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string' && entry !== '')
)
const scopeSchema = z.preprocess(
	(value) => ({ type: prop(value, 'type'), label: prop(value, 'label') }),
	z.object({ type: z.string().min(1), label: z.string().min(1).optional() })
		.transform(({ type, label }) => label === undefined ? { type } : { type, label }),
)
const actionSchema = z.preprocess(
	(value) => ({ action: prop(value, 'action'), description: prop(value, 'description') }),
	z.object({ action: z.string().min(1), description: z.string().min(1).optional() })
		.transform(({ action, description }) => description === undefined ? { action } : { action, description }),
)
const roleSchema = z.preprocess(
	(value) => ({ name: prop(value, 'name'), description: prop(value, 'description'), permissions: prop(value, 'permissions') }),
	z.object({ name: z.string().min(1), description: z.string().min(1).optional(), permissions: referencedStringArraySchema })
		.transform(({ name, description, permissions }) => description === undefined ? { name, permissions } : { name, description, permissions }),
)
const rolesSchema = z.preprocess((value) =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: value, z.record(z.string().min(1), roleSchema))
const appSchema = z.preprocess(
	(value) => ({ scopes: prop(value, 'scopes'), actions: prop(value, 'actions'), roles: prop(value, 'roles') }),
	z.object({ scopes: z.array(scopeSchema), actions: z.array(actionSchema), roles: rolesSchema }),
)

// Unlike proxy wire gates, authoring accepts inherited fields and rejects a null credential.
const manifestCredentialSchema = z.preprocess(
	(value) => ({ in: prop(value, 'in'), name: prop(value, 'name') }),
	z.object({ in: z.enum(['header', 'query', 'cookie']), name: z.string().min(1) }),
)
const manifestGateSchema = z.preprocess(
	(value) => ({ path: prop(value, 'path'), kind: prop(value, 'kind'), credential: prop(value, 'credential') }),
	z.discriminatedUnion('kind', [
		z.object({ path: z.string().startsWith('/'), kind: z.literal('public') }),
		z.object({ path: z.string().startsWith('/'), kind: z.literal('human') }),
		z.object({ path: z.string().startsWith('/'), kind: z.literal('service'), credential: manifestCredentialSchema.optional() }),
	]).transform((rule) => {
		if (rule.kind === 'service' && rule.credential === undefined) delete rule.credential
		return rule
	}),
)
const manifestProxySchema = z.preprocess(
	(value) => ({ upstream: prop(value, 'upstream'), gates: { rules: prop(prop(value, 'gates'), 'rules') } }),
	z.object({ upstream: z.string().min(1), gates: z.object({ rules: z.array(manifestGateSchema) }) }),
)
const namespaceResourcesSchema = z.array(z.preprocess(
	(value) => ({
		resourceKey: prop(value, 'resourceKey'),
		hostname: prop(value, 'hostname'),
		connectionString: prop(value, 'connectionString'),
	}),
	z.object({
		resourceKey: z.literal('service:postgres'),
		hostname: z.literal('postgres'),
		connectionString: z.literal(SHARED_POSTGRES_CONNECTION_STRING),
	}),
)).max(1)

const appMetadataSchema = z.preprocess(
	(value) => ({
		id: prop(value, 'id'),
		env: prop(value, 'env'),
		pipeline: { secrets: prop(prop(value, 'pipeline'), 'secrets'), vars: prop(prop(value, 'pipeline'), 'vars') },
	}),
	z.object({
		id: z.string().min(1),
		env: z.string().min(1),
		pipeline: z.object({ secrets: referencedStringArraySchema, vars: referencedStringArraySchema }),
	}),
)
export const zeropsArtifactSourceDescriptorSchema = z.object({
	path: z.literal('zerops.yaml'),
	contents: z.string().min(1).refine((contents) => new TextEncoder().encode(contents).byteLength <= ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES),
	sha256: z.string().regex(SHA256_PATTERN),
}).strict()
const targetMetadataSchema = z.preprocess(
	(value) => ({ platform: prop(value, 'platform'), deployService: prop(value, 'deployService') }),
	z.object({ platform: z.literal('zerops'), deployService: z.string().min(1) }),
)
const setupSelectorSchema = z.string().min(1).optional()
const importDocumentSchema = z.object({ project: z.record(manifestJsonSchema).optional(), services: z.array(z.record(manifestJsonSchema)).min(1) })
	.strict()
const importServiceSchema = z.intersection(
	z.record(manifestJsonSchema),
	z.object({
		hostname: z.string().regex(ZEROPS_SERVICE_HOSTNAME_PATTERN),
		type: z.string().min(1),
		envIsolation: z.literal(ENV_ISOLATION),
		override: z.literal(OVERRIDE),
		envSecrets: z.never().optional(),
		dotEnvSecrets: z.never().optional(),
	}),
)

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
		for (const key of Object.keys(value)) {
			const host = foreignReferenceHost(key, allowed) ?? foreignReferenceInValue(prop(value, key), allowed)
			if (host !== null) return host
		}
	}
	return null
}

const parseImportDocument = (value: unknown): FabrikaImportDocument => {
	if (value === undefined) {
		throw new Error('invalid fabrika manifest Zerops import document')
	}
	const raw = jsonObject(value, 'Zerops import document')
	const result = importDocumentSchema.safeParse(raw)
	if (!result.success) {
		const issue = result.error.issues[0]
		if (issue?.code === 'unrecognized_keys') throw new Error(`invalid fabrika manifest Zerops import document field \`${issue.keys[0]}\``)
		throw new Error(`invalid fabrika manifest Zerops import ${issue?.path[0] === 'project' ? 'project' : 'services'}`)
	}
	const rawServices = result.data.services
	const parsed: Array<[string, { readonly [key: string]: JsonValue }]> = []
	const hostnames = new Set<string>()
	for (const [index, rawService] of rawServices.entries()) {
		const parsedService = importServiceSchema.safeParse(rawService)
		if (!parsedService.success) {
			const key = parsedService.error.issues[0]?.path[0]
			if (key === 'hostname') throw new Error(`invalid fabrika manifest Zerops service hostname at index ${index}`)
			if (key === 'envSecrets' || key === 'dotEnvSecrets') {
				throw new Error('invalid fabrika manifest: Zerops import contains a forbidden environment field')
			}
			throw new Error(`invalid fabrika manifest Zerops service ${key === 'type' ? 'type' : 'invariants'} for \`${rawService['hostname']}\``)
		}
		const service = parsedService.data
		const hostname = service.hostname
		if (hostnames.has(hostname)) {
			throw new Error(`invalid fabrika manifest: duplicate Zerops service hostname \`${hostname}\``)
		}
		hostnames.add(hostname)
		parsed.push([hostname, service])
	}
	// A `${host_KEY}` reference crosses `envIsolation: service` by design, so the declared hostnames are the
	// boundary. They are never rewritten at deploy: a shared namespace's app prefix is authored INTO the
	// hostname (`service-names.ts`), which `registrationResourceClaims` then enforces.
	const allowed = allowedReferenceHosts([...hostnames])
	for (const [hostname, service] of parsed) {
		const foreign = foreignReferenceInValue(service, allowed)
		if (foreign !== null) {
			throw new Error(`invalid fabrika manifest: Zerops service \`${hostname}\` references service \`${foreign}\`, which this app does not own`)
		}
	}
	const services = parsed.map(([, service]) => service)
	const rawProject = result.data.project
	let project: { readonly [key: string]: JsonValue } | undefined
	if (rawProject !== undefined) {
		project = rawProject
		if (project['envIsolation'] !== ENV_ISOLATION || project['envVariables'] !== undefined) {
			throw new Error('invalid fabrika manifest: Zerops import contains a forbidden project environment field')
		}
	}
	return project === undefined ? { services } : { project, services }
}

const parseSourceDescriptor = (value: unknown): ZeropsArtifactSourceDescriptor => {
	if (value === undefined) {
		throw new Error('invalid fabrika manifest Zerops source descriptor')
	}
	const raw = jsonObject(value, 'Zerops source descriptor')
	const unknownKeys = Object.keys(raw).filter((key) => key !== 'path' && key !== 'contents' && key !== 'sha256')
	if (unknownKeys.length > 0) {
		throw new Error(`invalid fabrika manifest Zerops source descriptor field \`${unknownKeys[0]}\``)
	}
	const result = zeropsArtifactSourceDescriptorSchema.safeParse(raw)
	if (!result.success) {
		throw new Error('invalid fabrika manifest Zerops source descriptor')
	}
	return result.data
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
	manifest.target.importDocument.services.map((service) => {
		const hostname = service['hostname']
		if (typeof hostname !== 'string') {
			throw new Error('invalid canonical Zerops service hostname')
		}
		return hostname
	})

export const renderFabrikaImportYaml = (manifest: FabrikaManifest): string => renderYaml(manifest.target.importDocument)

/** Render the codeless import used before registration has a deploy-service id. */
export const renderFabrikaProvisioningYaml = (manifest: FabrikaManifest): string =>
	renderYaml({
		...(manifest.target.importDocument.project === undefined ? {} : { project: manifest.target.importDocument.project }),
		services: manifest.target.importDocument.services.map((service) => ({ ...service, override: false, startWithoutCode: true })),
	})

export function parseFabrikaManifest(value: unknown, expected: ManifestExpectation = {}): FabrikaManifest {
	if (prop(value, 'manifestVersion') !== FABRIKA_MANIFEST_VERSION) {
		throw new Error(`unsupported fabrika manifest version (expected ${FABRIKA_MANIFEST_VERSION})`)
	}
	const rawApp = prop(value, 'app')
	const metadata = appMetadataSchema.safeParse(rawApp)
	if (!metadata.success) {
		throw new Error('invalid fabrika manifest app metadata')
	}
	const { id, env, pipeline: { secrets, vars } } = metadata.data
	assertFabrikaManifestCoordinates({ id, env }, expected)
	const rawSchema = prop(rawApp, 'schema')
	let schema: AppSchema | undefined
	if (rawSchema !== undefined) {
		const parsed = appSchema.safeParse(rawSchema)
		if (!parsed.success) {
			throw new Error('invalid fabrika manifest schema')
		}
		schema = parsed.data
	}

	const rawTarget = prop(value, 'target')
	const sourceDescriptor = parseSourceDescriptor(prop(rawTarget, 'sourceDescriptor'))
	const rawImportDocument = prop(rawTarget, 'importDocument')
	const targetMetadata = targetMetadataSchema.safeParse(rawTarget)
	if (!targetMetadata.success) {
		throw new Error('invalid fabrika manifest Zerops target')
	}
	const { deployService } = targetMetadata.data
	const importDocument = parseImportDocument(rawImportDocument)
	assertAuthoredManagedDocument(importDocument.services)
	if (importDocument.project !== undefined) assertAuthoredManagedDocument(importDocument.project)
	assertAuthoredManagedInputs({ variableNames: vars, secretNames: secrets })
	const parsedDescriptor = parseZeropsDescriptor(sourceDescriptor.contents)
	assertAuthoredManagedDocument(parsedDescriptor.document)
	const serviceHostnames = importDocument.services.map((service) => {
		const hostname = service['hostname']
		if (typeof hostname !== 'string') {
			throw new Error('invalid fabrika manifest Zerops service hostname')
		}
		return hostname
	})
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
	const selector = setupSelectorSchema.safeParse(prop(rawTarget, 'zeropsSetup'))
	if (!selector.success) {
		throw new Error('invalid fabrika manifest zeropsSetup')
	}
	const zeropsSetup = selector.data
	selectZeropsDescriptorSetup(parsedDescriptor, zeropsSetup)
	const rawProxy = prop(rawTarget, 'proxy')
	let proxy: ZeropsProxySpec | undefined
	if (rawProxy !== undefined) {
		const parsed = manifestProxySchema.safeParse(rawProxy)
		if (!parsed.success) {
			throw new Error('invalid fabrika manifest proxy declaration')
		}
		proxy = parsed.data
		const separator = proxy.upstream.indexOf(':')
		const upstreamHostname = separator === -1 ? proxy.upstream : proxy.upstream.slice(0, separator)
		if (!serviceHostnames.includes(upstreamHostname)) {
			throw new Error(`invalid fabrika manifest: proxy upstream service \`${upstreamHostname}\` is not owned by this app`)
		}
	}
	const rawNamespaceResources = prop(rawTarget, 'namespaceResources')
	let namespaceResources: ZeropsNamespaceResourceRequirement[] | undefined
	if (rawNamespaceResources !== undefined) {
		const parsed = namespaceResourcesSchema.safeParse(rawNamespaceResources)
		if (!parsed.success) {
			throw new Error('invalid fabrika manifest namespace resources')
		}
		namespaceResources = parsed.data
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
		if (config.target.namespaceResources?.some((resource) => serviceHostnames.includes(resource.hostname)) === true) {
			throw new Error('fabrika app build: an app cannot declare a namespace-owned service')
		}
		const manifest: FabrikaManifest = {
			manifestVersion: FABRIKA_MANIFEST_VERSION,
			app: {
				id: config.id,
				env,
				...(config.schema !== undefined ? { schema: config.schema } : {}),
				pipeline: {
					secrets: [...(config.pipeline?.secrets ?? [])],
					vars: [...declaredVars],
				},
			},
			target: {
				platform: 'zerops',
				sourceDescriptor,
				importDocument: parseImportDocument(document),
				deployService,
				...(config.target.zeropsSetup !== undefined ? { zeropsSetup: config.target.zeropsSetup } : {}),
				...(config.target.proxy !== undefined ? { proxy: config.target.proxy } : {}),
				...(config.target.namespaceResources !== undefined ? { namespaceResources: [...config.target.namespaceResources] } : {}),
			},
		}
		return parseFabrikaManifest(manifest, { appId: config.id, env })
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
