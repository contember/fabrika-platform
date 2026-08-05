import type { AppSchema } from '@fabrika/auth-core'

/** Inputs needed to reconcile one app's authorization vocabulary into IAM. */
export interface SchemaReconcileInput {
	url: string
	app: string
	schema: AppSchema
	/**
	 * Every origin IAM may hand this app a session at, as known by the control plane. Omitted leaves
	 * IAM's registry alone; a supplied set replaces it. It travels beside the schema and never inside
	 * it — an app declares its vocabulary, the control plane declares where the app lives.
	 */
	returnOrigins?: readonly string[]
	adminKey?: string
	signal: AbortSignal
}

/** Provider-neutral port for authorization schema reconciliation. */
export type SchemaReconciler = (input: SchemaReconcileInput) => Promise<void>
