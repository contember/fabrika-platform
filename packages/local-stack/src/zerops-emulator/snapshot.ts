import { z } from 'zod'
import { localSourceUploadGrantSchema } from '../local-source-contract'
import type { EmulatorSnapshot } from './model'
import { managedRuntimeReferencesSchema } from './runtime-environment'

const text = z.string().optional().catch(undefined)
const flag = z.boolean().optional().catch(undefined)
const strings = z.array(z.string()).optional().catch(undefined)
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
	mode: z.enum(['LIGHT', 'SERIOUS']),
	id: z.string(),
	clientId: z.string(),
	name: z.string(),
	status: z.unknown().transform((): 'ACTIVE' => 'ACTIVE'),
	description: text,
	tagList: strings,
}).transform(({ description, tagList, ...project }) => ({
	...project,
	...(description === undefined ? {} : { description }),
	...(tagList === undefined ? {} : { tagList }),
}))
const serviceSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	name: z.string(),
	status: z.unknown().transform((): 'ACTIVE' => 'ACTIVE'),
	base: text,
	activeAppVersionId: text,
	subdomainAccess: flag,
	autoscalingProfileId: text,
}).transform(({ base, activeAppVersionId, subdomainAccess, autoscalingProfileId, ...service }) => ({
	...service,
	...(base === undefined ? {} : { base }),
	...(activeAppVersionId === undefined ? {} : { activeAppVersionId }),
	...(subdomainAccess === undefined ? {} : { subdomainAccess }),
	...(autoscalingProfileId === undefined ? {} : { autoscalingProfileId }),
}))
const envSchema = z.object({
	id: z.string(),
	serviceStackId: z.string(),
	key: z.string(),
	content: z.string(),
	type: z.unknown().transform((value): 'SECRET' | 'USER' => value === 'USER' ? 'USER' : 'SECRET'),
	sensitive: z.boolean().optional(),
}).transform(({ sensitive, ...env }) => ({ ...env, ...(sensitive === undefined ? {} : { sensitive }) }))
const versionSchema = z.object({
	status: z.enum(['UPLOADING', 'BUILDING', 'ACTIVE', 'BACKUP', 'BUILD_FAILED', 'CANCELLED']),
	hasHttpPorts: z.boolean().optional(),
	managedRuntimeReferences: managedRuntimeReferencesSchema.optional(),
	syntheticFailure: z.literal('LOCAL_MISSING_UPLOAD').optional(),
	// Non-numeric legacy values were ignored; numeric values must still be valid times.
	activateAt: z.number().optional().catch(undefined).pipe(z.number().finite().min(0).optional()),
	id: z.string(),
	serviceStackId: z.string(),
	projectId: z.string(),
	sequence: counter,
}).transform(({ activateAt, hasHttpPorts, managedRuntimeReferences, syntheticFailure, ...version }) => ({
	...version,
	...(activateAt === undefined ? {} : { activateAt }),
	...(hasHttpPorts === undefined ? {} : { hasHttpPorts }),
	...(managedRuntimeReferences === undefined ? {} : { managedRuntimeReferences }),
	...(syntheticFailure === undefined ? {} : { syntheticFailure }),
}))
const processSchema = z.object({
	pendingReads: z.number().int().min(0),
	id: z.string(),
	actionName: z.string(),
	serviceStackId: text,
	projectId: text,
	appVersionId: text,
}).transform(({ serviceStackId, projectId, appVersionId, ...process }) => ({
	...process,
	...(serviceStackId === undefined ? {} : { serviceStackId }),
	...(projectId === undefined ? {} : { projectId }),
	...(appVersionId === undefined ? {} : { appVersionId }),
}))
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
	// Old snapshots predate processes and integration tokens.
	nextIntegrationToken: counter.default(1),
	projects: z.array(projectSchema),
	services: z.array(serviceSchema),
	serviceEnv: z.array(envSchema),
	appVersions: z.array(versionSchema),
	processes: z.array(processSchema).default([]),
	integrationTokens: z.array(tokenSchema).default([]),
	uploadGrants: z.array(localSourceUploadGrantSchema).default([]),
})

export function parseSnapshot(value: unknown): EmulatorSnapshot {
	const parsed = snapshotSchema.safeParse(value)
	if (!parsed.success) {
		const issues = parsed.error.issues
		const envelopeFailure = issues.some((issue) =>
			issue.path.length === 0 || (
				issue.path.length === 1 && issue.path[0] !== 'nextIntegrationToken' && issue.code === 'invalid_type'
			)
		)
		if (envelopeFailure) throw new Error('invalid Zerops emulator state file')
		const issue = issues[0]
		if (issue?.code === 'custom') throw new Error(issue.message)
		const field = issue?.path.at(-1)
		if (issue?.path.length === 1 || field === 'sequence') throw new Error(`invalid state counter ${field}`)
		if (field === 'mode') throw new Error('invalid project mode in state')
		if (field === 'status') throw new Error('invalid app-version status in state')
		if (field === 'activateAt') throw new Error('invalid app-version activation time in state')
		if (field === 'pendingReads') throw new Error('invalid process pending-read count in state')
		if (field === 'projects') throw new Error('invalid integration token grants in state')
		if (field === 'roleCode') throw new Error('unknown roleCode in the integration token')
		throw new Error(`invalid state field ${field}`)
	}
	return parsed.data
}
