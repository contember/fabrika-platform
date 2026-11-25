// The `agent-grants` kind (ADR-0083 §4, §8): a role at one application environment that an agent asks a person to give,
// to itself or to another principal. IAM writes grants, so Control stores the request and an approval makes the grant as
// the approver's own console grant, through IAM's admin RPC with their console token: IAM checks them as it checks the
// console, and where the application's grants wait it opens its own grant request for a second administrator, which
// the request records and links. Who decides is the application's IAM administration, which IAM answers for the person.

import { RpcError } from '@fabrika/app'
import { appEnvironmentId } from '@fabrika/auth-core'
import { type AccessMapRoleDto, CONTROL_ACTIONS, gate } from '@fabrika/control-contract'
import type { JsonValue } from '@fabrika/provider-contract'
import { z } from 'zod'
import { fail } from '../../../api/domain'
import { accessMap } from '../../access-map'
import { approvedSnapshot } from '../../snapshot'
import { administers, type GrantOutcome, type HeldGrant, heldGrantSchema, type IamGrantsReader, type OpenGrantRequest } from '../iam'
import { requestKind, type RequestKindContext, type RequestOutcome } from '../kind'
import { policyOf } from '../rules'
import { agentText, appIdField, envField, ownText } from './shared'

/** How far ahead an agent may ask a grant to last: as long as a key an agent asks for at most. */
export const AGENT_GRANT_MAX_SECONDS = 30 * 24 * 3600

const grantInput = z.object({
	appId: appIdField,
	env: envField,
	/** The principal the role is for: the agent's own, or another. */
	principalId: z.string().min(1).max(200),
	role: z.string().min(1).max(200),
	/** The value of the role's dimension a membership role is granted in; null for an application-wide role. */
	scope: z.object({ type: z.string().min(1).max(200), value: z.string().min(1).max(200) }).nullable(),
	/** Unix seconds: the grant ends then. */
	expiresAt: z.number().int(),
})
type GrantInput = z.infer<typeof grantInput>

/** The role as the environment's approved contract declares it, in the shape the approval pages show it. */
const roleSchema = z.object({
	role: z.string(),
	scope: z.string().nullable(),
	assignableBy: z.array(z.string()),
	creatorOf: z.array(z.string()),
	external: z.boolean(),
	actions: z.array(z.string()),
	via: z.array(z.object({ relation: z.string(), dimension: z.string(), actions: z.array(z.string()), conferredBy: z.array(z.string()) })),
})

/** What a grant binds: the role's revision in the approved contract, and the principal with its grants at the application now. */
const grantBefore = z.object({
	role: roleSchema.nullable(),
	/** Null when IAM knows no such principal. */
	principal: z.object({ label: z.string(), grants: z.array(heldGrantSchema) }).nullable(),
})
type GrantBefore = z.infer<typeof grantBefore>

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/** The role as the environment's approved contract declares it now; null when it declares none of that name. */
async function roleOf(c: RequestKindContext, input: GrantInput): Promise<AccessMapRoleDto | null> {
	const appEnv = await c.repositories.registry.getAppEnv(input.appId, input.env)
	const contract = appEnv === null ? null : approvedSnapshot(appEnv).snapshot.contract
	return contract === null ? null : (accessMap(contract).roles.find((role) => role.role === input.role) ?? null)
}

function readerOf(c: RequestKindContext): IamGrantsReader {
	return c.iamGrants ?? fail(503, 'Control cannot reach IAM to read the grants a grant request binds; nothing was asked or granted')
}

async function principalOf(c: RequestKindContext, input: GrantInput): Promise<GrantBefore['principal']> {
	const principal = await readerOf(c).principalAt(input.principalId, appEnvironmentId(input.appId, input.env))
	if (principal === null) return null
	// What the request binds, without who made each grant, which `follow` alone reads.
	const grants: HeldGrant[] = principal.grants.map(({ id, roleKey, permissions, scopeType, scopeValues, expiresAt }) => ({
		id,
		roleKey,
		permissions,
		scopeType,
		scopeValues,
		expiresAt,
	}))
	return { label: principal.label, grants: grants.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
}

/** Whether a held grant, or an open grant request, is the one asked for: the role in the same scope value. */
function isAskedGrant(input: GrantInput, grant: Pick<HeldGrant | OpenGrantRequest, 'roleKey' | 'scopeType' | 'scopeValues'>): boolean {
	if (grant.roleKey !== input.role || grant.scopeType !== (input.scope?.type ?? null)) return false
	return input.scope === null ? grant.scopeValues === null : grant.scopeValues?.includes(input.scope.value) === true
}

function resultOf(input: GrantInput, outcome: GrantOutcome): JsonValue {
	const asked = { principalId: input.principalId, role: input.role, app: appEnvironmentId(input.appId, input.env) }
	return outcome.kind === 'granted'
		? { grant: { id: outcome.grantId, ...asked } }
		: { grantRequest: { id: outcome.grantRequestId, status: outcome.status, ...asked } }
}

function scopeText(scope: GrantInput['scope']): string {
	return scope === null ? 'application-wide' : `in ${scope.type} ${scope.value}`
}

function heldText(grant: HeldGrant): string {
	const what = grant.roleKey ?? `actions ${(grant.permissions ?? []).join(', ')}`
	const where = grant.scopeType === null ? '' : ` in ${grant.scopeType} ${(grant.scopeValues ?? []).join(', ')}`
	const until = grant.expiresAt === null ? '' : ` until ${new Date(grant.expiresAt * 1000).toISOString()}`
	return `${what}${where}${until}`
}

export const createGrantKind = requestKind<GrantInput, GrantBefore>({
	kind: 'iam.grants.create',
	category: 'agent-grants',
	input: grantInput,
	before: grantBefore,
	coordinates: (input) => ({ appId: input.appId, env: input.env }),
	// The agent cannot grant in IAM itself: asking is all it does (ADR-0083 §8).
	requesterAction: CONTROL_ACTIONS.ACCESS_REQUEST,
	requesterAt: 'app',
	approverMayDecide: async (approver, coordinates) =>
		administers(await approver.iamAdministration(), appEnvironmentId(coordinates.appId, coordinates.env)),
	admit: async (c, input) => {
		const appEnv = await c.repositories.registry.getAppEnv(input.appId, input.env)
		if (appEnv === null) fail(404, 'app env not found')
		// Under `off` an agent acts with its own authority, and an agent's credential grants nothing in IAM (ADR-0083 §3).
		if (gate({ lines: [], actions: ['agent-grants'] }, policyOf(appEnv)).kind === 'pass') {
			fail(
				409,
				`environment \`${input.env}\` does not gate a grant an agent asks for (agent-grants: off, or the environment is not protected), so there is no `
					+ 'approval to ask for: an agent grants nothing with its own credential, and a person grants in the console',
			)
		}
		const role = await roleOf(c, input)
		if (role === null) {
			fail(
				400,
				`role \`${input.role}\` is not one the approved contract of ${input.appId}@${input.env} declares; an agent asks only for a contract role`,
			)
		}
		if (role.scope === null && input.scope !== null) fail(400, `role \`${role.role}\` is application-wide: ask for it with scope null`)
		if (role.scope !== null && input.scope?.type !== role.scope) {
			fail(400, `role \`${role.role}\` is granted in a value of \`${role.scope}\`: ask for it with scope { type: '${role.scope}', value }`)
		}
		const now = nowSeconds()
		if (input.expiresAt <= now || input.expiresAt > now + AGENT_GRANT_MAX_SECONDS) {
			fail(400, `expiresAt must be in the future and at most ${AGENT_GRANT_MAX_SECONDS / 86_400} days ahead`)
		}
		// A principal IAM does not know is not refused here, which would tell it from a known one; the person deciding sees
		// it, and IAM refuses the grant if it is approved anyway.
	},
	captureBefore: async (c, input) => ({ role: await roleOf(c, input), principal: await principalOf(c, input) }),
	execute: async (c, input, execution): Promise<RequestOutcome> => {
		const iam = c.iamApprover
		if (iam === undefined) return { state: 'failed', error: 'Control cannot reach IAM with your console session, so nothing was granted; ask again' }
		if (input.expiresAt <= nowSeconds()) return { state: 'failed', error: 'the grant would already have expired, so nothing was granted; ask again' }
		const row = await c.repositories.approvalRequests.get(execution.requestId)
		if (row === null) throw new Error('the request is gone')
		try {
			const outcome = await iam.createGrant({
				principalId: input.principalId,
				roleKey: input.role,
				app: appEnvironmentId(input.appId, input.env),
				...(input.scope === null ? {} : { scopeType: input.scope.type, scopeValue: input.scope.value }),
				expiresAt: input.expiresAt,
				approvalRequest: {
					id: row.id,
					requester: {
						id: row.requester_id,
						label: row.requester_label,
						...(row.requester_client_id === null ? {} : { clientId: row.requester_client_id }),
					},
				},
			})
			return { state: 'executed', result: resultOf(input, outcome) }
		} catch (cause) {
			// IAM's refusal of the approver's console grant is an outcome; anything else leaves it for `follow`.
			if (cause instanceof RpcError && cause.httpStatus !== undefined && cause.httpStatus >= 400 && cause.httpStatus < 500) {
				return { state: 'failed', error: `IAM refused the grant: ${cause.message}` }
			}
			throw cause
		}
	},
	follow: async (c, input, execution) => {
		const reader = c.iamGrants
		const row = await c.repositories.approvalRequests.get(execution.requestId)
		if (reader === undefined || row === null) return { state: 'unknown' }
		const app = appEnvironmentId(input.appId, input.env)
		const stored = grantBefore.safeParse(JSON.parse(row.before_json))
		const heldBefore = new Set(stored.success ? (stored.data.principal?.grants ?? []).map((grant) => grant.id) : [])
		// The approver's own new grant: one another person made in the console meanwhile is not this execution's.
		const made = ((await reader.principalAt(input.principalId, app))?.grants ?? []).find((grant) =>
			!heldBefore.has(grant.id) && grant.grantedBy === row.decided_by_id && isAskedGrant(input, grant)
		)
		if (made !== undefined) return { state: 'executed', result: resultOf(input, { kind: 'granted', grantId: made.id }) }
		const requested = (await reader.openGrantRequests(app)).find((request) =>
			request.kind === 'create' && request.principalId === input.principalId && request.requestedBy === row.decided_by_id && isAskedGrant(input, request)
		)
		if (requested !== undefined) {
			return { state: 'executed', result: resultOf(input, { kind: 'requested', grantRequestId: requested.id, status: requested.status }) }
		}
		return {
			state: 'failed',
			error: 'IAM holds neither the grant nor an open grant request for it, so nothing was granted; ask again if it is still needed',
		}
	},
	describe: (input, before) => ({
		summary: [
			ownText('Grant role '),
			agentText(input.role),
			ownText(' to '),
			...(before?.principal === null || before?.principal === undefined ? [agentText(input.principalId)] : [ownText(before.principal.label)]),
			ownText(` at ${input.appId}@${input.env}, ${scopeText(input.scope)}, until ${new Date(input.expiresAt * 1000).toISOString()}`),
		],
		facts: [
			{ label: 'Principal', value: agentText(input.principalId) },
			{ label: 'Scope', value: input.scope === null ? ownText('application-wide') : agentText(`${input.scope.type} ${input.scope.value}`) },
			{ label: 'Expires', value: ownText(new Date(input.expiresAt * 1000).toISOString()) },
			...(before === null ? [] : [
				...(before.role === null ? [{ label: 'Role', value: ownText('the approved contract no longer declares it') }] : []),
				{
					label: 'Holds now',
					value: ownText(
						before.principal === null
							? 'IAM knows no such principal'
							: before.principal.grants.length === 0
							? `nothing at ${input.appId}@${input.env}`
							: before.principal.grants.map(heldText).join('; '),
					),
				},
			]),
		],
		...(before?.role === null || before?.role === undefined ? {} : { role: before.role }),
	}),
})
