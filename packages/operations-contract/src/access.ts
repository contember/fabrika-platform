/** IAM vocabulary shared by the Operations runtime and Fabrika's Access schema. */

export const OPERATIONS_ACTIONS = {
	READ: 'operations.read',
	TRIAGE: 'operations.triage',
	MANAGE: 'operations.manage',
} as const

export type OperationsAction = (typeof OPERATIONS_ACTIONS)[keyof typeof OPERATIONS_ACTIONS]
