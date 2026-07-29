import type { AppSchema } from '@fabrika/auth-core'

/** Inputs needed to reconcile one app's authorization vocabulary into IAM. */
export interface SchemaReconcileInput {
	url: string
	app: string
	schema: AppSchema
	adminKey?: string
}

/** Provider-neutral port for authorization schema reconciliation. */
export type SchemaReconciler = (input: SchemaReconcileInput) => Promise<void>
