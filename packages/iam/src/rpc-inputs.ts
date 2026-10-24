import { z } from 'zod'

const optionalString = z.string().nullish().transform((value) => value ?? undefined)
const scopeSchema = z.object({ type: z.string(), value: z.string() }).nullish()
const grantSchema = z.object({ action: z.string(), scope: scopeSchema }).transform(({ action, scope }) => ({
	action,
	...(scope === undefined ? {} : { scope }),
}))
const serviceSchema = z.object({ label: z.string(), permissions: z.array(z.string()), scope: scopeSchema })
	.transform(({ label, permissions, scope }) => ({ label, permissions, ...(scope === undefined ? {} : { scope }) }))
const caller = { app: z.string(), credential: z.string().nullable(), requestId: z.string() }

// Field order preserves which error the HTTP transport reports first.
export const mintTokenSchema = z.object({ app: z.string(), session: z.string().nullable(), requestId: z.string() }).catch(rejectRpcInput)
export const mintFromKeySchema = z.object({ app: z.string(), key: z.string(), requestId: z.string() }).catch(rejectRpcInput)
export const exchangeAuthCodeSchema = z.object({ app: z.string(), code: z.string(), verifier: z.string(), requestId: z.string() }).catch(
	rejectRpcInput,
)
export const issueKeySchema = z.object({
	service: serviceSchema.nullish().transform((value) => value ?? undefined),
	principalId: optionalString,
	permissions: z.array(grantSchema).nullish().transform((value) => value ?? undefined),
	label: optionalString,
	expiresAt: z.number().finite(),
	...caller,
}).transform(({ app, credential, requestId, service, principalId, permissions, label, expiresAt }) => ({
	app,
	credential,
	requestId,
	...(service === undefined ? {} : { service }),
	...(principalId === undefined ? {} : { principalId }),
	...(permissions === undefined ? {} : { permissions }),
	...(label === undefined ? {} : { label }),
	expiresAt,
})).catch(rejectRpcInput)
export const revokeKeySchema = z.object({ ...caller, id: z.string() }).catch(rejectRpcInput)
export const listPrincipalsSchema = z.object(caller).catch(rejectRpcInput)
export const auditSchema = z.object({
	credentialId: optionalString,
	resourceId: optionalString,
	credential: z.string(),
	requestId: z.string(),
	principalId: z.string().nullable(),
	principalLabel: z.string(),
	action: z.string(),
	resourceType: z.string(),
	diff: z.unknown(),
	metadata: z.unknown(),
}).transform(({ credentialId, resourceId, diff, metadata, ...required }) => ({
	...required,
	...(credentialId === undefined ? {} : { credentialId }),
	...(resourceId === undefined ? {} : { resourceId }),
	...(diff === undefined ? {} : { diff }),
	...(metadata === undefined ? {} : { metadata }),
})).catch(rejectRpcInput)

const memberScopeSchema = z.object({ type: z.string(), value: z.string() })
export const requestDelegationSchema = z.object({ ...caller, endpoint: z.string() }).catch(rejectRpcInput)
export const createScopeSchema = z.object({ ...caller, delegation: z.string(), dimension: z.string() }).catch(rejectRpcInput)
export const assignMemberSchema = z.object({
	...caller,
	delegation: z.string(),
	scope: memberScopeSchema,
	role: z.string(),
	member: z.union([z.object({ principalId: z.string() }).strict(), z.object({ email: z.string() }).strict()]),
	invitation: z.object({ label: z.string().optional(), message: z.string().optional(), resend: z.boolean().optional() }).strict().optional(),
}).catch(rejectRpcInput)
export const revokeMemberSchema = z.object({
	...caller,
	delegation: z.string(),
	scope: memberScopeSchema,
	member: z.union([
		z.object({ principalId: z.string(), role: z.string().nullish().transform((value) => value ?? null) }).strict(),
		z.object({ invitationId: z.string() }).strict(),
	]),
}).catch(rejectRpcInput)
export const listMembersSchema = z.object({ ...caller, scope: memberScopeSchema }).catch(rejectRpcInput)
export const listAppMembersSchema = z.object({ ...caller, after: z.string().optional(), limit: z.number().finite().optional() }).catch(
	rejectRpcInput,
)
export const findMemberSchema = z.object({
	...caller,
	scope: memberScopeSchema,
	principalId: z.string(),
	action: z.string(),
}).catch(rejectRpcInput)
export const issueLinkSchema = z.object({ ...caller, mount: z.string(), chain: z.array(memberScopeSchema), days: z.number().finite() }).catch(
	rejectRpcInput,
)
export const revokeLinkSchema = z.object({ ...caller, id: z.string() }).catch(rejectRpcInput)
export const inspectIdentificationSchema = z.object({ ...caller, id: z.string() }).catch(rejectRpcInput)
export const assertIdentitySchema = z.object({ ...caller, id: z.string(), principalId: z.string() }).catch(rejectRpcInput)
export const cancelIdentificationSchema = z.object({ ...caller, id: z.string() }).catch(rejectRpcInput)

export class RpcInputError extends Error {}

/** Preserve the transport's field-only errors without exposing submitted credentials. */
function rejectRpcInput({ error }: { error: z.ZodError }): never {
	const path = error.issues[0]?.path ?? []
	let field = String(path[0] ?? 'app')
	if (field === 'service' && path[1] === 'scope') field = 'service.scope'
	if (field === 'permissions' && typeof path[1] === 'number') {
		field = path[2] === 'scope' ? 'permissions[].scope' : 'permissions[].action'
	}
	throw new RpcInputError(`invalid or missing field '${field}'`)
}
