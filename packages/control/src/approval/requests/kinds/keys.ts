// The `credentials` kind (ADR-0083 §8): a key for someone else that an agent asks for. The agent sends a public key; an
// IAM installation administrator approves in the console, and IAM issues the key as them and answers it only encrypted
// to that public key. Control keeps the JWE until the requester fetches it once. The key holds exact Control actions at
// one application: actions the requester holds under `credentialCeiling: requester`, and always ones the approver holds.

import { RpcError } from '@fabrika/app'
import type { AuthContext } from '@fabrika/auth'
import { MAX_KEY_LIFETIME_SECONDS } from '@fabrika/auth-core'
import {
	ALL_ENVIRONMENTS,
	type ApprovalRequestText,
	CONTROL_ACTIONS,
	CONTROL_APP_ID,
	CONTROL_GLOBAL_ACTIONS,
	type CredentialCeiling,
	gate,
	recipientPublicKeySchema,
	STRICT_SETTINGS,
} from '@fabrika/control-contract'
import { recipientKeyThumbprint, type RecipientPublicKey } from '@fabrika/iam-contract'
import type { JsonValue } from '@fabrika/provider-contract'
import { z } from 'zod'
import { fail } from '../../../api/domain'
import type { AppEnvRow, ApprovalRequestRow } from '../../../db'
import { appScope } from '../../../iam'
import { keyDeliveryDeadline } from '../deliveries'
import { requestKind, type RequestKindContext, type RequestOutcome } from '../kind'
import { judging, policyOf, reachOf, settingsOf } from '../rules'
import { agentText, appIdField, ownText, timeText } from './shared'

/** Why a key an agent asks for never holds an action of Control, by the action. */
const REFUSED_KEY_ACTIONS: ReadonlyMap<string, string> = new Map([
	[CONTROL_ACTIONS.ACCESS_APPROVE, 'approves access, and an agent never asks for approval rights'],
	...CONTROL_GLOBAL_ACTIONS.map((action): [string, string] => [action, 'held only globally, and a key holds its actions at one application']),
])

/** The actions a key an agent asks for may hold: those of Control held at an application, approval rights aside. */
const KEY_ACTIONS: ReadonlySet<string> = new Set(Object.values(CONTROL_ACTIONS).filter((action) => !REFUSED_KEY_ACTIONS.has(action)))

const actionsField = z
	.array(z.string().min(1))
	.min(1)
	.max(50)
	.superRefine((actions, ctx) => {
		for (const action of actions) {
			const refused = REFUSED_KEY_ACTIONS.get(action)
			if (refused !== undefined) ctx.addIssue({ code: 'custom', message: `${action}: ${refused}` })
		}
		const unknown = actions.filter((action) => !KEY_ACTIONS.has(action) && !REFUSED_KEY_ACTIONS.has(action))
		if (unknown.length > 0) {
			ctx.addIssue({ code: 'custom', message: `${unknown.join(', ')}: not an action of Control; a key holds exact Control actions, no wildcard` })
		}
		if (new Set(actions).size !== actions.length) ctx.addIssue({ code: 'custom', message: 'names an action twice' })
	})

/** What the agent sends. */
const askedKey = z
	.object({
		appId: appIdField,
		/** Who or what the key is for, as the page shows it. */
		label: z.string().min(1).max(200),
		actions: actionsField,
		/** Unix seconds: the key expires then, at most 30 days ahead. */
		expiresAt: z.number().int(),
		publicKey: recipientPublicKeySchema,
	})
	.strict()
type AskedKey = z.infer<typeof askedKey>

/** The public key as the row stores it, parsed without `.strict()` as every stored input is. */
const storedPublicKey = z.union([
	z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string(), y: z.string() }),
	z.object({ kty: z.literal('OKP'), crv: z.literal('X25519'), x: z.string() }),
])

/** What the row stores: the ask, its actions sorted, the key's thumbprint, and which actions exceed the requester's. */
const keyInput = z.object({
	appId: appIdField,
	label: z.string(),
	actions: z.array(z.string()),
	expiresAt: z.number().int(),
	publicKey: storedPublicKey,
	/** The RFC 7638 thumbprint of `publicKey`: the page shows it and the agent prints it beside the link. */
	thumbprint: z.string(),
	/** The actions the requester's own token did not hold at the application when it asked. */
	beyondRequester: z.array(z.string()),
})
type KeyInput = z.infer<typeof keyInput>

/** What an approval binds: whether the ceiling of the environments still admits the actions beyond the requester. */
const keyBefore = z.object({ ceilingAdmits: z.boolean() })
type KeyBefore = z.infer<typeof keyBefore>

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

/**
 * Whether a key agreement with `key` works, as IAM's encryption to it runs one: WebCrypto refuses a P-256 point off the
 * curve when importing it, and an X25519 point of low order only when deriving, since the shared secret is then zero.
 */
async function agreesWith(key: RecipientPublicKey): Promise<boolean> {
	const algorithm = key.kty === 'EC' ? { name: 'ECDH', namedCurve: 'P-256' } : { name: 'X25519' }
	try {
		const recipient = await crypto.subtle.importKey('jwk', { ...key }, algorithm, false, [])
		const ephemeral = await crypto.subtle.generateKey(algorithm, false, ['deriveBits'])
		if (!('privateKey' in ephemeral)) return false
		await crypto.subtle.deriveBits({ name: algorithm.name, public: recipient }, ephemeral.privateKey, 256)
		return true
	} catch {
		return false
	}
}

/** The ceiling the protected environments of the application set together: `requester` where any sets it. */
function ceilingOf(judges: readonly AppEnvRow[]): CredentialCeiling {
	if (judges.length === 0) return STRICT_SETTINGS.credentialCeiling
	return judges.some((appEnv) => settingsOf(appEnv).credentialCeiling === 'requester') ? 'requester' : 'approver'
}

const sorted = (values: readonly string[]): string[] => [...values].sort()

async function ceilingAdmits(c: RequestKindContext, input: KeyInput): Promise<boolean> {
	if (input.beyondRequester.length === 0) return true
	return ceilingOf(judging((await reachOf(c.repositories.registry, { appId: input.appId, env: ALL_ENVIRONMENTS })) ?? [])) === 'approver'
}

/** The key's actions not held by `auth` at the application. */
function notHeld(auth: AuthContext, appId: string, actions: readonly string[]): string[] {
	return actions.filter((action) => !auth.can(action, appScope(appId)))
}

function resultOf(input: KeyInput, principalId: string): JsonValue {
	return {
		key: { principalId, label: input.label, appId: input.appId, actions: input.actions, expiresAt: input.expiresAt, thumbprint: input.thumbprint },
	}
}

function approvalRequestOf(row: ApprovalRequestRow) {
	return {
		id: row.id,
		requester: { id: row.requester_id, label: row.requester_label, ...(row.requester_client_id === null ? {} : { clientId: row.requester_client_id }) },
	}
}

function actionsText(input: KeyInput): ApprovalRequestText {
	const beyond = new Set(input.beyondRequester)
	return ownText(input.actions.map((action) => (beyond.has(action) ? `${action} (beyond the requester)` : action)).join(', '))
}

export const provisionKeyKind = requestKind<KeyInput, KeyBefore, AskedKey>({
	kind: 'iam.apiKeys.provision',
	category: 'credentials',
	input: keyInput,
	before: keyBefore,
	// A key acts at one application, in every environment of it: Control scopes its actions by application.
	coordinates: (input) => ({ appId: input.appId, env: ALL_ENVIRONMENTS }),
	// The agent cannot issue a key itself: asking is all it does.
	requesterAction: CONTROL_ACTIONS.ACCESS_REQUEST,
	requesterAt: 'app',
	asked: {
		schema: askedKey,
		coordinates: (asked) => ({ appId: asked.appId, env: ALL_ENVIRONMENTS }),
		hold: async (c, asked, _requestId, requester) => {
			if (!(await agreesWith(asked.publicKey))) {
				fail(
					400,
					`publicKey: no key agreement works with this ${asked.publicKey.crv} key (a point off the curve or of low order); send the public half of a key pair made for ECDH-ES`,
				)
			}
			const reach = await reachOf(c.repositories.registry, { appId: asked.appId, env: ALL_ENVIRONMENTS })
			if (reach === null) fail(404, 'app not found')
			const judges = judging(reach)
			// Under `off` an agent acts with its own authority, and an agent's credential issues nothing in IAM (ADR-0083 §3).
			if (judges.every((appEnv) => gate({ lines: [], actions: ['credentials'] }, policyOf(appEnv)).kind === 'pass')) {
				fail(
					409,
					`no environment of ${asked.appId} gates a key an agent asks for (credentials: off, or none is protected), so there is no approval to ask `
						+ 'for: an agent issues no key with its own credential, and a person issues one in the console',
				)
			}
			const now = nowSeconds()
			if (asked.expiresAt <= now || asked.expiresAt > now + MAX_KEY_LIFETIME_SECONDS) {
				fail(400, `expiresAt must be in the future and at most ${MAX_KEY_LIFETIME_SECONDS / 86_400} days ahead`)
			}
			const beyond = sorted(notHeld(requester, asked.appId, asked.actions))
			if (beyond.length > 0 && ceilingOf(judges) === 'requester') {
				fail(
					403,
					`a key you ask for holds only actions you hold at ${asked.appId} (credentialCeiling: requester), and you do not hold ${beyond.join(', ')}`,
				)
			}
			return {
				input: {
					appId: asked.appId,
					label: asked.label,
					actions: sorted(asked.actions),
					expiresAt: asked.expiresAt,
					publicKey: asked.publicKey,
					thumbprint: recipientKeyThumbprint(asked.publicKey),
					beyondRequester: beyond,
				},
			}
		},
	},
	// IAM issues a key only to its installation administrators (`iam.admin`), so they alone decide.
	approverMayDecide: async (approver) => (await approver.iamAdministration())?.kind === 'installation',
	refuseApprover: (approver, input) => {
		const missing = notHeld(approver, input.appId, input.actions)
		return missing.length === 0
			? null
			: `approving issues the key as you, and you do not hold ${missing.join(', ')} at ${input.appId} in Control; another person decides it`
	},
	captureBefore: async (c, input) => ({ ceilingAdmits: await ceilingAdmits(c, input) }),
	execute: async (c, input, execution): Promise<RequestOutcome> => {
		const iam = c.iamApprover
		if (iam === undefined) return { state: 'failed', error: 'Control cannot reach IAM with your console session, so no key was issued; ask again' }
		if (input.expiresAt <= nowSeconds()) return { state: 'failed', error: 'the key would already have expired, so none was issued; ask again' }
		const row = await c.repositories.approvalRequests.get(execution.requestId)
		if (row === null) throw new Error('the request is gone')
		let issued: { principalId: string; jwe: string }
		try {
			issued = await iam.provisionRequestedKey({
				label: input.label,
				app: CONTROL_APP_ID,
				permissions: input.actions,
				scopeType: 'app',
				scopeValue: input.appId,
				expiresAt: input.expiresAt,
				recipient: input.publicKey,
				approvalRequest: approvalRequestOf(row),
			})
		} catch (cause) {
			// IAM's refusal of the approver's issuance is an outcome; anything else leaves it for `follow`, by the request id.
			if (cause instanceof RpcError && cause.httpStatus !== undefined && cause.httpStatus >= 400 && cause.httpStatus < 500) {
				return { state: 'failed', error: `IAM refused to issue the key: ${cause.message}` }
			}
			throw cause
		}
		await c.repositories.approvalRequestDeliveries.put({
			requestId: row.id,
			principalId: issued.principalId,
			jwe: issued.jwe,
			deadline: keyDeliveryDeadline(row.deadline, nowSeconds()),
		})
		return { state: 'executed', result: resultOf(input, issued.principalId) }
	},
	follow: async (c, input, execution) => {
		const keys = c.iamKeys
		const row = await c.repositories.approvalRequests.get(execution.requestId)
		if (keys === undefined || row === null) return { state: 'unknown' }
		// IAM issues at most one key per request id, so what it holds under it is this execution's.
		const issued = await keys.requested(row.id)
		if (issued === null) return { state: 'failed', error: 'IAM issued no key under this request, so none was issued; ask again if it is still needed' }
		await c.repositories.approvalRequestDeliveries.put({
			requestId: row.id,
			principalId: issued.principalId,
			jwe: issued.jwe,
			deadline: keyDeliveryDeadline(row.deadline, nowSeconds()),
		})
		return { state: 'executed', result: resultOf(input, issued.principalId) }
	},
	describe: (input, before) => ({
		summary: [
			ownText('Issue a key labelled '),
			agentText(input.label),
			ownText(` holding ${input.actions.join(', ')} at every environment of ${input.appId}, until `),
			timeText(input.expiresAt),
			ownText(', encrypted to the public key of the agent that asks, which fetches it once'),
		],
		facts: [
			{ label: 'Label', value: agentText(input.label) },
			{ label: 'Actions', value: actionsText(input) },
			{ label: 'Expires', value: timeText(input.expiresAt) },
			{ label: 'Thumbprint', value: ownText(input.thumbprint) },
			{ label: 'Encrypted to', value: ownText(`the agent's ${input.publicKey.crv} public key; the agent prints the same thumbprint`) },
			...(before === null || before.ceilingAdmits ? [] : [{
				label: 'Ceiling',
				value: ownText('the application now lets a key hold only actions its requester holds, so approving closes it stale'),
			}]),
		],
		...(input.beyondRequester.length === 0 ? {} : {
			warnings: [
				ownText(
					`The key would hold actions the agent that asks does not hold at ${input.appId}: ${input.beyondRequester.join(', ')}. `
						+ 'Approve only if it should act beyond its own rights.',
				),
			],
		}),
	}),
})
