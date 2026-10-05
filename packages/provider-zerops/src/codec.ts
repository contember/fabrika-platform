import type { ProviderCodec } from '@fabrika/provider-contract'
import { z } from 'zod'
import { parseManagedOwner } from './managed-environment/protocol'
import type { ZeropsRuntimeTarget } from './types'

const IMMUTABLE_GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const runtimeSourceSchema = z.object({
	runId: z.string().min(1),
	repository: z.object({ owner: z.string().min(1), name: z.string().min(1) }).strict(),
	commitSha: z.string().regex(IMMUTABLE_GIT_OBJECT),
	githubInstallationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().transform((source) => {
	if (source.githubInstallationId === undefined) delete source.githubInstallationId
	return source
})
const runtimeTargetSchema = z.object({
	projectId: z.string().min(1),
	serviceId: z.string().min(1),
	accessToken: z.string().min(1),
	managedAdmission: z.object({
		owner: z.unknown().transform(parseManagedOwner),
		markerRecordId: z.string().min(1),
	}).strict().optional(),
	source: runtimeSourceSchema.optional(),
	apiBaseUrl: z.string().min(1).optional(),
	propustkaUrl: z.string().min(1).optional(),
	adminKey: z.string().min(1).optional(),
}).strict().refine((target) =>
	target.managedAdmission === undefined || (
		target.managedAdmission.owner.projectId === target.projectId && target.managedAdmission.owner.serviceId === target.serviceId
	), 'Zerops managed admission has different coordinates').transform((target) => {
		for (const key of Object.keys(target)) {
			if (Reflect.get(target, key) === undefined) Reflect.deleteProperty(target, key)
		}
		return target
	})

export const zeropsTargetCodec: ProviderCodec<ZeropsRuntimeTarget> = {
	version: 2,
	encode: (target) => ({
		projectId: target.projectId,
		serviceId: target.serviceId,
		accessToken: target.accessToken,
		...(target.managedAdmission === undefined ? {} : {
			managedAdmission: {
				owner: { ...target.managedAdmission.owner },
				markerRecordId: target.managedAdmission.markerRecordId,
			},
		}),
		...(target.source === undefined
			? {}
			: {
				source: {
					runId: target.source.runId,
					repository: { owner: target.source.repository.owner, name: target.source.repository.name },
					commitSha: target.source.commitSha,
					...(target.source.githubInstallationId === undefined ? {} : { githubInstallationId: target.source.githubInstallationId }),
				},
			}),
		...(target.apiBaseUrl !== undefined ? { apiBaseUrl: target.apiBaseUrl } : {}),
		...(target.propustkaUrl !== undefined ? { propustkaUrl: target.propustkaUrl } : {}),
		...(target.adminKey !== undefined ? { adminKey: target.adminKey } : {}),
	}),
	decode: (payload) => {
		const result = runtimeTargetSchema.safeParse(payload)
		if (result.success) return result.data
		const issue = result.error.issues[0]
		if (issue?.code === 'unrecognized_keys') throw new Error('Zerops target contains an unknown field')
		if (issue?.code === 'custom') throw new Error(issue.message)
		if (issue?.path.join('.') === 'source.commitSha') throw new Error('Zerops target source commitSha must be an exact lowercase Git object id')
		throw new Error(`Zerops target ${issue?.path.join('.') ?? ''} is invalid`)
	},
}
