import { z } from 'zod'
import { localSourceUploadGrantSchema } from '../local-source-contract'
import type { EmulatorSnapshot } from './model'

const counter = z.number().int().min(1)
export const roleCodeSchema = z.enum(['OWNER', 'ADMIN', 'BASIC_USER', 'READ_ONLY', 'NO_ACCESS'])
export const grantSchema = z.object({ projectId: z.string(), roleCode: z.unknown() }).transform((grant, ctx) => {
	if (grant.roleCode === undefined) return { projectId: grant.projectId }
	const role = roleCodeSchema.safeParse(grant.roleCode)
	if (!role.success) {
		ctx.addIssue({ code: 'custom', message: `unknown roleCode in the integration token grant for ${grant.projectId}` })
		return z.NEVER
	}
	return { projectId: grant.projectId, roleCode: role.data }
})

const projectSchema = z.object({
	id: z.string(),
	clientId: z.string(),
	name: z.string(),
	status: z.literal('ACTIVE'),
	mode: z.enum(['LIGHT', 'SERIOUS']),
	description: z.string().optional(),
	tagList: z.array(z.string()).optional(),
})
const serviceSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	name: z.string(),
	status: z.literal('ACTIVE'),
	base: z.string().optional(),
	activeAppVersionId: z.string().optional(),
	subdomainAccess: z.boolean().optional(),
	autoscalingProfileId: z.string().optional(),
})
const envSchema = z.object({
	id: z.string(),
	serviceStackId: z.string(),
	key: z.string(),
	content: z.string(),
	type: z.enum(['SECRET', 'USER', 'ENV']),
	sensitive: z.boolean().optional(),
})
const versionSchema = z.object({
	id: z.string(),
	serviceStackId: z.string(),
	projectId: z.string(),
	status: z.enum(['UPLOADING', 'BUILDING', 'ACTIVE', 'BACKUP', 'BUILD_FAILED', 'CANCELLED']),
	name: z.string().optional(),
	hasHttpPorts: z.boolean().optional(),
	uploadedDescriptorSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
	uploadedProxyManifest: z.string().optional(),
	buildSetup: z.string().optional(),
	runEnvVariables: z.record(z.string()).optional(),
	syntheticFailure: z.literal('LOCAL_MISSING_UPLOAD').optional(),
	sequence: counter,
	activateAt: z.number().finite().min(0).optional(),
})
const processSchema = z.object({
	id: z.string(),
	actionName: z.string(),
	serviceStackId: z.string().optional(),
	projectId: z.string().optional(),
	appVersionId: z.string().optional(),
	pendingReads: z.number().int().min(0),
})
const tokenSchema = z.object({
	id: z.string(),
	clientId: z.string(),
	name: z.string(),
	created: z.string(),
	lastUpdate: z.string(),
	projects: z.array(grantSchema),
	roleCode: roleCodeSchema.optional(),
})
const snapshotSchema = z.object({
	nextProject: counter,
	nextService: counter,
	nextEnv: counter,
	nextVersion: counter,
	nextProcess: counter,
	nextIntegrationToken: counter,
	projects: z.array(projectSchema),
	services: z.array(serviceSchema),
	serviceEnv: z.array(envSchema),
	appVersions: z.array(versionSchema),
	processes: z.array(processSchema),
	integrationTokens: z.array(tokenSchema),
	uploadGrants: z.array(localSourceUploadGrantSchema),
})

export function parseSnapshot(value: unknown): EmulatorSnapshot {
	const parsed = snapshotSchema.safeParse(value)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		throw new Error(`invalid Zerops emulator state at ${issue?.path.join('.') ?? ''}: ${issue?.message ?? ''}; run \`bun run local:reset\``)
	}
	return parsed.data
}
