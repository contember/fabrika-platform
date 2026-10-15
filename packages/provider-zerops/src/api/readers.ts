import { z } from 'zod'
import { withoutSensitiveContent } from './service-env-response'
import type {
	ZeropsAppVersion,
	ZeropsAppVersionStatus,
	ZeropsImportResult,
	ZeropsIntegrationToken,
	ZeropsLogAccess,
	ZeropsProcess,
	ZeropsProject,
	ZeropsProjectMode,
	ZeropsProjectStatus,
	ZeropsRoleCode,
	ZeropsService,
	ZeropsServiceAutoscaling,
	ZeropsServiceEnv,
	ZeropsServiceStatus,
	ZeropsUserInfo,
} from './types'

/** Zerops sends `null` for an absent optional field; nothing reads one of these as required, so a malformed one reads as absent. */
const optional = <Schema extends z.ZodTypeAny>(schema: Schema) => schema.optional().catch(undefined)

const nonBlankSchema = z.string().refine((value) => value.trim() !== '')
const idSchema = nonBlankSchema

/** Every valid `ZeropsAppVersionStatus`, in pipeline order. */
const appVersionStatusSchema = z.enum(
	[
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
	] satisfies [ZeropsAppVersionStatus, ...ZeropsAppVersionStatus[]],
)

const projectStatusSchema = z.enum(
	['NEW', 'CREATING', 'ACTIVE', 'DELETING', 'FAILED', 'STOPPING', 'STOPPED', 'STARTING'] satisfies [
		ZeropsProjectStatus,
		...ZeropsProjectStatus[],
	],
)

const projectModeSchema = z.enum(['LIGHT', 'SERIOUS'] satisfies [ZeropsProjectMode, ...ZeropsProjectMode[]])

const serviceStatusSchema = z.enum(
	[
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
	] satisfies [ZeropsServiceStatus, ...ZeropsServiceStatus[]],
)

const roleCodeSchema = z.enum(['OWNER', 'ADMIN', 'BASIC_USER', 'READ_ONLY', 'NO_ACCESS'] satisfies [ZeropsRoleCode, ...ZeropsRoleCode[]])

// Absent or null reads as absent, but a blank id fails the parse: build-and-deploy must not accept `appVersion: { id: '' }`.
const nestedIdSchema = z.object({ id: idSchema }).nullish()

export const appVersionSchema = z.object({
	id: idSchema,
	// Unknown statuses read as absent: the poll loop keeps waiting rather than guessing an outcome.
	status: optional(appVersionStatusSchema),
	serviceStackId: optional(idSchema),
	projectId: optional(idSchema),
	sequence: optional(z.number()),
	build: optional(z.object({
		startDate: optional(z.string()),
		endDate: optional(z.string()),
		pipelineStart: optional(z.string()),
		pipelineFinish: optional(z.string()),
		pipelineFailed: optional(z.string()),
	})),
}) satisfies z.ZodType<ZeropsAppVersion, z.ZodTypeDef, unknown>

export const processSchema = z.object({
	id: idSchema,
	status: optional(z.string()),
	actionName: optional(z.string()),
	serviceStackId: optional(idSchema),
	appVersion: nestedIdSchema,
}).transform(({ appVersion, ...process }): ZeropsProcess => ({ ...process, appVersionId: appVersion?.id }))

const nullableNumber = z.number().nullish().transform((value) => value ?? null)

const scalingResourceSchema = z.object({ cpuCoreCount: nullableNumber, memoryGBytes: nullableNumber, diskGBytes: nullableNumber }).nullish()
	.transform((resource) => resource ?? { cpuCoreCount: null, memoryGBytes: null, diskGBytes: null })

const scalingFreeResourceSchema = z.object({
	cpuCoreCount: nullableNumber,
	cpuCorePercent: nullableNumber,
	memoryGBytes: nullableNumber,
	memoryPercent: nullableNumber,
}).nullish().transform((resource) => resource ?? { cpuCoreCount: null, cpuCorePercent: null, memoryGBytes: null, memoryPercent: null })

/**
 * Strict where `optional` is lenient: the custom autoscaling is sent back whole, so a field read as absent would be
 * reset. One that does not parse makes the whole object absent, and nothing is sent.
 */
const verticalAutoscalingSchema = z.object({
	cpuMode: z.enum(['DEDICATED', 'SHARED']).nullish().transform((value) => value ?? null),
	minResource: scalingResourceSchema,
	maxResource: scalingResourceSchema,
	minFreeResource: scalingFreeResourceSchema,
	startCpuCoreCount: nullableNumber,
	swapEnabled: z.boolean().nullish().transform((value) => value ?? null),
})

const serviceAutoscalingSchema = z.object({
	// A service with no custom vertical autoscaling reads `null` here (measured 2026-10-15): every field inherits.
	verticalAutoscaling: verticalAutoscalingSchema.nullish().transform((vertical) => vertical ?? verticalAutoscalingSchema.parse({})),
	horizontalAutoscaling: z.object({ minContainerCount: nullableNumber, maxContainerCount: nullableNumber }).nullish()
		.transform((horizontal) => horizontal ?? { minContainerCount: null, maxContainerCount: null }),
}).transform(({ verticalAutoscaling, horizontalAutoscaling }): ZeropsServiceAutoscaling => ({
	vertical: verticalAutoscaling,
	horizontal: horizontalAutoscaling,
}))

export const serviceSchema = z.object({
	id: idSchema,
	name: z.string(),
	projectId: optional(idSchema),
	status: optional(serviceStatusSchema),
	base: optional(z.string()),
	activeAppVersion: nestedIdSchema,
	subdomainAccess: optional(z.boolean()),
	autoscalingProfileId: optional(z.string()),
	customAutoscaling: optional(serviceAutoscalingSchema),
	currentAutoscaling: optional(serviceAutoscalingSchema),
}).transform(({ activeAppVersion, ...service }): ZeropsService => ({ ...service, activeAppVersionId: activeAppVersion?.id }))

export const projectSchema = z.object({
	id: idSchema,
	name: z.string(),
	status: optional(projectStatusSchema),
	mode: optional(projectModeSchema),
	description: optional(z.string()),
	tagList: optional(z.array(z.string())),
}) satisfies z.ZodType<ZeropsProject, z.ZodTypeDef, unknown>

export const integrationTokenSchema = z.object({
	id: idSchema,
	name: z.string(),
	token: nonBlankSchema,
	// An unknown role reads as absent, never as a guess.
	projects: z.array(z.object({ projectId: idSchema, roleCode: optional(roleCodeSchema) })),
	roleCode: optional(roleCodeSchema),
}) satisfies z.ZodType<ZeropsIntegrationToken, z.ZodTypeDef, unknown>

export const userInfoSchema = z.object({
	id: idSchema,
	email: z.string(),
}) satisfies z.ZodType<ZeropsUserInfo, z.ZodTypeDef, unknown>

export const serviceEnvSchema = z.object({
	id: idSchema,
	key: nonBlankSchema,
	content: z.string(),
	serviceStackId: optional(idSchema),
	type: optional(z.string()),
	sensitive: z.boolean(),
}).transform(withoutSensitiveContent) satisfies z.ZodType<ZeropsServiceEnv, z.ZodTypeDef, unknown>

export const importResultSchema = z.object({
	projectId: idSchema,
	projectName: optional(z.string()),
	serviceStacks: z.array(z.object({ id: idSchema, name: z.string(), processes: z.array(processSchema) })),
}).transform(({ serviceStacks, ...result }): ZeropsImportResult => ({ ...result, services: serviceStacks }))

export const logAccessSchema = z.object({
	url: z.string(),
	urlPlain: z.string(),
	urlInfo: z.string(),
	urlUi: z.string(),
	accessToken: z.string(),
	expiration: z.string(),
}) satisfies z.ZodType<ZeropsLogAccess, z.ZodTypeDef, unknown>

/** Parse a response, never echoing it: an issue can quote the value it rejected, and these carry credentials. */
export const readResponse = <Output>(label: string, schema: z.ZodType<Output, z.ZodTypeDef, unknown>, value: unknown): Output => {
	const result = schema.safeParse(value)
	if (!result.success) {
		throw new Error(`zerops: ${label} returned an invalid response`)
	}
	return result.data
}

export const appVersionListSchema = z.object({ list: z.array(appVersionSchema) })
export const projectMatchesSchema = z.object({ projects: z.array(projectSchema) })
