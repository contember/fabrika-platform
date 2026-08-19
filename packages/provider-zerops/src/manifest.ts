import type { AppActionDef, AppGates, AppSchema, AppScopeDef, GateRule, RoleDef } from '@fabrika/auth-core'
import type { JsonValue, ProviderCodec } from '@fabrika/provider-contract'
import { compileImport, ENV_ISOLATION, OVERRIDE, renderYaml } from './compile'
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

const prop = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

const jsonValue = (value: unknown): JsonValue => {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value
	}
	if (Array.isArray(value)) {
		return value.map(jsonValue)
	}
	if (typeof value === 'object') {
		const result: { [key: string]: JsonValue } = {}
		for (const [key, entry] of Object.entries(value)) {
			if (entry !== undefined) {
				result[key] = jsonValue(entry)
			}
		}
		return result
	}
	throw new Error(`Fabrika manifest contains a non-JSON ${typeof value} value`)
}

const jsonObject = (value: unknown, label: string): { [key: string]: JsonValue } => {
	const parsed = jsonValue(value)
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`invalid fabrika manifest ${label}`)
	}
	return parsed
}

const string = (value: unknown, key: string): string | undefined => {
	const candidate = prop(value, key)
	return typeof candidate === 'string' ? candidate : undefined
}

const nonEmptyString = (value: unknown, key: string): string | undefined => {
	const candidate = string(value, key)
	return candidate !== undefined && candidate !== '' ? candidate : undefined
}

const stringArray = (value: unknown, key: string): string[] | undefined => {
	const candidate = prop(value, key)
	if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== 'string' || item === '')) {
		return undefined
	}
	return candidate
}

const optionalString = (value: unknown, key: string): string | null => {
	const candidate = prop(value, key)
	if (candidate === undefined) {
		return null
	}
	return typeof candidate === 'string' && candidate !== '' ? candidate : null
}

function parseScope(value: unknown): AppScopeDef | null {
	const type = nonEmptyString(value, 'type')
	const label = optionalString(value, 'label')
	if (type === undefined || (prop(value, 'label') !== undefined && label === null)) {
		return null
	}
	return label === null ? { type } : { type, label }
}

function parseAction(value: unknown): AppActionDef | null {
	const action = nonEmptyString(value, 'action')
	const description = optionalString(value, 'description')
	if (action === undefined || (prop(value, 'description') !== undefined && description === null)) {
		return null
	}
	return description === null ? { action } : { action, description }
}

function parseRole(value: unknown): RoleDef | null {
	const name = nonEmptyString(value, 'name')
	const description = optionalString(value, 'description')
	const permissions = stringArray(value, 'permissions')
	if (name === undefined || permissions === undefined || (prop(value, 'description') !== undefined && description === null)) {
		return null
	}
	return description === null ? { name, permissions } : { name, description, permissions }
}

function parseSchema(value: unknown): AppSchema | null {
	const rawScopes = prop(value, 'scopes')
	const rawActions = prop(value, 'actions')
	const rawRoles = prop(value, 'roles')
	if (!Array.isArray(rawScopes) || !Array.isArray(rawActions) || typeof rawRoles !== 'object' || rawRoles === null || Array.isArray(rawRoles)) {
		return null
	}
	const scopes: AppScopeDef[] = []
	for (const raw of rawScopes) {
		const scope = parseScope(raw)
		if (scope === null) return null
		scopes.push(scope)
	}
	const actions: AppActionDef[] = []
	for (const raw of rawActions) {
		const action = parseAction(raw)
		if (action === null) return null
		actions.push(action)
	}
	const roles: Record<string, RoleDef> = {}
	for (const [key, raw] of Object.entries(rawRoles)) {
		const role = parseRole(raw)
		if (key === '' || role === null) return null
		roles[key] = role
	}
	return { scopes, actions, roles }
}

function parseGate(value: unknown): GateRule | null {
	const path = nonEmptyString(value, 'path')
	const kind = string(value, 'kind')
	if (path === undefined || !path.startsWith('/')) return null
	if (kind === 'public' || kind === 'human') return { path, kind }
	if (kind !== 'service') return null
	const rawCredential = prop(value, 'credential')
	if (rawCredential === undefined) return { path, kind }
	const location = string(rawCredential, 'in')
	const name = nonEmptyString(rawCredential, 'name')
	if ((location !== 'header' && location !== 'query' && location !== 'cookie') || name === undefined) return null
	return { path, kind, credential: { in: location, name } }
}

function parseGates(value: unknown): AppGates | null {
	const rawRules = prop(value, 'rules')
	if (!Array.isArray(rawRules)) return null
	const rules: GateRule[] = []
	for (const raw of rawRules) {
		const rule = parseGate(raw)
		if (rule === null) return null
		rules.push(rule)
	}
	return { rules }
}

const parseNamespaceResources = (value: unknown): ZeropsNamespaceResourceRequirement[] | null => {
	if (!Array.isArray(value)) return null
	const resources: ZeropsNamespaceResourceRequirement[] = []
	let hasPostgres = false
	for (const resource of value) {
		if (
			string(resource, 'resourceKey') !== 'service:postgres'
			|| string(resource, 'hostname') !== 'postgres'
			|| string(resource, 'connectionString') !== SHARED_POSTGRES_CONNECTION_STRING
		) {
			return null
		}
		if (hasPostgres) return null
		hasPostgres = true
		resources.push({
			resourceKey: 'service:postgres',
			hostname: 'postgres',
			connectionString: SHARED_POSTGRES_CONNECTION_STRING,
		})
	}
	return resources
}

function parseProxy(value: unknown): ZeropsProxySpec | null {
	const upstream = nonEmptyString(value, 'upstream')
	const gates = parseGates(prop(value, 'gates'))
	return upstream === undefined || gates === null ? null : { upstream, gates }
}

const parseImportDocument = (value: unknown): FabrikaImportDocument => {
	if (value === undefined) {
		throw new Error('invalid fabrika manifest Zerops import document')
	}
	const raw = jsonObject(value, 'Zerops import document')
	const unknownKeys = Object.keys(raw).filter((key) => key !== 'project' && key !== 'services')
	if (unknownKeys.length > 0) {
		throw new Error(`invalid fabrika manifest Zerops import document field \`${unknownKeys[0]}\``)
	}
	const rawServices = raw['services']
	if (!Array.isArray(rawServices) || rawServices.length === 0) {
		throw new Error('invalid fabrika manifest Zerops import services')
	}
	const services: Array<{ readonly [key: string]: JsonValue }> = []
	const hostnames = new Set<string>()
	for (const [index, rawService] of rawServices.entries()) {
		const service = jsonObject(rawService, `Zerops import service ${index}`)
		const hostname = service['hostname']
		if (typeof hostname !== 'string' || !ZEROPS_SERVICE_HOSTNAME_PATTERN.test(hostname)) {
			throw new Error(`invalid fabrika manifest Zerops service hostname at index ${index}`)
		}
		if (hostnames.has(hostname)) {
			throw new Error(`invalid fabrika manifest: duplicate Zerops service hostname \`${hostname}\``)
		}
		if (typeof service['type'] !== 'string' || service['type'] === '') {
			throw new Error(`invalid fabrika manifest Zerops service type for \`${hostname}\``)
		}
		// `override: true` is required on EVERY service class, managed included — without it the platform
		// rejects a re-apply of the whole document as a name collision (see `compile.ts`).
		if (service['envIsolation'] !== ENV_ISOLATION || service['override'] !== OVERRIDE) {
			throw new Error(`invalid fabrika manifest Zerops service invariants for \`${hostname}\``)
		}
		if (service['envSecrets'] !== undefined || service['dotEnvSecrets'] !== undefined) {
			throw new Error('invalid fabrika manifest: Zerops import contains a forbidden environment field')
		}
		hostnames.add(hostname)
		services.push(service)
	}
	const rawProject = raw['project']
	let project: { readonly [key: string]: JsonValue } | undefined
	if (rawProject !== undefined) {
		project = jsonObject(rawProject, 'Zerops import project')
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
	const contents = raw['contents']
	const sha256 = raw['sha256']
	if (
		raw['path'] !== 'zerops.yaml'
		|| typeof contents !== 'string'
		|| contents === ''
		|| new TextEncoder().encode(contents).byteLength > ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES
		|| typeof sha256 !== 'string'
		|| !SHA256_PATTERN.test(sha256)
	) {
		throw new Error('invalid fabrika manifest Zerops source descriptor')
	}
	return { path: 'zerops.yaml', contents, sha256 }
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
		services: manifest.target.importDocument.services.map((service) => ({ ...service, startWithoutCode: true })),
	})

export function parseFabrikaManifest(value: unknown, expected: ManifestExpectation = {}): FabrikaManifest {
	if (prop(value, 'manifestVersion') !== FABRIKA_MANIFEST_VERSION) {
		throw new Error(`unsupported fabrika manifest version (expected ${FABRIKA_MANIFEST_VERSION})`)
	}
	const rawApp = prop(value, 'app')
	const id = nonEmptyString(rawApp, 'id')
	const env = nonEmptyString(rawApp, 'env')
	const rawPipeline = prop(rawApp, 'pipeline')
	const secrets = stringArray(rawPipeline, 'secrets')
	const vars = stringArray(rawPipeline, 'vars')
	if (id === undefined || env === undefined || secrets === undefined || vars === undefined) {
		throw new Error('invalid fabrika manifest app metadata')
	}
	if (expected.appId !== undefined && expected.appId !== id) {
		throw new Error(`manifest app drift: expected \`${expected.appId}\`, got \`${id}\``)
	}
	if (expected.env !== undefined && expected.env !== env) {
		throw new Error(`manifest environment drift: expected \`${expected.env}\`, got \`${env}\``)
	}
	const rawSchema = prop(rawApp, 'schema')
	let schema: AppSchema | undefined
	if (rawSchema !== undefined) {
		const parsed = parseSchema(rawSchema)
		if (parsed === null) {
			throw new Error('invalid fabrika manifest schema')
		}
		schema = parsed
	}

	const rawTarget = prop(value, 'target')
	const sourceDescriptor = parseSourceDescriptor(prop(rawTarget, 'sourceDescriptor'))
	const rawImportDocument = prop(rawTarget, 'importDocument')
	const deployService = nonEmptyString(rawTarget, 'deployService')
	if (
		string(rawTarget, 'platform') !== 'zerops'
		|| deployService === undefined
	) {
		throw new Error('invalid fabrika manifest Zerops target')
	}
	const importDocument = parseImportDocument(rawImportDocument)
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
	const zeropsSetup = optionalString(rawTarget, 'zeropsSetup')
	if (prop(rawTarget, 'zeropsSetup') !== undefined && zeropsSetup === null) {
		throw new Error('invalid fabrika manifest zeropsSetup')
	}
	const rawProxy = prop(rawTarget, 'proxy')
	let proxy: ZeropsProxySpec | undefined
	if (rawProxy !== undefined) {
		const parsed = parseProxy(rawProxy)
		if (parsed === null) {
			throw new Error('invalid fabrika manifest proxy declaration')
		}
		proxy = parsed
		const separator = parsed.upstream.indexOf(':')
		const upstreamHostname = separator === -1 ? parsed.upstream : parsed.upstream.slice(0, separator)
		if (!serviceHostnames.includes(upstreamHostname)) {
			throw new Error(`invalid fabrika manifest: proxy upstream service \`${upstreamHostname}\` is not owned by this app`)
		}
	}
	const rawNamespaceResources = prop(rawTarget, 'namespaceResources')
	let namespaceResources: ZeropsNamespaceResourceRequirement[] | undefined
	if (rawNamespaceResources !== undefined) {
		const parsed = parseNamespaceResources(rawNamespaceResources)
		if (parsed === null) {
			throw new Error('invalid fabrika manifest namespace resources')
		}
		namespaceResources = parsed
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
			...(zeropsSetup !== null ? { zeropsSetup } : {}),
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
