import { z } from 'zod'

const optionalString = z.string().nullish().transform((value) => value ?? undefined)
const optionalNumber = z.number().finite().nullish().transform((value) => value ?? undefined)
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
	expiresAt: optionalNumber,
	...caller,
}).transform(({ app, credential, requestId, service, principalId, permissions, label, expiresAt }) => ({
	app,
	credential,
	requestId,
	...(service === undefined ? {} : { service }),
	...(principalId === undefined ? {} : { principalId }),
	...(permissions === undefined ? {} : { permissions }),
	...(label === undefined ? {} : { label }),
	...(expiresAt === undefined ? {} : { expiresAt }),
})).catch(rejectRpcInput)
export const revokeKeySchema = z.object({ ...caller, id: z.string() }).catch(rejectRpcInput)
export const listPrincipalsSchema = z.object(caller).catch(rejectRpcInput)
export const auditSchema = z.object({
	credentialId: optionalString,
	resourceId: optionalString,
	app: z.string(),
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
