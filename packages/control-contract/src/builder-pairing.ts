export type {
	ApproveDeviceAuthorizationResult,
	DenyDeviceAuthorizationResult,
	DeviceAuthorizationFailure,
	DeviceAuthorizationReceipt,
	DeviceAuthorizationRequest,
	InspectDeviceAuthorizationResult,
	ListOwnDeviceAuthorizationsResult,
	RevokeKeyResult,
} from '@fabrika/auth-core'

export interface BuilderPairingProofRequest {
	readonly attemptId: string
	readonly approvalVerifier: string
}

export interface ListOwnBuilderPairingsRequest {
	readonly before?: string
	readonly limit?: number
}

export interface RevokeBuilderPairingRequest {
	readonly credentialId: string
}
