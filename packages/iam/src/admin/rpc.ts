import { type AuthContext, ForbiddenError, initRpc, type RpcRouterFor, toErrorResponse, UnauthorizedError } from '@fabrika/app'
import { permits, scopedValues, WORKLOAD_KINDS } from '@fabrika/auth-core'
import { type IamAdminRpcContract, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH_FLOOR } from '@fabrika/iam-contract'
import { installationBrandSchema } from '@fabrika/proxy-core/brand'
import { z } from 'zod'
import type { IamAppContext } from '../app'
import { logError } from '../log'
import { recordAdminAccess, rpcProcedureOf } from './access'
import { grantAppRole, listAdministeredApps, listAppPeople, revokeAppRole } from './app-people'
import { listConnections, revokeConnection } from './connections'
import type { AdminContext } from './handlers'
import { adminUseCases } from './handlers'
import { ADMIN_ACTION, extractCredentials, IAM_APP, resolveAdmin } from './router'
import { administrationOf } from './user-admin'

const t = initRpc<IamAppContext>()
const nonEmpty = z.string().min(1)
const optionalNullableString = z.string().nullable().optional()

const appInput = z.object({ app: nonEmpty })
const pageInput = { before: z.string().optional(), limit: z.number().finite().optional() }
const principalIdInput = z.object({ principalId: nonEmpty })
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

// A procedure without `.require(ADMIN_ACTION)` is open to a user administrator too (ADR-0058): `context` admits only a
// caller with an administration, and the use case applies the user-admin rules (`user-admin.ts`).
export const adminRpcRouter: RpcRouterFor<IamAppContext, IamAdminRpcContract> = t.router({
	me: t.procedure.query(({ ctx }) => adminUseCases.me(context(ctx))),
	principals: t.router({
		list: t.procedure
			.input(
				z.object({
					type: z.enum(['user', 'service']).optional(),
					status: z.enum(['invited', 'active', 'disabled']).optional(),
					q: z.string().optional(),
					...pageInput,
				}).default({}),
			)
			.query(({ ctx, input }) => adminUseCases.listPrincipals(context(ctx), input)),
		get: t.procedure.input(principalIdInput).query(({ ctx, input }) => adminUseCases.getPrincipal(context(ctx), input)),
		invite: t.procedure
			.input(z.object({ email: nonEmpty, affiliation: z.enum(['internal', 'external']).optional() }))
			.mutation(({ ctx, input }) => adminUseCases.invitePrincipal(context(ctx), input)),
		update: t.procedure
			.input(z.object({ principalId: nonEmpty, disabled: z.boolean() }))
			.mutation(({ ctx, input }) => adminUseCases.updatePrincipal(context(ctx), input)),
		promote: t.procedure
			.input(principalIdInput)
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.promotePrincipal(context(ctx), input)),
	}),
	// Revoking a PARENT already cascades to every app session derived from it, so `revoke` is one
	// call and never a sweep — see `SessionRepository.revokeSessionById`.
	sessions: t.router({
		list: t.procedure
			.input(z.object({ principalId: nonEmpty, signInsOnly: z.boolean().optional(), ...pageInput }))
			.query(({ ctx, input }) => adminUseCases.listSessions(context(ctx), input)),
		revoke: t.procedure
			.input(z.object({ id: nonEmpty }))
			.mutation(({ ctx, input }) => adminUseCases.revokeSession(context(ctx), input)),
		revokeAll: t.procedure
			.input(principalIdInput)
			.mutation(({ ctx, input }) => adminUseCases.revokeSessionsForPrincipal(context(ctx), input)),
	}),
	passwords: t.router({
		issueEnrollment: t.procedure
			.input(principalIdInput)
			.mutation(({ ctx, input }) => adminUseCases.issuePasswordEnrollment(context(ctx), input)),
		issueReset: t.procedure
			.input(principalIdInput)
			.mutation(({ ctx, input }) => adminUseCases.issuePasswordReset(context(ctx), input)),
		disable: t.procedure
			.input(principalIdInput)
			.mutation(({ ctx, input }) => adminUseCases.disablePassword(context(ctx), input)),
	}),
	grants: t.router({
		create: t.procedure.input(grantSchema).mutation(({ ctx, input }) => adminUseCases.createGrant(context(ctx), input)),
		update: t.procedure.input(z.object({ id: nonEmpty, ...authorization }).omit({ app: true }))
			.mutation(({ ctx, input }) => adminUseCases.updateGrant(context(ctx), input)),
		delete: t.procedure.input(z.object({ id: nonEmpty })).mutation(({ ctx, input }) => adminUseCases.deleteGrant(context(ctx), input)),
	}),
	apps: t.router({
		list: t.procedure.query(({ ctx }) => adminUseCases.listApps(context(ctx))),
		getSchema: t.procedure.input(appInput).query(({ ctx, input }) => adminUseCases.getAppSchema(context(ctx), input)),
		setReturnOrigins: t.procedure
			.input(z.object({ app: nonEmpty, origins: z.array(nonEmpty) }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.setReturnOrigins(context(ctx), input)),
	}),
	connections: t.router({
		list: t.procedure.input(z.object({ principalId: nonEmpty, ...pageInput })).require(ADMIN_ACTION)
			.query(({ ctx, input }) => listConnections(context(ctx), input)),
		revoke: t.procedure.input(z.object({ id: nonEmpty })).require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => revokeConnection(context(ctx), input)),
	}),
	roles: t.router({
		list: t.procedure
			.input(z.object({ app: optionalNullableString }))
			.query(({ ctx, input }) => adminUseCases.listRoles(context(ctx), input)),
	}),
	policies: t.router({
		list: t.procedure.input(appInput).query(({ ctx, input }) => adminUseCases.listPolicies(context(ctx), input)),
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
		list: t.procedure.input(z.object(pageInput).default({})).require(ADMIN_ACTION).query(({ ctx, input }) =>
			adminUseCases.listApiKeys(context(ctx), input)
		),
		get: t.procedure.input(principalIdInput).require(ADMIN_ACTION).query(({ ctx, input }) => adminUseCases.getApiKey(context(ctx), input)),
		provision: t.procedure
			.input(z.object({ label: nonEmpty, type: z.literal('service'), ...authorization }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.provisionApiKey(context(ctx), input)),
		rotate: t.procedure
			.input(z.object({ principalId: nonEmpty, expiresAt: z.number().finite().nullable().optional() }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.rotateApiKey(context(ctx), input)),
		revoke: t.procedure.input(principalIdInput).require(ADMIN_ACTION).mutation(({ ctx, input }) => adminUseCases.revokeApiKey(context(ctx), input)),
	}),
	workloads: t.router({
		issueKey: t.procedure
			.input(
				z.object({ app: nonEmpty, kind: z.enum(WORKLOAD_KINDS), name: nonEmpty, expiresAt: z.number().int(), keep: nonEmpty.nullable() }),
			)
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.issueWorkloadKey(context(ctx), input)),
		revokeKeys: t.procedure
			.input(z.object({ app: nonEmpty, kind: z.enum(WORKLOAD_KINDS), name: nonEmpty }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.revokeWorkloadKeys(context(ctx), input)),
	}),
	membershipKeys: t.router({
		issue: t.procedure
			.input(z.object({ app: nonEmpty, expiresAt: z.number().int(), keep: nonEmpty.nullable() }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.issueMembershipKey(context(ctx), input)),
	}),
	shareLinks: t.router({
		list: t.procedure
			.input(z.object({ app: nonEmpty.optional(), includeRevoked: z.boolean().optional(), ...pageInput }).default({}))
			.require(ADMIN_ACTION)
			.query(({ ctx, input }) => adminUseCases.listShareLinks(context(ctx), input)),
		issue: t.procedure
			.input(z.object({
				app: nonEmpty,
				grants: z.array(shareGrantSchema),
				label: z.string().optional(),
				expiresAt: z.number().finite(),
			}))
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
				subjectPrincipalId: z.string().optional(),
				action: z.string().optional(),
				changesOnly: z.boolean().optional(),
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
	terminals: t.router({
		list: t.procedure
			.input(z.object(pageInput).default({}))
			.require(ADMIN_ACTION)
			.query(({ ctx, input }) => adminUseCases.listTerminals(context(ctx), input)),
		setProfile: t.procedure
			.input(z.object({
				terminalId: nonEmpty,
				label: z.string(),
				sessionTtl: z.number().int(),
				asserters: z.array(z.object({ app: nonEmpty, ceiling: z.array(nonEmpty) })),
			}))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.setTerminalProfile(context(ctx), input)),
		revoke: t.procedure
			.input(z.object({ terminalId: nonEmpty }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.revokeTerminal(context(ctx), input)),
	}),
	// No `iam.admin` here: each use case authorizes the application's own `members.manage`, held globally there.
	appPeople: t.router({
		apps: t.procedure.query(({ ctx }) => listAdministeredApps(ctx)),
		list: t.procedure.input(z.object({ app: nonEmpty, after: nonEmpty.optional() })).query(({ ctx, input }) => listAppPeople(ctx, input)),
		grant: t.procedure
			.input(z.object({ app: nonEmpty, role: nonEmpty, email: nonEmpty }))
			.mutation(({ ctx, input }) => grantAppRole(ctx, input)),
		revoke: t.procedure
			.input(z.object({ app: nonEmpty, role: nonEmpty, principalId: nonEmpty }))
			.mutation(({ ctx, input }) => revokeAppRole(ctx, input)),
	}),
	// The installation's own setting: `iam.admin` only, also to read it. Control reads it with the provisioning key.
	brand: t.router({
		get: t.procedure.require(ADMIN_ACTION).query(({ ctx }) => adminUseCases.getInstallationBrand(context(ctx))),
		set: t.procedure
			.input(z.object({ brand: installationBrandSchema }))
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.setInstallationBrand(context(ctx), input)),
		clear: t.procedure.require(ADMIN_ACTION).mutation(({ ctx }) => adminUseCases.clearInstallationBrand(context(ctx))),
	}),
	// The installation's own setting too: `iam.admin` only, also to read it. The use case holds it to the runtime's floor.
	passwordPolicy: t.router({
		get: t.procedure.require(ADMIN_ACTION).query(({ ctx }) => adminUseCases.getPasswordPolicy(context(ctx))),
		set: t.procedure
			.input(z.object({ minLength: z.number().int().min(PASSWORD_MIN_LENGTH_FLOOR).max(PASSWORD_MAX_LENGTH) }).strict())
			.require(ADMIN_ACTION)
			.mutation(({ ctx, input }) => adminUseCases.setPasswordPolicy(context(ctx), input)),
	}),
})

/** Resolve the admin behind an `/admin/rpc` request, then run `next` with it on `ctx`; anyone else is refused. */
export const adminRpcAuth = async (request: Request, ctx: IamAppContext, next: () => Promise<Response>): Promise<Response> => {
	try {
		const credentials = extractCredentials(request, ctx.requestId)
		const resolution = await resolveAdmin(ctx.services, ctx.env, credentials)
		if (!resolution.ok) {
			if (resolution.status === 401) {
				const loginUrl = credentials.bearer === null ? createLoginUrl(ctx.services.config.issuer) : undefined
				return toErrorResponse(new UnauthorizedError(resolution.reason, loginUrl === undefined ? undefined : { loginUrl }))
			}
			return toErrorResponse(new ForbiddenError(resolution.reason))
		}

		ctx.admin = resolution.admin
		ctx.auth = authContext(resolution.admin)
		// Every request of an administrator is recorded before it runs, reads included. A caller without an administration
		// reaches no procedure but `appPeople.*`, so it used no privileged access.
		if (administrationOf(resolution.admin) !== null) {
			const access = { method: request.method, route: '/admin/rpc', procedure: await rpcProcedureOf(request) }
			try {
				await recordAdminAccess(ctx.services, resolution.admin, ctx.requestId, access)
			} catch (err) {
				logError('admin access could not be recorded', err)
				return Response.json({ error: { type: 'unavailable', message: 'admin access could not be recorded' } }, { status: 503 })
			}
		}
		return await scrubInternalErrors(await next())
	} catch (err) {
		logError('admin RPC request failed', err)
		return internalError()
	}
}

/**
 * Mask an internal failure before it leaves the admin surface.
 *
 * TWO rules, because there are two ways an internal message can arrive. A 5xx response is replaced
 * outright, as it always was. AND, INDEPENDENTLY OF STATUS, every `type: 'internal'` envelope in the
 * body gets a fixed message — which is the half that was missing: a BATCHED call always answers 200
 * with the per-call errors inside the body, so it returned verbatim what the single-call path
 * carefully hid (CORR-4). `type: 'internal'` is precisely the branch the framework did NOT choose to
 * expose, so a message that reaches it is by definition not one meant for a caller. Structured
 * failures (`forbidden`, `not_found`, `conflict`, `validation`, …) are untouched.
 */
async function scrubInternalErrors(response: Response): Promise<Response> {
	if (response.status >= 500) {
		return internalError()
	}
	if (response.headers.get('content-type')?.includes('application/json') !== true) {
		return response
	}
	let body: unknown
	try {
		body = await response.clone().json()
	} catch {
		return response
	}
	const scrubbed = scrubEnvelope(body)
	return scrubbed === null ? response : Response.json(scrubbed, { status: response.status, headers: response.headers })
}

/** Rewrite every `internal` error in a single or batched envelope; null when nothing changed. */
function scrubEnvelope(body: unknown): unknown {
	if (!isRecord(body)) {
		return null
	}
	const batch = body['batch']
	if (Array.isArray(batch)) {
		let changed = false
		const results = batch.map((entry: unknown) => {
			const masked = maskInternal(entry)
			changed = changed || masked !== null
			return masked ?? entry
		})
		return changed ? { ...body, batch: results } : null
	}
	return maskInternal(body)
}

/** `{ error: { type: 'internal', … } }` → the fixed message; null when the entry needs no change. */
function maskInternal(entry: unknown): unknown {
	if (!isRecord(entry)) {
		return null
	}
	const error = entry['error']
	if (!isRecord(error) || error['type'] !== 'internal' || error['message'] === 'internal error') {
		return null
	}
	return { ...entry, error: { type: 'internal', message: 'internal error' } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object'
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

/** The context of a caller with an administration; anyone else is refused before the use case runs. */
function context(ctx: IamAppContext): AdminContext {
	if (ctx.admin === null) throw new UnauthorizedError()
	const administration = administrationOf(ctx.admin)
	if (administration === null) throw new ForbiddenError('admin permission required')
	return {
		services: ctx.services,
		request: ctx.request,
		url: new URL(ctx.request.url),
		admin: ctx.admin,
		administration,
		app: IAM_APP,
		requestId: ctx.requestId,
		ctx: ctx.exec,
	}
}

function internalError(): Response {
	return Response.json({ error: { type: 'internal', message: 'internal error' } }, { status: 500 })
}

/** No `redirect`: a sign-in that names no destination lands on the installation's landing, not IAM's bare origin. */
function createLoginUrl(issuer: string): string {
	return new URL('/auth/login', issuer).toString()
}
