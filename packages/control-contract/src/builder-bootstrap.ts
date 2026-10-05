import { z } from 'zod'

export const BUILDER_APPROVAL_STORAGE_KEY = 'fabrika.builder.approval.v1'
export const BUILDER_AUTHORIZE_PATH = '/builder/authorize'

export interface BuilderApprovalState {
	readonly attemptId: string
	readonly approvalVerifier: string
	readonly expiresAt: number
}

export interface BuilderInstallationDiscoveryDto {
	readonly version: 1
	readonly controlOrigin: string
	readonly iamIssuer: string
	readonly provider: string
}

/** Self-contained so the public capture page can embed this exact validator without external assets. */
export function parseBuilderApprovalState(value: unknown, nowSeconds = Math.floor(Date.now() / 1000)): BuilderApprovalState | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
	if (Object.keys(value).length !== 3 || Object.keys(value).some((key) => !['attemptId', 'approvalVerifier', 'expiresAt'].includes(key))) return null
	const attemptId: unknown = Reflect.get(value, 'attemptId')
	const approvalVerifier: unknown = Reflect.get(value, 'approvalVerifier')
	const expiresAt: unknown = Reflect.get(value, 'expiresAt')
	if (typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId)) return null
	if (typeof approvalVerifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(approvalVerifier)) return null
	if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + 600) return null
	return { attemptId, approvalVerifier, expiresAt }
}

/** Accept only a credential-free installation origin, never a redirect or a repository-selected path. */
export function parseBuilderPublicOrigin(value: unknown): string | null {
	if (typeof value !== 'string' || value.length > 2048) return null
	try {
		const url = new URL(value)
		const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '[::1]'
			|| /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname)
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null
		if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
		return url.origin
	} catch {
		return null
	}
}

export function parseBuilderInstallationDiscovery(value: unknown): BuilderInstallationDiscoveryDto | null {
	const result = builderInstallationDiscoverySchema.safeParse(value)
	return result.success ? result.data : null
}

export const builderPublicOriginSchema = z.string().transform((value, ctx) => {
	const origin = parseBuilderPublicOrigin(value)
	if (origin !== null) return origin
	ctx.addIssue({ code: 'custom', message: 'invalid builder public origin' })
	return z.NEVER
})

export const builderInstallationDiscoverySchema = z.preprocess(
	(value) => {
		// Discovery requires four own fields, even when a prototype supplies otherwise valid values.
		if (typeof value === 'object' && value !== null && Object.keys(value).length !== 4) return undefined
		return value
	},
	z.object({
		version: z.literal(1),
		controlOrigin: builderPublicOriginSchema,
		iamIssuer: builderPublicOriginSchema,
		provider: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
	}).strict(),
)
