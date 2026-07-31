import { type AuthContext, ForbiddenError, initRpc, type Middleware, type RpcRouterFor, toErrorResponse, UnauthorizedError } from '@fabrika/app'
import { permits, scopedValues } from '@fabrika/auth-core'
import type { IamAdminRpcContract } from '@fabrika/iam-contract'
import { z } from 'zod'
import type { IamAppContext } from '../app'
import type { AdminContext } from './handlers'
import { adminUseCases } from './handlers'
import { ADMIN_ACTION, extractCredentials, IAM_APP, rejectCrossOrigin, resolveAdmin } from './router'

const t = initRpc<IamAppContext>()
const nonEmpty = z.string().min(1)
const optionalNullableString = z.string().nullable().optional()

const appInput = z.object({ app: nonEmpty })
const principalIdInput = z.object({ id: nonEmpty })
const apiKeyIdInput = z.object({ principalId: nonEmpty })
const shareLinkIdInput = z.object({ id: nonEmpty })
const authorization = {
	roleKey: nonEmpty.optional(),
	permissions: z.array(nonEmpty).optional(),
	scopeType: optionalNullableString,
	scopeValue: optionalNullableString,
	app: optionalNullableString,
	expiresAt: z.number().finite().optional().nullable(),
}
const policy = {
	name: nonEmpty,
	description: z.string().optional(),
	permissions: z.array(nonEmpty),
}
const grantSchema = z.object({ principalId: nonEmpty, ...authorization })
const shareGrantSchema = z.object({
	action: nonEmpty,
	scope: z.object({ type: nonEmpty, value: nonEmpty }).nullable().optional(),
})

export const adminRpcRouter: RpcRouterFor<IamAppContext, IamAdminRpcContract> = t.router({
	me: t.procedure.require(ADMIN_ACTION).query(({ ctx }) => adminUseCases.me(context(ctx))),
	principals: t.router({
		list: t.procedure
			.input(z.object({
				type: z.enum(['user', 'service']).optional(),
				status: z.enum(['invited', 'active', 'disabled']).optional(),
				q: z.string().optional(),
			}))
			.require(ADMIN_ACTION)
			.query(({ ctx, input }) => adminUseCases.listPrincipals(context(ctx), input)),
		get: t.procedure.input(principalIdInput).require(ADMIN_ACTION).query(({ ctx, input }) => adminUseCases.getPrincipal(context(ctx), input)),
		invite: t.procedure
			.input(z.object({ email: nonEmpty }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.invitePrincipal(context(ctx), input)),
		update: t.procedure
			.input(z.object({ id: nonEmpty, disabled: z.boolean() }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.updatePrincipal(context(ctx), input)),
	}),
	grants: t.router({
		create: t.procedure.input(grantSchema).require(ADMIN_ACTION).mutation(({ ctx, input }) => adminUseCases.createGrant(context(ctx), input)),
		delete: t.procedure.input(z.object({ id: nonEmpty })).require(ADMIN_ACTION).mutation(({ ctx, input }) =>
			adminUseCases.deleteGrant(context(ctx), input)
		),
	}),
	apps: t.router({
		list: t.procedure.require(ADMIN_ACTION).query(({ ctx }) => adminUseCases.listApps(context(ctx))),
		getSchema: t.procedure.input(appInput).require(ADMIN_ACTION).query(({ ctx, input }) => adminUseCases.getAppSchema(context(ctx), input)),
	}),
	roles: t.router({
		list: t.procedure
			.input(z.object({ app: optionalNullableString }))
			.require(ADMIN_ACTION)
			.query(({ ctx, input }) => adminUseCases.listRoles(context(ctx), input)),
	}),
	policies: t.router({
		list: t.procedure.input(appInput).require(ADMIN_ACTION).query(({ ctx, input }) => adminUseCases.listPolicies(context(ctx), input)),
		create: t.procedure
			.input(z.object({ app: nonEmpty, policy: z.object({ key: nonEmpty, ...policy }) }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.createPolicy(context(ctx), input)),
		update: t.procedure
			.input(z.object({ app: nonEmpty, key: nonEmpty, policy: z.object(policy) }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.updatePolicy(context(ctx), input)),
		delete: t.procedure
			.input(z.object({ app: nonEmpty, key: nonEmpty }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.deletePolicy(context(ctx), input)),
	}),
	apiKeys: t.router({
		list: t.procedure.require(ADMIN_ACTION).query(({ ctx }) => adminUseCases.listApiKeys(context(ctx))),
		provision: t.procedure
			.input(z.object({ label: nonEmpty, type: z.literal('service'), ...authorization }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.provisionApiKey(context(ctx), input)),
		rotate: t.procedure.input(apiKeyIdInput).require(ADMIN_ACTION).mutation(({ ctx, input }) => adminUseCases.rotateApiKey(context(ctx), input)),
		revoke: t.procedure.input(apiKeyIdInput).require(ADMIN_ACTION).mutation(({ ctx, input }) => adminUseCases.revokeApiKey(context(ctx), input)),
	}),
	shareLinks: t.router({
		list: t.procedure.require(ADMIN_ACTION).query(({ ctx }) => adminUseCases.listShareLinks(context(ctx))),
		issue: t.procedure
			.input(z.object({ grants: z.array(shareGrantSchema), label: z.string().optional(), expiresAt: z.number().finite().optional() }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.createShareLink(context(ctx), input)),
		revoke: t.procedure.input(shareLinkIdInput).require(ADMIN_ACTION).mutation(({ ctx, input }) => adminUseCases.revokeShareLink(context(ctx), input)),
	}),
	audit: t.router({
		list: t.procedure
			.input(z.object({
				resourceType: z.string().optional(),
				resourceId: z.string().optional(),
				principalId: z.string().optional(),
				action: z.string().optional(),
				requestId: z.string().optional(),
				before: z.string().optional(),
				limit: z.number().finite().optional(),
			}))
			.require(ADMIN_ACTION)
			.query(({ ctx, input }) => adminUseCases.listAudit(context(ctx), input)),
		listAuthLog: t.procedure
			.input(z.object({
				principalId: z.string().optional(),
				requestId: z.string().optional(),
				decision: z.enum(['allow', 'deny']).optional(),
				before: z.string().optional(),
				limit: z.number().finite().optional(),
			}))
			.require(ADMIN_ACTION)
			.query(({ ctx, input }) => adminUseCases.listAuthLog(context(ctx), input)),
	}),
})

export const adminRpcAuth: Middleware<IamAppContext> = async (request, ctx, next) => {
	try {
		if (rejectCrossOrigin(request, new URL(request.url)) !== null) {
			return toErrorResponse(new ForbiddenError('cross-origin request rejected'))
		}

		const credentials = extractCredentials(request, ctx.requestId)
		const resolution = await resolveAdmin(ctx.services, ctx.env, credentials)
		if (!resolution.ok) {
			if (resolution.status === 401) {
				const loginUrl = credentials.bearer === null ? createLoginUrl(ctx.services.config.issuer, request) : undefined
				return toErrorResponse(new UnauthorizedError(resolution.reason, loginUrl === undefined ? undefined : { loginUrl }))
			}
			return toErrorResponse(new ForbiddenError(resolution.reason))
		}

		ctx.admin = resolution.admin
		ctx.auth = authContext(resolution.admin)
		const response = await next()
		return response.status >= 500 ? internalError() : response
	} catch {
		console.error('admin RPC request failed')
		return internalError()
	}
}

function authContext(admin: NonNullable<IamAppContext['admin']>): AuthContext {
	return {
		ok: true,
		principal: { id: admin.id, type: admin.type, label: admin.label ?? admin.id },
		can: (action, scope) => permits(admin.permissions, action, scope),
		scopedTo: (action, dimension) => scopedValues(admin.permissions, action, dimension),
		audit: () => Promise.resolve(),
	}
}

function context(ctx: IamAppContext): AdminContext {
	if (ctx.admin === null) throw new UnauthorizedError()
	return {
		services: ctx.services,
		request: ctx.request,
		url: new URL(ctx.request.url),
		admin: ctx.admin,
		app: IAM_APP,
		requestId: ctx.requestId,
		ctx: ctx.exec,
	}
}

function internalError(): Response {
	return Response.json({ error: { type: 'internal', message: 'internal error' } }, { status: 500 })
}

function createLoginUrl(issuer: string, request: Request): string {
	const login = new URL('/auth/login', issuer)
	login.searchParams.set('redirect', new URL(request.url).origin)
	return login.toString()
}
