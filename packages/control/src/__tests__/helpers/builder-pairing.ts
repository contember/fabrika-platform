import { PROXY_TOKEN_HEADER } from '@fabrika/auth'
import type {
	ApproveDeviceAuthorizationInput,
	InspectDeviceAuthorizationInput,
	ListOwnDeviceAuthorizationsInput,
	RevokeKeyInput,
} from '@fabrika/auth-core'
import type { BuilderPairingIam } from '../../api/builder-pairing'
import { rpcRequest as baseRpcRequest } from './rpc'

export const approvalVerifier = 'A'.repeat(43)
export const humanCredential = 'verified-human-credential'

export function pairingRequest(method: string, input: unknown = null, credential = humanCredential): Request {
	const request = baseRpcRequest(method, input)
	request.headers.set(PROXY_TOKEN_HEADER, credential)
	return request
}

export function pairingIam(overrides: Partial<BuilderPairingIam> = {}) {
	const inspected: InspectDeviceAuthorizationInput[] = []
	const approved: ApproveDeviceAuthorizationInput[] = []
	const denied: InspectDeviceAuthorizationInput[] = []
	const listed: ListOwnDeviceAuthorizationsInput[] = []
	const revoked: RevokeKeyInput[] = []
	const iam: BuilderPairingIam = {
		inspectDeviceAuthorization: async (input) => {
			inspected.push(input)
			if (input.approvalVerifier !== approvalVerifier) return { ok: false, reason: 'invalid_attempt' }
			if (input.credential !== humanCredential || input.app !== 'vozka') return { ok: false, reason: 'not_allowed' }
			return {
				ok: true,
				request: {
					attemptId: input.attemptId,
					app: 'vozka',
					label: 'Local builder',
					permissions: ['app.manage', 'deploy.trigger', 'deploy.read'],
					keyLifetimeSeconds: 2592000,
					expiresAt: Math.floor(Date.now() / 1000) + 600,
				},
			}
		},
		approveDeviceAuthorization: async (input) => {
			approved.push(input)
			return {
				ok: true,
				consent: {
					consentId: 'consent',
					app: input.app,
					label: 'Local builder',
					permissions: ['app.manage', 'deploy.trigger', 'deploy.read'],
					scope: input.scope,
					keyExpiresAt: Math.floor(Date.now() / 1000) + 2592000,
				},
			}
		},
		denyDeviceAuthorization: async (input) => {
			denied.push(input)
			return { ok: true }
		},
		listOwnDeviceAuthorizations: async (input) => {
			listed.push(input)
			return { ok: true, items: [], nextCursor: null }
		},
		revokeKey: async (input) => {
			revoked.push(input)
			return { ok: true, revoked: true }
		},
		...overrides,
	}
	return { iam, inspected, approved, denied, listed, revoked }
}
