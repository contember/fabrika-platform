// The one place an application environment's IAM vocabulary and return origins reach IAM (ADR-0011, ADR-0022 rule 6):
// Control writes the APPROVED schema (ADR-0050) under `<app>@<env>` once a run's version is live, before it marks the
// run terminal, whichever provider ran it. IAM replaces the whole vocabulary, so writing it again after a lost lease is
// harmless.

import { reconcileSchema, ReconcileSchemaError } from '@fabrika/auth'
import type { AppSchema } from '@fabrika/auth-core'

export interface IamSchemaPort {
	apply(input: {
		/** The IAM application id, `<app>@<env>`. */
		readonly app: string
		readonly schema: AppSchema
		/** Replaces IAM's registry for the application; absent leaves it alone, and it is never empty. */
		readonly returnOrigins?: readonly string[]
		readonly signal: AbortSignal
	}): Promise<void>
}

/** IAM's admin surface at the installation's issuer, with Control's provisioning key. */
export const iamAdminSchema = (options: { readonly origin: string; readonly provisioningKey?: string }): IamSchemaPort => ({
	apply: (input) =>
		reconcileSchema({
			url: options.origin,
			app: input.app,
			schema: input.schema,
			...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
			...(options.provisioningKey === undefined ? {} : { adminKey: options.provisioningKey }),
			signal: input.signal,
		}),
})

/** IAM did not answer (no response, a 5xx, a 408 or a 429), as opposed to refusing the schema. */
export const isIamUnavailable = (error: unknown): boolean =>
	!(error instanceof ReconcileSchemaError) || error.status >= 500 || error.status === 408 || error.status === 429
