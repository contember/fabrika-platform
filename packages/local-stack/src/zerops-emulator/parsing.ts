import {
	type AppVersionRecord,
	emptySnapshot,
	type EmulatorSnapshot,
	type ImportDocument,
	type ImportService,
	type IntegrationTokenRecord,
	type ProcessRecord,
	type ProjectRecord,
	type RoleCode,
	type ServiceEnvRecord,
	type ServiceRecord,
	type TokenGrantRecord,
} from './model'
import { PlatformRefusal } from './protocol'

export const property = (value: unknown, key: string): unknown =>
	typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined

export const stringProperty = (value: unknown, key: string): string | undefined => {
	const found = property(value, key)
	return typeof found === 'string' ? found : undefined
}

export const booleanProperty = (value: unknown, key: string): boolean | undefined => {
	const found = property(value, key)
	return typeof found === 'boolean' ? found : undefined
}

const numberProperty = (value: unknown, key: string): number | undefined => {
	const found = property(value, key)
	return typeof found === 'number' ? found : undefined
}

const stringArrayProperty = (value: unknown, key: string): string[] | undefined => {
	const found = property(value, key)
	if (!Array.isArray(found) || found.some((entry) => typeof entry !== 'string')) {
		return undefined
	}
	return found.filter((entry): entry is string => typeof entry === 'string')
}

export const parseImportDocument = (yaml: string): ImportDocument => {
	const value: unknown = Bun.YAML.parse(yaml)
	const rawServices = property(value, 'services')
	if (!Array.isArray(rawServices) || rawServices.length === 0) {
		throw new Error('import must declare at least one service')
	}
	const services = rawServices.map((entry): ImportService => {
		const hostname = stringProperty(entry, 'hostname')
		if (hostname === undefined || hostname === '') {
			throw new Error('every imported service must have a hostname')
		}
		const zeropsSetup = stringProperty(entry, 'zeropsSetup')
		const buildFromGit = stringProperty(entry, 'buildFromGit')
		// A `zeropsSetup` names a pipeline config, and the platform takes one only beside a build source.
		if (zeropsSetup !== undefined && buildFromGit === undefined) {
			throw new PlatformRefusal(400, 'projectImportInvalidParameter', 'parameter is required for use of pipelineConfig')
		}
		return {
			hostname,
			...(stringProperty(entry, 'type') === undefined ? {} : { type: stringProperty(entry, 'type') }),
			...(stringProperty(entry, 'profile') === undefined ? {} : { profile: stringProperty(entry, 'profile') }),
			...(booleanProperty(entry, 'override') === undefined ? {} : { override: booleanProperty(entry, 'override') }),
			...(booleanProperty(entry, 'startWithoutCode') === undefined ? {} : { startWithoutCode: booleanProperty(entry, 'startWithoutCode') }),
			...(zeropsSetup === undefined ? {} : { zeropsSetup }),
			...(buildFromGit === undefined ? {} : { buildFromGit }),
		}
	})
	const rawProject = property(value, 'project')
	if (rawProject === undefined) {
		return { services }
	}
	const name = stringProperty(rawProject, 'name')
	if (name === undefined || name === '') {
		throw new Error('an imported project must have a name')
	}
	return {
		project: {
			name,
			...(stringProperty(rawProject, 'corePackage') === undefined ? {} : { corePackage: stringProperty(rawProject, 'corePackage') }),
			...(stringProperty(rawProject, 'description') === undefined ? {} : { description: stringProperty(rawProject, 'description') }),
			...(stringArrayProperty(rawProject, 'tags') === undefined ? {} : { tags: stringArrayProperty(rawProject, 'tags') }),
		},
		services,
	}
}

export const readSnapshot = async (path: string | undefined): Promise<EmulatorSnapshot> => {
	if (path === undefined || !(await Bun.file(path).exists())) {
		return emptySnapshot()
	}
	const value: unknown = await Bun.file(path).json()
	const counters = ['nextProject', 'nextService', 'nextEnv', 'nextVersion', 'nextProcess']
	const arrays = ['projects', 'services', 'serviceEnv', 'appVersions']
	// Processes and integration tokens arrived after the first state files were written; a file that
	// predates them simply has none, and refusing it would cost a `local:reset` for no reader's benefit.
	const laterArrays = ['processes', 'integrationTokens']
	if (
		typeof value !== 'object'
		|| value === null
		|| counters.some((key) => typeof property(value, key) !== 'number')
		|| arrays.some((key) => !Array.isArray(property(value, key)))
		|| laterArrays.some((key) => property(value, key) !== undefined && !Array.isArray(property(value, key)))
	) {
		throw new Error('invalid Zerops emulator state file')
	}
	const projects = property(value, 'projects')
	const services = property(value, 'services')
	const serviceEnv = property(value, 'serviceEnv')
	const appVersions = property(value, 'appVersions')
	if (!Array.isArray(projects) || !Array.isArray(services) || !Array.isArray(serviceEnv) || !Array.isArray(appVersions)) {
		throw new Error('invalid Zerops emulator state arrays')
	}
	return {
		nextProject: readCounter(value, 'nextProject'),
		nextService: readCounter(value, 'nextService'),
		nextEnv: readCounter(value, 'nextEnv'),
		nextVersion: readCounter(value, 'nextVersion'),
		nextProcess: readCounter(value, 'nextProcess'),
		nextIntegrationToken: property(value, 'nextIntegrationToken') === undefined ? 1 : readCounter(value, 'nextIntegrationToken'),
		projects: projects.map(readProjectRecord),
		services: services.map(readServiceRecord),
		serviceEnv: serviceEnv.map(readServiceEnvRecord),
		appVersions: appVersions.map(readAppVersionRecord),
		processes: laterArray(value, 'processes').map(readProcessRecord),
		integrationTokens: laterArray(value, 'integrationTokens').map(readIntegrationTokenRecord),
	}
}

const laterArray = (value: unknown, key: string): unknown[] => {
	const found = property(value, key)
	return Array.isArray(found) ? found : []
}

export const requiredString = (value: unknown, key: string): string => {
	const found = stringProperty(value, key)
	if (found === undefined) {
		throw new Error(`invalid state field ${key}`)
	}
	return found
}

const readCounter = (value: unknown, key: string): number => {
	const found = property(value, key)
	if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
		throw new Error(`invalid state counter ${key}`)
	}
	return found
}

const readProjectRecord = (value: unknown): ProjectRecord => {
	const mode = stringProperty(value, 'mode')
	if (mode !== 'LIGHT' && mode !== 'SERIOUS') {
		throw new Error('invalid project mode in state')
	}
	return {
		id: requiredString(value, 'id'),
		clientId: requiredString(value, 'clientId'),
		name: requiredString(value, 'name'),
		status: 'ACTIVE',
		mode,
		...(stringProperty(value, 'description') === undefined ? {} : { description: stringProperty(value, 'description') }),
		...(stringArrayProperty(value, 'tagList') === undefined ? {} : { tagList: stringArrayProperty(value, 'tagList') }),
	}
}

const readServiceRecord = (value: unknown): ServiceRecord => ({
	id: requiredString(value, 'id'),
	projectId: requiredString(value, 'projectId'),
	name: requiredString(value, 'name'),
	status: 'ACTIVE',
	...(stringProperty(value, 'base') === undefined ? {} : { base: stringProperty(value, 'base') }),
	...(stringProperty(value, 'activeAppVersionId') === undefined
		? {}
		: { activeAppVersionId: stringProperty(value, 'activeAppVersionId') }),
	...(booleanProperty(value, 'subdomainAccess') === undefined
		? {}
		: { subdomainAccess: booleanProperty(value, 'subdomainAccess') }),
	...(stringProperty(value, 'autoscalingProfileId') === undefined
		? {}
		: { autoscalingProfileId: stringProperty(value, 'autoscalingProfileId') }),
})

const readServiceEnvRecord = (value: unknown): ServiceEnvRecord => ({
	id: requiredString(value, 'id'),
	serviceStackId: requiredString(value, 'serviceStackId'),
	key: requiredString(value, 'key'),
	content: requiredString(value, 'content'),
	type: 'SECRET',
})

const readAppVersionRecord = (value: unknown): AppVersionRecord => {
	const status = stringProperty(value, 'status')
	if (status !== 'BUILDING' && status !== 'ACTIVE' && status !== 'CANCELLED') {
		throw new Error('invalid app-version status in state')
	}
	const activateAt = numberProperty(value, 'activateAt')
	if (activateAt !== undefined && (!Number.isFinite(activateAt) || activateAt < 0)) {
		throw new Error('invalid app-version activation time in state')
	}
	return {
		id: requiredString(value, 'id'),
		serviceStackId: requiredString(value, 'serviceStackId'),
		projectId: requiredString(value, 'projectId'),
		status,
		sequence: readCounter(value, 'sequence'),
		...(activateAt === undefined ? {} : { activateAt }),
	}
}

const readProcessRecord = (value: unknown): ProcessRecord => {
	const pendingReads = numberProperty(value, 'pendingReads')
	if (pendingReads === undefined || !Number.isInteger(pendingReads) || pendingReads < 0) {
		throw new Error('invalid process pending-read count in state')
	}
	return {
		id: requiredString(value, 'id'),
		actionName: requiredString(value, 'actionName'),
		pendingReads,
		...(stringProperty(value, 'serviceStackId') === undefined ? {} : { serviceStackId: stringProperty(value, 'serviceStackId') }),
		...(stringProperty(value, 'projectId') === undefined ? {} : { projectId: stringProperty(value, 'projectId') }),
		...(stringProperty(value, 'appVersionId') === undefined ? {} : { appVersionId: stringProperty(value, 'appVersionId') }),
	}
}

const ROLE_CODES: readonly RoleCode[] = ['OWNER', 'ADMIN', 'BASIC_USER', 'READ_ONLY', 'NO_ACCESS']

/** A role this double does not know is refused, never silently downgraded. */
export const asRoleCode = (value: unknown, context: string): RoleCode => {
	const roleCode = ROLE_CODES.find((role) => role === value)
	if (roleCode === undefined) {
		throw new Error(`unknown roleCode in ${context}`)
	}
	return roleCode
}

/**
 * One project grant, read the same way from a request body and from the state file.
 *
 * An ABSENT `roleCode` is carried through as absent rather than filled in with the schema's documented
 * `NO_ACCESS` default: the client refuses to guess a grant it was not told about, and a double that
 * invented one would hide exactly that.
 */
export const readGrant = (value: unknown): TokenGrantRecord => {
	const projectId = requiredString(value, 'projectId')
	const raw = property(value, 'roleCode')
	return raw === undefined ? { projectId } : { projectId, roleCode: asRoleCode(raw, `the integration token grant for ${projectId}`) }
}

const readIntegrationTokenRecord = (value: unknown): IntegrationTokenRecord => {
	const projects = property(value, 'projects')
	if (!Array.isArray(projects)) {
		throw new Error('invalid integration token grants in state')
	}
	const roleCode = property(value, 'roleCode')
	return {
		id: requiredString(value, 'id'),
		clientId: requiredString(value, 'clientId'),
		name: requiredString(value, 'name'),
		created: requiredString(value, 'created'),
		lastUpdate: requiredString(value, 'lastUpdate'),
		projects: projects.map(readGrant),
		...(roleCode === undefined ? {} : { roleCode: asRoleCode(roleCode, 'the integration token') }),
	}
}
