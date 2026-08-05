import { reconcileSchema } from '@fabrika/auth'
import type { SchemaReconciler } from '@fabrika/provider-contract'

/** Default IAM schema reconciler shared by production Cloudflare sessions. */
export const defaultReconcileSchema: SchemaReconciler = (input) =>
	reconcileSchema({
		url: input.url,
		app: input.app,
		schema: input.schema,
		...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
		adminKey: input.adminKey,
		signal: input.signal,
	})
