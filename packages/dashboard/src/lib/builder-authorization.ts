import { BUILDER_APPROVAL_STORAGE_KEY, parseBuilderApprovalState } from '@fabrika/control-contract'
import type {
	BuilderApprovalState,
	BuilderConnectionEnvironmentDto,
	BuilderConnectionReceiptDto,
	BuilderPairingProofRequest,
} from '@fabrika/control-contract'
import { ApiError, type AppDto, type AppEnvDto, type CreateBuilderConnectionReceiptRequest, type DeviceAuthorizationFailure } from './api'
import type { createControlClient } from './api'

export type BuilderClient = ReturnType<typeof createControlClient>
type ApprovalStorage = Pick<Storage, 'getItem' | 'removeItem'>
export type StoredApproval = { ok: true; state: BuilderApprovalState } | { ok: false; message: string }

export const START_AGAIN = 'Start again from your local checkout with fabrika builder connect --url=<console-origin>.'

export function clearBuilderApproval(storage: () => ApprovalStorage): boolean {
	try {
		storage().removeItem(BUILDER_APPROVAL_STORAGE_KEY)
		return true
	} catch {
		return false
	}
}

export function readBuilderApproval(storage: () => ApprovalStorage, nowSeconds?: number): StoredApproval {
	try {
		const raw = storage().getItem(BUILDER_APPROVAL_STORAGE_KEY)
		if (raw === null) return { ok: false, message: `No pending connection in this tab. ${START_AGAIN}` }
		let value: unknown
		try {
			value = JSON.parse(raw)
		} catch {
			value = null
		}
		const state = parseBuilderApprovalState(value, nowSeconds)
		if (state) return { ok: true, state }
		if (!clearBuilderApproval(storage)) {
			return { ok: false, message: `Tab storage is unavailable. Close this tab, allow session storage and start again locally.` }
		}
		return { ok: false, message: `The connection is expired or malformed. ${START_AGAIN}` }
	} catch {
		return { ok: false, message: 'Tab storage is unavailable. Close this tab, allow session storage and start again locally.' }
	}
}

export function approvalProof(state: BuilderApprovalState): BuilderPairingProofRequest {
	return { attemptId: state.attemptId, approvalVerifier: state.approvalVerifier }
}

export function currentBuilderEnvironment(environment: AppEnvDto): BuilderConnectionEnvironmentDto {
	return {
		env: environment.env,
		namespaceId: environment.namespaceId,
		domain: environment.domain,
		publicOrigin: environment.publicOrigin,
		triggerRef: environment.triggerRef,
	}
}

export function pairingFailure(reason: DeviceAuthorizationFailure['reason']): string {
	switch (reason) {
		case 'expired':
			return `The connection expired. ${START_AGAIN}`
		case 'invalid_attempt':
			return `This connection is no longer available. ${START_AGAIN}`
		case 'not_allowed':
			return 'Your current account cannot delegate the required app permissions. Ask the operator to check your existing grants.'
		case 'authority_lost':
			return 'Your authority changed. The connection was refused. Ask the operator to check your app grants.'
		case 'conflict':
			return 'This attempt already has a different decision. Check your local builder and your connections below before starting again.'
		case 'invalid_input':
			return `This request is not a supported builder connection. ${START_AGAIN}`
	}
}

// RPC messages can contain echoed input; consent errors must never render a verifier.
export function builderRequestError(error: unknown, fallback: string): string {
	if (error instanceof ApiError && error.httpStatus === 401) {
		return 'Your login expired. Reload this page to sign in and retry; the pending connection stays in this tab until it expires.'
	}
	if (error instanceof ApiError && error.httpStatus === 403) {
		return 'Permission denied. Ask the operator to check the required permission; no grants were changed.'
	}
	if (error instanceof ApiError && error.httpStatus === 409) {
		return 'The selection conflicts with an existing record. Inspect the existing application or receipt before retrying; nothing is replaced automatically.'
	}
	return fallback
}

export async function approveBuilderSelection(
	client: Pick<BuilderClient, 'builderConnections' | 'builderPairing'>,
	input: CreateBuilderConnectionReceiptRequest,
	onReceipt: (receipt: BuilderConnectionReceiptDto) => void,
	onRejectedWithoutReceipt?: () => void,
) {
	let receipt: BuilderConnectionReceiptDto
	try {
		receipt = await client.builderConnections.createReceipt(input)
	} catch (cause) {
		if (isBuilderWriteConflict(cause) && onRejectedWithoutReceipt) {
			let recovered: BuilderConnectionReceiptDto | null
			try {
				recovered = await client.builderConnections.getReceipt({ attemptId: input.attemptId })
			} catch (lookupError) {
				if (!(lookupError instanceof ApiError && lookupError.httpStatus === 404)) throw lookupError
				recovered = null
			}
			if (recovered) onReceipt(recovered)
			else onRejectedWithoutReceipt()
		}
		throw cause
	}
	onReceipt(receipt)
	return client.builderPairing.approve({ attemptId: input.attemptId, approvalVerifier: input.approvalVerifier })
}

export interface BuilderCreationAttempt {
	readonly appId: string
	readonly rejected: boolean
}

// A network failure may still have a write in flight; a later 404 alone cannot release that lock.
export function isBuilderWriteConflict(cause: unknown): boolean {
	return cause instanceof ApiError && cause.httpStatus === 409
}

export async function recoverBuilderCreation(
	client: Pick<BuilderClient, 'apps'>,
	attempt: BuilderCreationAttempt,
): Promise<{ status: 'found'; app: AppDto } | { status: 'absent' } | { status: 'uncertain' }> {
	try {
		return { status: 'found', app: await client.apps.get({ appId: attempt.appId }) }
	} catch (cause) {
		if (!(cause instanceof ApiError && cause.httpStatus === 404)) throw cause
		return { status: attempt.rejected ? 'absent' : 'uncertain' }
	}
}

export async function loadKnownBuilderApp(client: Pick<BuilderClient, 'apps'>, appId: string) {
	const app = await client.apps.get({ appId })
	const environments = await client.apps.environments.list({ appId: app.id })
	return { app, environments: environments.items }
}

export async function revokeBuilderConnection(client: Pick<BuilderClient, 'builderPairing'>, credentialId: string): Promise<string | null> {
	try {
		const result = await client.builderPairing.revoke({ credentialId })
		if (result.ok) return null
		switch (result.reason) {
			case 'not_found':
				return 'Credential not found. Refresh your connections to check its current state.'
			case 'not_allowed':
				return 'Only the original issuer or an authorized administrator can revoke this credential.'
			default:
				return 'Your account could not be verified. Sign in again and retry revocation.'
		}
	} catch (error) {
		return builderRequestError(error, 'Revocation could not be confirmed. Refresh and retry; do not assume the key was revoked.')
	}
}
