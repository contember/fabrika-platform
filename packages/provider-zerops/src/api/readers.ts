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

const optionalTextSchema = z.string().optional().catch(undefined)
const textSchema = z.string().catch('')
const optionalNumberSchema = z.union([z.number(), z.nan()]).optional().catch(undefined)
const optionalBooleanSchema = z.boolean().optional().catch(undefined)

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

const buildSchema = z.preprocess(
	(value) =>
		typeof value !== 'object' || value === null ? undefined : {
			startDate: prop(value, 'startDate'),
			endDate: prop(value, 'endDate'),
			pipelineStart: prop(value, 'pipelineStart'),
			pipelineFinish: prop(value, 'pipelineFinish'),
			pipelineFailed: prop(value, 'pipelineFailed'),
		},
	z.object({
		startDate: optionalTextSchema,
		endDate: optionalTextSchema,
		pipelineStart: optionalTextSchema,
		pipelineFinish: optionalTextSchema,
		pipelineFailed: optionalTextSchema,
	}).optional(),
)
const appVersionSchema = z.preprocess(
	(value) => ({
		id: prop(value, 'id'),
		status: prop(value, 'status'),
		serviceStackId: prop(value, 'serviceStackId'),
		projectId: prop(value, 'projectId'),
		sequence: prop(value, 'sequence'),
		build: prop(value, 'build'),
	}),
	z.object({
		id: textSchema,
		status: z.unknown().transform(asAppVersionStatus),
		serviceStackId: optionalTextSchema,
		projectId: optionalTextSchema,
		sequence: optionalNumberSchema,
		build: buildSchema,
	}),
)
export const readAppVersion = (value: unknown): ZeropsAppVersion => appVersionSchema.parse(value)

const processSchema = z.preprocess(
	(value) => ({
		id: prop(value, 'id'),
		status: prop(value, 'status'),
		actionName: prop(value, 'actionName'),
		serviceStackId: prop(value, 'serviceStackId'),
		appVersionId: prop(prop(value, 'appVersion'), 'id'),
	}),
	z.object({
		id: textSchema,
		status: optionalTextSchema,
		actionName: optionalTextSchema,
		serviceStackId: optionalTextSchema,
		appVersionId: optionalTextSchema,
	}),
)
export const readProcess = (value: unknown): ZeropsProcess => processSchema.parse(value)

const serviceSchema = z.preprocess(
	(value) => ({
		id: prop(value, 'id'),
		name: prop(value, 'name'),
		projectId: prop(value, 'projectId'),
		status: prop(value, 'status'),
		base: prop(value, 'base'),
		activeAppVersionId: prop(prop(value, 'activeAppVersion'), 'id'),
		subdomainAccess: prop(value, 'subdomainAccess'),
		autoscalingProfileId: prop(value, 'autoscalingProfileId'),
	}),
	z.object({
		id: textSchema,
		name: textSchema,
		projectId: optionalTextSchema,
		status: z.unknown().transform(asServiceStatus),
		base: optionalTextSchema,
		activeAppVersionId: optionalTextSchema,
		subdomainAccess: optionalBooleanSchema,
		autoscalingProfileId: optionalTextSchema,
	}).transform((service) => {
		if (service.subdomainAccess === undefined) delete service.subdomainAccess
		if (service.autoscalingProfileId === undefined) delete service.autoscalingProfileId
		return service
	}),
)
export const readService = (value: unknown): ZeropsService => serviceSchema.parse(value)

const projectSchema = z.preprocess(
	(value) => ({
		id: prop(value, 'id'),
		name: prop(value, 'name'),
		status: prop(value, 'status'),
		mode: prop(value, 'mode'),
		description: prop(value, 'description'),
		tagList: prop(value, 'tagList'),
	}),
	z.object({
		id: textSchema,
		name: textSchema,
		status: z.unknown().transform(asProjectStatus),
		mode: z.unknown().transform(asProjectMode),
		description: optionalTextSchema,
		tagList: z.array(z.string()).optional().catch(undefined),
	}).transform((project) => {
		if (project.description === undefined) delete project.description
		if (project.tagList === undefined) delete project.tagList
		return project
	}),
)
export const readProject = (value: unknown): ZeropsProject => projectSchema.parse(value)

const ROLE_CODES: readonly ZeropsRoleCode[] = ['OWNER', 'ADMIN', 'BASIC_USER', 'READ_ONLY', 'NO_ACCESS']

/** `undefined` means Zerops sent a role this build does not know — reported as absent, never as a guess. */
const asRoleCode = (value: unknown): ZeropsRoleCode | undefined => ROLE_CODES.find((role) => role === value)

const integrationGrantSchema = z.preprocess(
	(value) => ({ projectId: prop(value, 'projectId'), roleCode: prop(value, 'roleCode') }),
	z.object({ projectId: textSchema, roleCode: z.unknown().transform(asRoleCode) }),
)
const integrationTokenSchema = z.preprocess(
	(value) => ({
		id: prop(value, 'id'),
		name: prop(value, 'name'),
		token: prop(value, 'token'),
		projects: prop(value, 'projects'),
		roleCode: prop(value, 'roleCode'),
	}),
	z.object({
		id: textSchema,
		name: textSchema,
		token: textSchema,
		projects: z.array(integrationGrantSchema).catch([]),
		roleCode: z.unknown().transform(asRoleCode),
	}),
)
export const readIntegrationToken = (value: unknown): ZeropsIntegrationToken => integrationTokenSchema.parse(value)

const serviceEnvSchema = z.preprocess(
	(value) => ({
		id: prop(value, 'id'),
		key: prop(value, 'key'),
		content: prop(value, 'content'),
		serviceStackId: prop(value, 'serviceStackId'),
		type: prop(value, 'type'),
		sensitive: prop(value, 'sensitive'),
	}),
	z.object({
		id: textSchema,
		key: textSchema,
		content: textSchema,
		serviceStackId: optionalTextSchema,
		type: optionalTextSchema,
		sensitive: optionalBooleanSchema,
	}).transform((entry) => {
		if (entry.sensitive === undefined) delete entry.sensitive
		return entry
	}),
)
export const readServiceEnv = (value: unknown): ZeropsServiceEnv => serviceEnvSchema.parse(value)
import { z } from 'zod'
