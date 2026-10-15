import { type AuthContext, PROXY_TOKEN_HEADER } from '@fabrika/auth'
import type { DeviceAuthorizationCaller, DeviceAuthorizationFailure, DeviceAuthorizationRequest, IamRpc } from '@fabrika/auth-core'
import type { BuilderPairingProofRequest, ListOwnBuilderPairingsRequest, RevokeBuilderPairingRequest } from '@fabrika/control-contract'
import { CONTROL_ACTIONS, CONTROL_APP_ID } from '@fabrika/control-contract'
import type { ControlRepositories } from '../db'
import { appScope } from '../iam'
import { fail } from './domain'

export type BuilderPairingIam = Pick<
	IamRpc,
	'inspectDeviceAuthorization' | 'approveDeviceAuthorization' | 'denyDeviceAuthorization' | 'listOwnDeviceAuthorizations' | 'revokeKey'
>

export interface BuilderPairingContext {
	readonly auth: AuthContext
	readonly request: Request
	readonly repositories: ControlRepositories
	readonly iam: BuilderPairingIam
}

export function builderPairingCaller(c: BuilderPairingContext): DeviceAuthorizationCaller {
	if (c.auth.principal?.type !== 'user') fail(403, 'builder pairing requires a human')
	// Forward the same credential Control verified, never a second bearer or a provisioning fallback.
	const credential = c.request.headers.get(PROXY_TOKEN_HEADER)?.trim()
	if (!credential) fail(401, 'authenticated human credential required')
	return { app: CONTROL_APP_ID, credential, requestId: crypto.randomUUID() }
}

export async function inspectBuilderPairing(c: BuilderPairingContext, input: BuilderPairingProofRequest) {
	const result = await c.iam.inspectDeviceAuthorization({ ...builderPairingCaller(c), ...input })
	if (result.ok) assertBuilderRequest(result.request, input.attemptId)
	return result
}

export async function requireBuilderPairingProof(c: BuilderPairingContext, input: BuilderPairingProofRequest): Promise<string> {
	const result = await inspectBuilderPairing(c, input)
	if (!result.ok) refuseDeviceAuthorization(result)
	if (c.auth.principal?.type !== 'user') fail(403, 'builder pairing requires a human')
	return c.auth.principal.id
}

export async function approveBuilderPairing(c: BuilderPairingContext, input: BuilderPairingProofRequest) {
	const creatorId = await requireBuilderPairingProof(c, input)
	const stored = await c.repositories.builderConnections.find(input.attemptId)
	if (stored === null) fail(404, 'builder connection receipt not found')
	if (stored.creatorId !== creatorId) fail(403, 'builder connection receipt belongs to another human')
	return c.iam.approveDeviceAuthorization({ ...builderPairingCaller(c), ...input, scope: appScope(stored.receipt.app.id) })
}

export async function denyBuilderPairing(c: BuilderPairingContext, input: BuilderPairingProofRequest) {
	await requireBuilderPairingProof(c, input)
	return c.iam.denyDeviceAuthorization({ ...builderPairingCaller(c), ...input })
}

export function listOwnBuilderPairings(c: BuilderPairingContext, input: ListOwnBuilderPairingsRequest) {
	return c.iam.listOwnDeviceAuthorizations({ ...builderPairingCaller(c), ...input })
}

export function revokeBuilderPairing(c: BuilderPairingContext, input: RevokeBuilderPairingRequest) {
	return c.iam.revokeKey({ ...builderPairingCaller(c), id: input.credentialId })
}

function assertBuilderRequest(request: DeviceAuthorizationRequest, attemptId: string): void {
	const actions = [CONTROL_ACTIONS.APP_MANAGE, CONTROL_ACTIONS.DEPLOY_TRIGGER, CONTROL_ACTIONS.DEPLOY_READ]
	const now = Math.floor(Date.now() / 1000)
	if (
		request.attemptId !== attemptId || request.app !== CONTROL_APP_ID || request.keyLifetimeSeconds !== 30 * 24 * 60 * 60
		|| request.permissions.length !== actions.length || !actions.every((action) => request.permissions.includes(action))
		|| !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= now || request.expiresAt > now + 600
	) fail(409, 'device authorization does not match the builder protocol')
}

function refuseDeviceAuthorization(result: DeviceAuthorizationFailure): never {
	const status = result.reason === 'invalid_attempt' ? 404 : result.reason === 'invalid_input'
		? 400
		: result.reason === 'not_allowed' || result.reason === 'authority_lost'
		? 403
		: 409
	fail(status, `device authorization refused: ${result.reason}`)
}
