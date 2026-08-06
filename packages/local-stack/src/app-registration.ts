/**
 * Register the local composition's apps with IAM, so a browser can actually be signed in to them.
 *
 * Since [ADR-0023](../../../docs/decisions/0023-one-session-per-host.md) a session reaches an app's
 * host in exactly one way: IAM issues a single-use code for a return address the app has REGISTERED,
 * and the proxy on that host redeems it. An app IAM has no return origin for cannot log anyone in, and
 * says so with a 400 naming the address.
 *
 * In a real installation that registration is one ordinary step of every deploy — `reconcileSchema`
 * with `returnOrigins`, driven by the control plane from `app_envs.public_origin`. Locally nothing
 * deploys fabrika into its own composition, and `notes` is only deployed by `local:smoke`, so this
 * does what a deploy would do, with the same call, the same endpoints and the same admin credential.
 * Nothing here is a local-only mechanism; it is the local stack standing in for the deploy that is
 * absent, exactly as it already does for the machine key.
 *
 * Idempotent: `PUT /admin/apps/:app/schema` upserts and `apps.setReturnOrigins` replaces, so re-running
 * an `up` over a live database is a no-op.
 */

import { reconcileSchema } from '@fabrika/auth'
import type { AppSchema } from '@fabrika/auth-core'
import { controlSchema } from '@fabrika/control/schema'
import { NOTES_APP_ID, notesSchema } from '@fabrika/example-zerops-app/schema'
import { resolve } from 'node:path'
import { readStateEnv } from './machine-key'
import { STATE_DIR } from './prepare'

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'

export interface LocalApp {
	id: string
	schema: AppSchema
	/** Every origin IAM may hand this app a session at — its public address on the local proxy. */
	returnOrigins: readonly string[]
}

/**
 * Every app in the local composition a HUMAN can reach. IAM is absent on purpose: it authenticates on
 * its own host and never needs a code to reach itself.
 *
 * Operations is absent too, and that is not an oversight: its own hostname serves ingest and the
 * source-map upload, both `public`, and every operator surface is reached through the console's
 * same-origin gateway on `vozka`'s host — so no browser is ever handed a session for the Operations
 * host and there is no return origin to register. Moving the operator surface onto that host is what
 * would change it, and what it costs is
 * [backlog 54](../../../docs/backlog/54-give-operations-its-own-proxy-app-identity.md).
 */
export const localApps: readonly LocalApp[] = [
	{ id: 'vozka', schema: controlSchema, returnOrigins: ['http://control.fabrika.localhost:18080'] },
	{ id: NOTES_APP_ID, schema: notesSchema, returnOrigins: ['http://notes.fabrika.localhost:18081'] },
]

export const registerLocalApps = async (): Promise<void> => {
	const adminKey = readStateEnv(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	if (adminKey === null) {
		throw new Error('FABRIKA_IAM_PROVISIONING_KEY is missing from the generated local credentials')
	}
	for (const app of localApps) {
		await reconcileSchema({ url: IAM_ORIGIN, app: app.id, schema: app.schema, returnOrigins: app.returnOrigins, adminKey })
	}
	console.info(`Local apps registered with IAM: ${localApps.map((app) => app.id).join(', ')}`)
}
