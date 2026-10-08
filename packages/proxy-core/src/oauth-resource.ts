import { isOAuthResourceUri, parseOAuthScopes } from '@fabrika/auth-core'
import { z } from 'zod'

/** Configuration, not caller-supplied URLs. Resource and metadata stay on the protected app origin. */
export interface OAuthProtectedResource {
	resource: string
	resourceMetadata: string
	authorizationServers: string[]
	scopesSupported: string[]
}

/** RFC 9728 metadata response; metadata publication does not admit requests to the resource. */
export interface OAuthProtectedResourceMetadata {
	resource: string
	authorization_servers: string[]
	scopes_supported: string[]
	bearer_methods_supported: ['header']
}

/** RFC 6750 challenge parameters with RFC 9728 resource metadata discovery. */
export interface OAuthBearerChallenge {
	resource_metadata: string
	error?: 'invalid_token' | 'insufficient_scope'
	scope?: string
}

const METADATA_PATH = '/.well-known/oauth-protected-resource'

export const oauthScopesSchema = z.unknown().transform((value, ctx) => {
	const scopes = parseOAuthScopes(value)
	if (scopes !== null) return scopes
	ctx.addIssue({ code: 'custom', message: 'invalid OAuth scopes', fatal: true })
	return z.NEVER
})

const resourceUriSchema = z.string().refine(isOAuthResourceUri)
const authorizationServerSchema = z.string().refine((server) => isOAuthResourceUri(`${server}/`) && new URL(server).origin === server)

export const oauthProtectedResourceSchema = z.object({
	resource: resourceUriSchema,
	resourceMetadata: resourceUriSchema,
	authorizationServers: z.array(authorizationServerSchema).length(1),
	scopesSupported: oauthScopesSchema,
}).refine(({ resource, resourceMetadata }) => {
	const metadata = new URL(resourceMetadata)
	return new URL(resource).origin === metadata.origin
		&& (metadata.pathname === METADATA_PATH || metadata.pathname.startsWith(`${METADATA_PATH}/`))
}, 'OAuth resource metadata must live on the resource origin') satisfies z.ZodType<OAuthProtectedResource, z.ZodTypeDef, unknown>

export function parseOAuthProtectedResource(value: unknown): OAuthProtectedResource | null {
	const result = oauthProtectedResourceSchema.safeParse(value)
	return result.success ? result.data : null
}

export function oauthProtectedResourceMetadata(config: OAuthProtectedResource): OAuthProtectedResourceMetadata {
	if (parseOAuthProtectedResource(config) === null) throw new Error('Invalid OAuth protected resource config')
	return {
		resource: config.resource,
		authorization_servers: [...config.authorizationServers],
		scopes_supported: [...config.scopesSupported],
		bearer_methods_supported: ['header'],
	}
}

const oauthBearerChallengeSchema = z.object({
	resource_metadata: resourceUriSchema,
	error: z.enum(['invalid_token', 'insufficient_scope']).optional(),
	scope: z.string().refine((scope) => parseOAuthScopes(scope.split(' ')) !== null).optional(),
}).refine((challenge) => challenge.error !== 'insufficient_scope' || challenge.scope !== undefined, 'insufficient_scope needs a scope')

export function parseOAuthBearerChallenge(value: unknown): OAuthBearerChallenge | null {
	const result = oauthBearerChallengeSchema.safeParse(value)
	if (!result.success) return null
	const challenge: OAuthBearerChallenge = { resource_metadata: result.data.resource_metadata }
	if (result.data.error !== undefined) challenge.error = result.data.error
	if (result.data.scope !== undefined) challenge.scope = result.data.scope
	return challenge
}

export function formatOAuthBearerChallenge(value: OAuthBearerChallenge): string {
	const challenge = parseOAuthBearerChallenge(value)
	if (challenge === null) throw new Error('Invalid OAuth bearer challenge')
	const parameters = [`resource_metadata=${JSON.stringify(challenge.resource_metadata)}`]
	if (challenge.error !== undefined) parameters.push(`error=${JSON.stringify(challenge.error)}`)
	if (challenge.scope !== undefined) parameters.push(`scope=${JSON.stringify(challenge.scope)}`)
	return `Bearer ${parameters.join(', ')}`
}
