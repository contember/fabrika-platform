/**
 * IAM's membership transport for the composed Notes container (ADR-0022 rule 6): IAM's public origin and the key of
 * `notes@prod`, which the application presents at IAM's `/membership/*` to invite a guest.
 *
 * On a platform, a deploy has Control issue the key through IAM's `membershipKeys.issue` while the approved contract
 * manages members, and write it with the origin as `FABRIKA_IAM_RPC_URL` and `FABRIKA_IAM_RPC_KEY`. Nothing deploys the
 * composed container, so before it starts the local stack makes the same call with Control's own client and the same
 * provisioning key; `followNotesDeploy` then hands it the pair the deploy wrote, as the platform would.
 *
 * The key is a secret. It lives in the ignored `.state/` directory and is never logged.
 */

import { MAX_KEY_LIFETIME_SECONDS } from '@fabrika/auth-core'
import { iamMembershipKeyIssuer, needsMembershipTransport } from '@fabrika/control/membership-transport'
import { notesContract } from 'fabrika-example-zerops/fabrika.config'
import { resolve } from 'node:path'
import { readStateEnv } from './machine-key'
import { LOCAL_NOTES_IAM_APP_ID, STATE_DIR, writeEnv } from './prepare'

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'
const NOTES_MEMBERSHIP_ENV_FILE = 'notes-membership.env'

export const MEMBERSHIP_URL_VARIABLE = 'FABRIKA_IAM_RPC_URL'
export const MEMBERSHIP_KEY_VARIABLE = 'FABRIKA_IAM_RPC_KEY'

/** Replace the transport the composed container starts with; none writes an empty file. */
export const writeNotesMembershipTransport = async (transport: { readonly url: string; readonly key: string } | null): Promise<void> => {
	await writeEnv(
		STATE_DIR,
		NOTES_MEMBERSHIP_ENV_FILE,
		transport === null ? {} : {
			[MEMBERSHIP_URL_VARIABLE]: transport.url,
			[MEMBERSHIP_KEY_VARIABLE]: transport.key,
		},
	)
}

/**
 * Whether IAM's membership transport accepts `key`. An empty `listMembers` call changes nothing: IAM answers 401 for an
 * unknown or expired key before it reads the body, and 400 for the body once the key holds. Anything else throws.
 */
export const membershipKeyAccepted = async (key: string): Promise<boolean> => {
	const response = await fetch(new URL('/membership/listMembers', IAM_ORIGIN), {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: '{}',
		redirect: 'manual',
	})
	if (response.status === 401) return false
	if (response.status === 400) return true
	throw new Error(`IAM answered the membership key check with ${response.status}`)
}

/**
 * Make sure `.state/notes-membership.env` holds a key IAM accepts while the Notes contract manages members. A stored
 * key is kept, because it may be the one a deploy wrote and Control still records: issuing deletes the environment's
 * other keys, so a fresh one would revoke Control's. Called once IAM knows the Notes schema.
 */
export const ensureNotesMembershipKey = async (): Promise<void> => {
	if (!needsMembershipTransport(notesContract)) {
		await writeNotesMembershipTransport(null)
		return
	}
	const path = resolve(STATE_DIR, NOTES_MEMBERSHIP_ENV_FILE)
	const stored = readStateEnv(path, MEMBERSHIP_KEY_VARIABLE)
	if (stored !== null && readStateEnv(path, MEMBERSHIP_URL_VARIABLE) === IAM_ORIGIN && await membershipKeyAccepted(stored)) return
	const provisioningKey = readStateEnv(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	if (provisioningKey === null) {
		throw new Error('FABRIKA_IAM_PROVISIONING_KEY is missing from the generated local credentials')
	}
	const issuer = iamMembershipKeyIssuer({ origin: IAM_ORIGIN, provisioningKey })
	const issued = await issuer.issue({ app: LOCAL_NOTES_IAM_APP_ID, expiresAt: Math.floor(Date.now() / 1000) + MAX_KEY_LIFETIME_SECONDS, keep: null })
	await writeNotesMembershipTransport({ url: IAM_ORIGIN, key: issued.key })
}
