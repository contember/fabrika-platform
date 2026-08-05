/** IAM vocabulary shared by the Operations runtime and Fabrika's Access schema. */

/**
 * The app id every composition names the Operations HOST by — the Cloudflare proxy Worker's manifest,
 * the shared platform manifest, and `defineApp`. One constant because a shared manifest may not name
 * one app twice, so the two compositions cannot disagree here and stay generalisable.
 */
export const OPERATIONS_APP_ID = 'operations'

export const OPERATIONS_ACTIONS = {
	READ: 'operations.read',
	TRIAGE: 'operations.triage',
	MANAGE: 'operations.manage',
} as const

export type OperationsAction = (typeof OPERATIONS_ACTIONS)[keyof typeof OPERATIONS_ACTIONS]
