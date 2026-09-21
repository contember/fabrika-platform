import type {
	ZeropsAppVersion,
	ZeropsAppVersionStatus,
	ZeropsIntegrationToken,
	ZeropsProcess,
	ZeropsProject,
	ZeropsProjectMode,
	ZeropsProjectStatus,
	ZeropsRoleCode,
	ZeropsService,
	ZeropsServiceEnv,
	ZeropsServiceStatus,
} from './types'

/** Read a property off an unknown value without asserting anything about the value's shape. */
export const prop = (
	value: unknown,
	key: string,
): unknown => (typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined)

export const str = (value: unknown, key: string): string | undefined => {
	const found = prop(value, key)
	return typeof found === 'string' ? found : undefined
}

export const num = (value: unknown, key: string): number | undefined => {
	const found = prop(value, key)
	return typeof found === 'number' ? found : undefined
}

const bool = (value: unknown, key: string): boolean | undefined => {
	const found = prop(value, key)
	return typeof found === 'boolean' ? found : undefined
}

export const arr = (value: unknown, key: string): unknown[] => {
	const found = prop(value, key)
	return Array.isArray(found) ? found : []
}

const stringList = (value: unknown, key: string): string[] | undefined => {
	const found = prop(value, key)
	if (!Array.isArray(found) || found.some((entry) => typeof entry !== 'string')) {
		return undefined
	}
	return found.filter((entry): entry is string => typeof entry === 'string')
}

/** Every valid `ZeropsAppVersionStatus`, in pipeline order. The array's element type keeps it exhaustive. */
const STATUSES: readonly ZeropsAppVersionStatus[] = [
	'UPLOADING',
	'WAITING_TO_BUILD',
	'BUILDING',
	'BUILD_FAILED',
	'BUILD_VALIDATION_FAILED',
	'WAITING_TO_DEPLOY',
	'DEPLOYING',
	'DEPLOY_FAILED',
	'PREPARING_RUNTIME',
	'PREPARING_RUNTIME_FAILED',
	'ACTIVE',
	'BACKUP',
	'CANCELLED',
]

const PROJECT_STATUSES: readonly ZeropsProjectStatus[] = [
	'NEW',
	'CREATING',
	'ACTIVE',
	'DELETING',
	'FAILED',
	'STOPPING',
	'STOPPED',
	'STARTING',
]

const PROJECT_MODES: readonly ZeropsProjectMode[] = ['LIGHT', 'SERIOUS']

const SERVICE_STATUSES: readonly ZeropsServiceStatus[] = [
	'NEW',
	'CREATING',
	'ACTIVE',
	'STOPPING',
	'STOPPED',
	'STARTING',
	'RESTARTING',
	'RELOADING',
	'DELETING',
	'DELETED',
	'FAILED',
	'ACTION_FAILED',
	'UPGRADING',
	'READY_TO_DEPLOY',
	'SERVICE_CREATING',
	'SERVICE_ACTIVE',
	'SERVICE_STOPPING',
	'SERVICE_STOPPED',
	'SERVICE_STARTING',
	'SERVICE_RESTARTING',
	'SERVICE_RELOADING',
	'SERVICE_DELETING',
	'SERVICE_DELETED',
	'SERVICE_FAILED',
	'SERVICE_ACTION_FAILED',
	'SERVICE_REPAIRING',
	'SERVICE_CONTAINER_FAILED',
	'SERVICE_MOVING_CONTAINER',
	'SERVICE_UPGRADING',
	'SERVICE_SCALING',
	'SERVICE_REPAIR_FAILED',
	'REPAIRING',
	'CONTAINER_FAILED',
	'MOVING_CONTAINER',
	'SCALING',
	'REPAIR_FAILED',
]

/**
 * Narrow a wire string to a known status. `undefined` means Zerops sent something this build does not
 * know — which the poll loop must treat as "keep waiting", never as success or failure.
 */
export const asAppVersionStatus = (value: unknown): ZeropsAppVersionStatus | undefined => STATUSES.find((status) => status === value)

const asProjectStatus = (value: unknown): ZeropsProjectStatus | undefined => PROJECT_STATUSES.find((status) => status === value)

const asProjectMode = (value: unknown): ZeropsProjectMode | undefined => PROJECT_MODES.find((mode) => mode === value)

const asServiceStatus = (value: unknown): ZeropsServiceStatus | undefined => SERVICE_STATUSES.find((status) => status === value)

export const readAppVersion = (value: unknown): ZeropsAppVersion => ({
	id: str(value, 'id') ?? '',
	status: asAppVersionStatus(prop(value, 'status')),
	serviceStackId: str(value, 'serviceStackId'),
	projectId: str(value, 'projectId'),
	sequence: num(value, 'sequence'),
	build: typeof prop(value, 'build') === 'object' && prop(value, 'build') !== null
		? {
			startDate: str(prop(value, 'build'), 'startDate'),
			endDate: str(prop(value, 'build'), 'endDate'),
			pipelineStart: str(prop(value, 'build'), 'pipelineStart'),
			pipelineFinish: str(prop(value, 'build'), 'pipelineFinish'),
			pipelineFailed: str(prop(value, 'build'), 'pipelineFailed'),
		}
		: undefined,
})

export const readProcess = (value: unknown): ZeropsProcess => ({
	id: str(value, 'id') ?? '',
	status: str(value, 'status'),
	actionName: str(value, 'actionName'),
	serviceStackId: str(value, 'serviceStackId'),
	appVersionId: str(prop(value, 'appVersion'), 'id'),
})

export const readService = (value: unknown): ZeropsService => ({
	id: str(value, 'id') ?? '',
	name: str(value, 'name') ?? '',
	projectId: str(value, 'projectId'),
	status: asServiceStatus(prop(value, 'status')),
	base: str(value, 'base'),
	activeAppVersionId: str(prop(value, 'activeAppVersion'), 'id'),
	...(bool(value, 'subdomainAccess') !== undefined ? { subdomainAccess: bool(value, 'subdomainAccess') } : {}),
	...(str(value, 'autoscalingProfileId') !== undefined ? { autoscalingProfileId: str(value, 'autoscalingProfileId') } : {}),
})

export const readProject = (value: unknown): ZeropsProject => ({
	id: str(value, 'id') ?? '',
	name: str(value, 'name') ?? '',
	status: asProjectStatus(prop(value, 'status')),
	mode: asProjectMode(prop(value, 'mode')),
	...(str(value, 'description') !== undefined ? { description: str(value, 'description') } : {}),
	...(stringList(value, 'tagList') !== undefined ? { tagList: stringList(value, 'tagList') } : {}),
})

const ROLE_CODES: readonly ZeropsRoleCode[] = ['OWNER', 'ADMIN', 'BASIC_USER', 'READ_ONLY', 'NO_ACCESS']

/** `undefined` means Zerops sent a role this build does not know — reported as absent, never as a guess. */
const asRoleCode = (value: unknown): ZeropsRoleCode | undefined => ROLE_CODES.find((role) => role === value)

export const readIntegrationToken = (value: unknown): ZeropsIntegrationToken => ({
	id: str(value, 'id') ?? '',
	name: str(value, 'name') ?? '',
	token: str(value, 'token') ?? '',
	projects: arr(value, 'projects').map((entry) => ({
		projectId: str(entry, 'projectId') ?? '',
		roleCode: asRoleCode(prop(entry, 'roleCode')),
	})),
	roleCode: asRoleCode(prop(value, 'roleCode')),
})

export const readServiceEnv = (value: unknown): ZeropsServiceEnv => ({
	id: str(value, 'id') ?? '',
	key: str(value, 'key') ?? '',
	content: str(value, 'content') ?? '',
	serviceStackId: str(value, 'serviceStackId'),
	type: str(value, 'type'),
})
