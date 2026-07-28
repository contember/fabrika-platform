// The ONE collaborator ADR-0002 classifies as fully portable: reconciling an app's authz vocabulary into
// propustka talks to the IAM SERVICE, not to a cloud, so both drivers depend on the same interface and the
// same default implementation. It lives here rather than in either driver's bundle so the second driver
// does not import the first one's file to get it.

import { reconcileSchema } from '@fabrika/auth'
import type { AppSchema } from '@fabrika/config'

/** Reconcile one app's authz vocabulary into propustka, authenticated with a `px_` admin bearer. */
export type SchemaReconciler = (input: { url: string; app: string; schema: AppSchema; adminKey?: string }) => Promise<void>

/** The real reconciler: an HTTP `PUT /admin/apps/:app/schema` against the IAM service. */
export const defaultReconcileSchema: SchemaReconciler = (input) =>
	reconcileSchema({ url: input.url, app: input.app, schema: input.schema, adminKey: input.adminKey })
