import type { AppActionDef, AppGates, AppSchema, AppScopeDef, GateRule, RoleDef } from '@fabrika/auth-core'
import type { JsonValue, ProviderCodec } from '@fabrika/provider-contract'
import { compileImportYaml } from './compile'
import type { ZeropsAppConfig, ZeropsNamespaceResourceRequirement, ZeropsProxySpec } from './types'

export const FABRIKA_MANIFEST_VERSION = 1

export interface FabrikaManifestV1 {
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
		importYaml: string
		serviceHostnames: string[]
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
			|| string(resource, 'connectionString') !== '${postgres_connectionString}'
		) {
			return null
		}
		if (hasPostgres) return null
		hasPostgres = true
		resources.push({
			resourceKey: 'service:postgres',
			hostname: 'postgres',
			connectionString: '${postgres_connectionString}',
		})
	}
	return resources
}

function parseProxy(value: unknown): ZeropsProxySpec | null {
	const upstream = nonEmptyString(value, 'upstream')
	const gates = parseGates(prop(value, 'gates'))
	return upstream === undefined || gates === null ? null : { upstream, gates }
}

const hasForbiddenImportField = (yaml: string): boolean => /(^|\n)\s*(envSecrets|dotEnvSecrets|envVariables)\s*:/.test(yaml)

export function parseFabrikaManifest(value: unknown, expected: ManifestExpectation = {}): FabrikaManifestV1 {
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
	const importYaml = nonEmptyString(rawTarget, 'importYaml')
	const serviceHostnames = stringArray(rawTarget, 'serviceHostnames')
	const deployService = nonEmptyString(rawTarget, 'deployService')
	if (
		string(rawTarget, 'platform') !== 'zerops'
		|| importYaml === undefined
		|| serviceHostnames === undefined
		|| serviceHostnames.length === 0
		|| new Set(serviceHostnames).size !== serviceHostnames.length
		|| deployService === undefined
		|| !serviceHostnames.includes(deployService)
	) {
		throw new Error('invalid fabrika manifest Zerops target')
	}
	if (hasForbiddenImportField(importYaml)) {
		throw new Error('invalid fabrika manifest: Zerops import contains a forbidden environment field')
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
			importYaml,
			serviceHostnames,
			deployService,
			...(zeropsSetup !== null ? { zeropsSetup } : {}),
			...(proxy !== undefined ? { proxy } : {}),
			...(namespaceResources !== undefined ? { namespaceResources } : {}),
		},
	}
}

export function compileFabrikaManifest(config: ZeropsAppConfig, env: string): FabrikaManifestV1 {
	if (config.target.services === undefined) {
		throw new Error('fabrika-zerops build requires a source Zerops config')
	}
	const declaredVars = config.pipeline?.vars ?? []
	const prior: Record<string, string | undefined> = {}
	for (const name of declaredVars) {
		prior[name] = process.env[name]
		process.env[name] = `\${${name}}`
	}
	try {
		const { document, yaml } = compileImportYaml({ target: config.target, ctx: { env } })
		const serviceHostnames = document.services.map((service) => service.hostname)
		const deployService = config.target.deployService ?? (serviceHostnames.length === 1 ? serviceHostnames[0] : undefined)
		if (deployService === undefined || !serviceHostnames.includes(deployService)) {
			throw new Error('fabrika-zerops build: a multi-service Zerops app must name a valid deployService')
		}
		if (config.target.namespaceResources?.some((resource) => serviceHostnames.includes(resource.hostname)) === true) {
			throw new Error('fabrika-zerops build: an app cannot declare a namespace-owned service')
		}
		return {
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
				importYaml: yaml,
				serviceHostnames,
				deployService,
				...(config.target.zeropsSetup !== undefined ? { zeropsSetup: config.target.zeropsSetup } : {}),
				...(config.target.proxy !== undefined ? { proxy: config.target.proxy } : {}),
				...(config.target.namespaceResources !== undefined ? { namespaceResources: [...config.target.namespaceResources] } : {}),
			},
		}
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

/** Provider artifact codec. Its envelope version and manifest payload version advance independently. */
export const zeropsArtifactCodec: ProviderCodec<FabrikaManifestV1> = {
	version: 1,
	encode: jsonValue,
	decode: (payload) => parseFabrikaManifest(payload),
}
