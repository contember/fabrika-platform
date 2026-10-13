// A person of the Notes example who signs in by password, set up through IAM's admin surface for
// `tests/browser/notes-password-sign-in-and-reset.test.ts`. The composition has no e-mail sender, so IAM answers an
// administrator's enrollment or reset with the link itself (manual delivery); the link is a secret and never printed.

import { resolve } from 'node:path'
import { z } from 'zod'
import { envValue, requestJson } from './notes-deploy'
import { LOCAL_NOTES_IAM_APP_ID, STATE_DIR } from './prepare'
import { rpcResponseSchema } from './response-schemas'

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'

const principalSchema = z.object({ id: z.string().min(1) })
const manualDeliverySchema = z.object({ delivery: z.literal('manual'), url: z.string().url() })

export interface PasswordPerson {
	readonly principalId: string
	readonly email: string
}

async function adminRpc(method: string, input: unknown): Promise<unknown> {
	const provisioningKey = envValue(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	return rpcResponseSchema.parse(await requestJson(IAM_ORIGIN, '/admin/rpc', { bearer: provisioningKey, body: { method, input } })).result
}

/** An internal user who may read Notes and has no password yet. */
export async function createPasswordPerson(email: string): Promise<PasswordPerson> {
	const principal = principalSchema.parse(await adminRpc('principals.invite', { email }))
	await adminRpc('grants.create', { principalId: principal.id, app: LOCAL_NOTES_IAM_APP_ID, roleKey: 'reader' })
	return { principalId: principal.id, email }
}

/** The one-time link an administrator hands the person over a trusted channel. */
export async function issuePasswordLink(person: PasswordPerson, purpose: 'enrollment' | 'reset'): Promise<string> {
	const method = purpose === 'enrollment' ? 'passwords.issueEnrollment' : 'passwords.issueReset'
	return manualDeliverySchema.parse(await adminRpc(method, { principalId: person.principalId })).url
}
