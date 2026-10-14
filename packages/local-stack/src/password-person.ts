// People of the Notes example who sign in by password, set up through IAM's admin surface for the browser onboarding
// suites in `tests/browser/`. IAM mails every link, and the composition captures the mail (`mail-capture.ts`), so a
// suite reads the link the person would receive. A link is a secret and never printed.

import { resolve } from 'node:path'
import { z } from 'zod'
import { waitForMailLink } from './mail-capture'
import { envValue, requestJson } from './notes-deploy'
import { LOCAL_NOTES_IAM_APP_ID, STATE_DIR } from './prepare'
import { rpcResponseSchema } from './response-schemas'

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'

const principalSchema = z.object({ id: z.string().min(1) })
const emailDeliverySchema = z.object({ delivery: z.literal('email') })
const principalListSchema = z.object({ items: z.array(z.object({ id: z.string().min(1), email: z.string().nullable() })) })
const principalDetailSchema = z.object({
	affiliation: z.enum(['internal', 'external']),
	grants: z.array(
		z.object({ app: z.string().nullable(), roleKey: z.string().nullable(), scopeType: z.string().nullable(), scopeValue: z.string().nullable() }),
	),
})

export interface PasswordPerson {
	readonly principalId: string
	readonly email: string
}

/** A person as IAM holds it: whether it is from outside the organization, and its Notes roles with their workspace. */
export interface NotesPrincipal {
	readonly affiliation: 'internal' | 'external'
	readonly roles: readonly { readonly role: string; readonly workspace: string | null }[]
}

async function adminRpc(method: string, input: unknown): Promise<unknown> {
	const provisioningKey = envValue(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	return rpcResponseSchema.parse(await requestJson(IAM_ORIGIN, '/admin/rpc', { bearer: provisioningKey, body: { method, input } })).result
}

/** An internal user who holds `role` of Notes application-wide and has no password yet. */
export async function createPasswordPerson(email: string, role: 'reader' | 'staff' = 'reader'): Promise<PasswordPerson> {
	const principal = principalSchema.parse(await adminRpc('principals.invite', { email }))
	await adminRpc('grants.create', { principalId: principal.id, app: LOCAL_NOTES_IAM_APP_ID, roleKey: role })
	return { principalId: principal.id, email }
}

/** The one-time link IAM mails the person when an administrator issues an enrollment or a reset. */
export async function issuePasswordLink(person: PasswordPerson, purpose: 'enrollment' | 'reset'): Promise<string> {
	const method = purpose === 'enrollment' ? 'passwords.issueEnrollment' : 'passwords.issueReset'
	const since = Date.now()
	emailDeliverySchema.parse(await adminRpc(method, { principalId: person.principalId }))
	return waitForMailLink({ to: person.email, since })
}

/** The principal IAM holds for `email`, or null when it holds none. */
export async function readNotesPrincipal(email: string): Promise<NotesPrincipal | null> {
	const listed = principalListSchema.parse(await adminRpc('principals.list', { q: email })).items.filter((item) => item.email === email)
	const [principal] = listed
	if (principal === undefined) return null
	if (listed.length > 1) throw new Error('IAM holds more than one principal for one mailbox')
	const detail = principalDetailSchema.parse(await adminRpc('principals.get', { principalId: principal.id }))
	return {
		affiliation: detail.affiliation,
		roles: detail.grants.flatMap((grant) =>
			grant.app === LOCAL_NOTES_IAM_APP_ID && grant.roleKey !== null
				? [{ role: grant.roleKey, workspace: grant.scopeType === 'workspace' ? grant.scopeValue : null }]
				: []
		),
	}
}
