import { SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { handleAuth } from '../auth/routes'
import type { IamRepositories } from '../db'
import { assignMember, createScope, requestDelegation } from '../membership'
import type { PasswordHasher, StoredPasswordHash } from '../password-crypto'
import { createHarness, type Harness, TestSqlDatabase } from './helpers/harness'
import {
	APP,
	BetweenCheckAndWrite,
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	type MembershipFixture,
	membershipFixture,
	ONBOARDING_SCHEMA,
	ORIGIN,
	type Person,
	reconcilesBetween,
} from './helpers/membership'

// One e-mail onboards a person IAM does not know (D3 of the external-people sprint): an invitation to a role declared
// external, for a mailbox no principal holds, creates the external principal with the password its owner chooses at
// acceptance — in one transaction with the grant, the consumed invitation and their records — and signs it in.

const PASSWORD = 'a sufficiently long passphrase'
const LANDING = 'https://notes.example.com'
const NEWCOMER = 'newcomer@partner.test'

class PlainHasher implements PasswordHasher {
	async hash(password: string): Promise<StoredPasswordHash> {
		return { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: `hash:${password}` }
	}

	async verify(password: string, stored: StoredPasswordHash) {
		return { valid: stored.passwordHash === `hash:${password}`, needsRehash: false }
	}
}

interface Onboarding {
	readonly h: Harness
	readonly f: MembershipFixture
	readonly email: CapturingEmail
	readonly owner: Person
	readonly scope: { type: string; value: string }
	/** Its membership repository: `between` runs a change after an acceptance's check and before its write. */
	readonly membership: BetweenCheckAndWrite
	invite(
		address: string,
		options?: { role?: string; label?: string; message?: string; resend?: boolean; by?: Person },
	): ReturnType<typeof assignMember>
	send(request: Request): Promise<Response>
}

let seq = 0

async function onboarding(options: {
	password?: boolean
	human?: { emailDomains?: readonly string[]; emails?: readonly string[] }
	bootstrapAdmins?: ReadonlySet<string>
} = {}): Promise<Onboarding> {
	const h = createHarness()
	const membership = new BetweenCheckAndWrite(new TestSqlDatabase(h.sqlite))
	const repositories: IamRepositories = { ...h.repositories, membership }
	const email = new CapturingEmail()
	const f = await membershipFixture(repositories, {
		email,
		services: {
			authentication: { oidc: true, password: options.password ?? true },
			passwordHasher: new PlainHasher(),
			human: options.human ?? { emailDomains: ['org.test'], emails: ['named@partner.test', '*'] },
			bootstrapAdmins: options.bootstrapAdmins ?? new Set(['boss@partner.test']),
		},
	})
	expect((await f.putSchema(ONBOARDING_SCHEMA)).status).toBe(200)
	await f.repositories.handoff.setReturnOrigins(APP, [LANDING])
	const owner = await f.person('owner')
	await f.repositories.grants.createGrant({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const delegated = async (person: Person, endpoint: string) => {
		seq += 1
		const base = { app: APP, credential: await person.token(), requestId: `req-${seq}` }
		const grant = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...base, endpoint })
		if (!grant.ok) throw new Error(`no delegation: ${grant.reason}`)
		return { ...base, delegation: grant.grant }
	}
	const created = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(owner, CREATE_ENDPOINT)), dimension: 'workspace' })
	if (!created.ok) throw new Error('no workspace')
	return {
		h,
		f,
		email,
		owner,
		scope: created.scope,
		membership,
		invite: async (address, invite = {}) => {
			const { role = 'partner', by = owner, ...wording } = invite
			return assignMember(f.services, CALLER_ENV, f.ctx, {
				...(await delegated(by, INVITE_ENDPOINT)),
				scope: created.scope,
				role,
				member: { email: address },
				...(Object.keys(wording).length === 0 ? {} : { invitation: wording }),
			})
		},
		send: (request) => handleAuth(request, f.services, CALLER_ENV, f.ctx),
	}
}

function accept(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}/auth/invitations/accept?app=${encodeURIComponent(APP)}`, {
		method: 'POST',
		headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams(fields),
	})
}

async function auditActions(o: Onboarding): Promise<string[]> {
	return (await o.f.repositories.audit.listAuditEvents({ limit: 100 })).map((item) => item.action)
}

describe('an invitation that creates its principal', () => {
	test("a scanner's GET and the accept button change nothing; the button answers the set-password form", async () => {
		const o = await onboarding()
		expect(await o.invite(NEWCOMER)).toMatchObject({ ok: true })
		const token = o.email.lastToken()

		const page = await o.send(new Request(`${ORIGIN}/auth/invitations/accept?app=${encodeURIComponent(APP)}`))
		expect(page.status).toBe(200)
		const form = await o.send(accept({ token }))
		expect(form.status).toBe(200)
		const html = await form.text()
		expect(html).toContain('name="password"')
		expect(html).toContain(`value="${token}"`)
		expect(form.headers.get('content-security-policy')).toContain(`form-action 'self' ${LANDING}`)

		expect(await o.f.repositories.principals.getUserByEmail(NEWCOMER)).toBeNull()
		const [open] = await o.f.repositories.membership.listOpenInvitations(APP, o.scope)
		expect(open?.accepted_at).toBeNull()
	})

	test('accepting creates an external principal with the password, the grant and the records, and lands in the app', async () => {
		const o = await onboarding()
		await o.invite(NEWCOMER)
		const token = o.email.lastToken()

		const response = await o.send(accept({ token, password: PASSWORD }))
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(`${LANDING}/`)
		expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`)

		const principal = await o.f.repositories.principals.getUserByEmail(NEWCOMER)
		expect(principal).toMatchObject({ affiliation: 'external', label: NEWCOMER, external_id: null, disabled_at: null })
		expect(principal?.activated_at).not.toBeNull()
		if (principal === null) throw new Error('no principal')
		expect((await o.f.repositories.membership.listRoleGrantsAt(APP, principal.id, o.scope)).map((grant) => grant.role_key)).toEqual(['partner'])
		const login = await o.f.repositories.passwords.lookupLogin(NEWCOMER)
		expect(login.status).toBe('found')
		expect(await auditActions(o)).toEqual(expect.arrayContaining(['iam.principal.create', 'iam.member.accept', 'iam.password.enrollment.complete']))
		const logins = await o.f.repositories.audit.listAuthLog({ limit: 10 })
		expect(logins.some((row) => row.principal_id === principal.id && row.reason === 'invitation_enrollment' && row.decision === 'allow')).toBe(true)

		expect((await o.send(accept({ token, password: PASSWORD }))).status).toBe(400)
		expect(o.h.sqlite.query('SELECT id FROM principals WHERE email = ?').all(NEWCOMER)).toHaveLength(1)
	})

	test('a password the policy refuses answers the form again and creates nothing', async () => {
		const o = await onboarding()
		await o.invite(NEWCOMER)
		const response = await o.send(accept({ token: o.email.lastToken(), password: 'short' }))
		expect(response.status).toBe(400)
		expect(await response.text()).toContain('name="password"')
		expect(await o.f.repositories.principals.getUserByEmail(NEWCOMER)).toBeNull()
	})

	test('a resent link invalidates the old one and restarts the seven days; a plain repeat sends nothing', async () => {
		const o = await onboarding()
		const first = await o.invite(NEWCOMER)
		const oldToken = o.email.lastToken()
		expect(await o.invite(NEWCOMER)).toEqual(first)
		expect(o.email.messages).toHaveLength(1)

		o.h.sqlite.query('UPDATE membership_invitations SET expires_at = expires_at - 3600').run()
		const resent = await o.invite(NEWCOMER, { resend: true })
		expect(o.email.messages).toHaveLength(2)
		if (!first.ok || !('invited' in first) || !resent.ok || !('invited' in resent)) throw new Error('expected invitations')
		expect(resent.invited.invitationId).toBe(first.invited.invitationId)
		expect(resent.invited.expiresAt).toBeGreaterThan(first.invited.expiresAt - 3600)
		const newToken = o.email.lastToken()
		expect(newToken).not.toBe(oldToken)

		expect((await o.send(accept({ token: oldToken }))).status).toBe(400)
		expect((await o.send(accept({ token: oldToken, password: PASSWORD }))).status).toBe(400)
		expect(await o.f.repositories.principals.getUserByEmail(NEWCOMER)).toBeNull()
		expect((await o.send(accept({ token: newToken, password: PASSWORD }))).status).toBe(302)
		expect(await auditActions(o)).toContain('iam.member.reinvite')
	})

	test('the inviter losing its authority before acceptance refuses it and creates nothing', async () => {
		const o = await onboarding()
		const staff = await o.f.person('staff')
		const staffGrant = await o.f.repositories.grants.createGrant({ principalId: staff.id, app: APP, roleKey: 'staff' })
		expect(await o.invite(NEWCOMER, { by: staff })).toMatchObject({ ok: true })
		await o.f.repositories.grants.deleteGrant(staffGrant.id)

		const response = await o.send(accept({ token: o.email.lastToken(), password: PASSWORD }))
		expect(response.status).toBe(403)
		expect(await o.f.repositories.principals.getUserByEmail(NEWCOMER)).toBeNull()
		expect(await o.f.repositories.membership.listOpenInvitations(APP, o.scope)).toHaveLength(1)
	})

	test("the inviter's removal between the check and the write creates nothing either", async () => {
		const o = await onboarding()
		const staff = await o.f.person('staff')
		const staffGrant = await o.f.repositories.grants.createGrant({ principalId: staff.id, app: APP, roleKey: 'staff' })
		await o.invite(NEWCOMER, { by: staff })
		o.membership.between = () => o.f.repositories.grants.deleteGrant(staffGrant.id)

		const response = await o.send(accept({ token: o.email.lastToken(), password: PASSWORD }))
		expect(response.status).toBe(403)
		expect(await o.f.repositories.principals.getUserByEmail(NEWCOMER)).toBeNull()
		expect(await o.f.repositories.passwords.lookupLogin(NEWCOMER)).toEqual({ status: 'missing' })
		expect(await auditActions(o)).not.toContain('iam.principal.create')
	})

	test('an address the organization names is never invited to an external role', async () => {
		const o = await onboarding()
		for (const address of ['boss@partner.test', 'Named@Partner.test', 'someone@org.test']) {
			expect(await o.invite(address)).toEqual({ ok: false, reason: 'internal_mailbox' })
		}
		expect(o.email.messages).toHaveLength(0)
		// `*` names nobody, and a role not declared external creates no principal, so neither is refused.
		expect(await o.invite('anyone@elsewhere.test')).toMatchObject({ ok: true })
		expect(await o.invite('boss@partner.test', { role: 'editor' })).toMatchObject({ ok: true })
	})

	test('an existing internal mailbox signs in and accepts', async () => {
		const o = await onboarding()
		const invitee = await o.f.person('invitee')
		await o.invite('invitee@example.test')
		const token = o.email.lastToken()

		const signIn = await o.send(accept({ token }))
		expect(signIn.status).toBe(401)
		expect(await signIn.text()).not.toContain('name="password"')
		expect((await o.send(accept({ token, password: PASSWORD }))).status).toBe(401)
		expect(await o.f.repositories.passwords.getAccount(invitee.id)).toBeNull()

		const cookie = `${SESSION_COOKIE}=${await o.h.signSession(invitee.id)}`
		expect((await o.send(accept({ token }, { Cookie: cookie }))).status).toBe(302)
		expect((await o.f.repositories.membership.listRoleGrantsAt(APP, invitee.id, o.scope)).map((grant) => grant.role_key)).toEqual(['partner'])
		expect((await o.f.repositories.principals.getPrincipalById(invitee.id))?.affiliation).toBe('internal')
	})

	test('a disabled principal is not reactivated by an invitation', async () => {
		const o = await onboarding()
		const existing = await o.f.repositories.principals.inviteUser(NEWCOMER, NEWCOMER, undefined, 'external')
		await o.f.repositories.principals.disablePrincipal(existing.id)
		await o.invite(NEWCOMER)
		expect((await o.send(accept({ token: o.email.lastToken(), password: PASSWORD }))).status).toBe(401)
		expect((await o.f.repositories.principals.getPrincipalById(existing.id))?.disabled_at).not.toBeNull()
		expect(await o.f.repositories.passwords.getAccount(existing.id)).toBeNull()
	})

	test('without password authentication an invitation creates no principal', async () => {
		const o = await onboarding({ password: false })
		await o.invite(NEWCOMER)
		expect((await o.send(accept({ token: o.email.lastToken() }))).status).toBe(401)
		expect(await o.f.repositories.principals.getUserByEmail(NEWCOMER)).toBeNull()
	})

	test('a second company invites the same person: the second acceptance signs in and accepts', async () => {
		const o = await onboarding()
		await o.invite(NEWCOMER)
		const firstToken = o.email.lastToken()
		const owner = await o.f.person('second-owner')
		await o.f.repositories.grants.createGrant({ principalId: owner.id, app: APP, roleKey: 'starter' })
		const grant = await requestDelegation(o.f.services, CALLER_ENV, o.f.ctx, {
			app: APP,
			credential: await owner.token(),
			requestId: 'req-second-create',
			endpoint: CREATE_ENDPOINT,
		})
		if (!grant.ok) throw new Error('no delegation')
		const second = await createScope(o.f.services, CALLER_ENV, o.f.ctx, {
			app: APP,
			credential: await owner.token(),
			requestId: 'req-second-create',
			delegation: grant.grant,
			dimension: 'workspace',
		})
		if (!second.ok) throw new Error('no workspace')
		const invite = await requestDelegation(o.f.services, CALLER_ENV, o.f.ctx, {
			app: APP,
			credential: await owner.token(),
			requestId: 'req-second-invite',
			endpoint: INVITE_ENDPOINT,
		})
		if (!invite.ok) throw new Error('no delegation')
		await assignMember(o.f.services, CALLER_ENV, o.f.ctx, {
			app: APP,
			credential: await owner.token(),
			requestId: 'req-second-invite',
			delegation: invite.grant,
			scope: second.scope,
			role: 'partner',
			member: { email: NEWCOMER },
		})
		const secondToken = o.email.lastToken()

		expect((await o.send(accept({ token: firstToken, password: PASSWORD }))).status).toBe(302)
		const principal = await o.f.repositories.principals.getUserByEmail(NEWCOMER)
		if (principal === null) throw new Error('no principal')
		expect((await o.send(accept({ token: secondToken, password: 'another long passphrase' }))).status).toBe(401)
		const cookie = `${SESSION_COOKIE}=${await o.h.signSession(principal.id, { idpSub: null, authenticationMethod: 'password' })}`
		expect((await o.send(accept({ token: secondToken }, { Cookie: cookie }))).status).toBe(302)
		expect((await o.f.repositories.membership.listRoleGrantsAt(APP, principal.id, second.scope)).map((row) => row.role_key)).toEqual(['partner'])
		expect(await o.f.repositories.passwords.lookupLogin(NEWCOMER)).toMatchObject({ status: 'found', credential: { password_hash: `hash:${PASSWORD}` } })
	})
})

describe("an invitation's label and message", () => {
	test('reach the e-mail as written, and its HTML part escaped', async () => {
		const o = await onboarding()
		expect(await o.invite(NEWCOMER, { label: 'Acme <Partners> & Co', message: 'Welcome <b>aboard</b>.\n\nSee you soon.' })).toMatchObject({ ok: true })
		const [mail] = o.email.messages
		expect(mail?.text).toContain('Acme <Partners> & Co')
		expect(mail?.text).toContain('Welcome <b>aboard</b>.\n\nSee you soon.')
		expect(mail?.html).toContain('Acme &lt;Partners&gt; &amp; Co')
		expect(mail?.html).toContain('Welcome &lt;b&gt;aboard&lt;/b&gt;.')
		expect(mail?.html).not.toContain('<b>')
	})

	test('are bounded, and go with an invitation by address only', async () => {
		const o = await onboarding()
		for (const wording of [{ label: 'x'.repeat(201) }, { label: 'two\nlines' }, { message: 'x'.repeat(1001) }, { message: 'bell\u0007' }]) {
			expect(await o.invite(NEWCOMER, wording)).toMatchObject({ ok: false, reason: 'invalid_request' })
		}
		expect(await o.invite(NEWCOMER, { label: 'x'.repeat(200), message: 'line\none\ttab' })).toMatchObject({ ok: true })
		const member = await o.f.person('member')
		seq += 1
		const base = { app: APP, credential: await o.owner.token(), requestId: `req-${seq}` }
		const grant = await requestDelegation(o.f.services, CALLER_ENV, o.f.ctx, { ...base, endpoint: INVITE_ENDPOINT })
		if (!grant.ok) throw new Error('no delegation')
		expect(
			await assignMember(o.f.services, CALLER_ENV, o.f.ctx, {
				...base,
				delegation: grant.grant,
				scope: o.scope,
				role: 'editor',
				member: { principalId: member.id },
				invitation: { label: 'Acme' },
			}),
		).toMatchObject({ ok: false, reason: 'invalid_request' })
	})
})

describe('a change between the check of an acceptance and its write', () => {
	const changes: Record<string, (o: Onboarding, inviter: Person) => Promise<unknown>> = {
		...Object.fromEntries(
			Object.entries(reconcilesBetween(ONBOARDING_SCHEMA)).map(([name, schema]) => [
				name,
				async (o: Onboarding) => expect((await o.f.putSchema(schema)).status).toBe(200),
			]),
		),
		'inviter disabled': (o, inviter) => o.f.repositories.principals.disablePrincipal(inviter.id),
	}

	for (const [name, change] of Object.entries(changes)) {
		test(`${name}: the acceptance that creates its principal writes nothing`, async () => {
			const o = await onboarding()
			const staff = await o.f.person('staff')
			await o.f.repositories.grants.createGrant({ principalId: staff.id, app: APP, roleKey: 'staff' })
			await o.invite(NEWCOMER, { by: staff })
			o.membership.between = () => change(o, staff)

			expect((await o.send(accept({ token: o.email.lastToken(), password: PASSWORD }))).status).toBe(403)
			expect(await o.f.repositories.principals.getUserByEmail(NEWCOMER)).toBeNull()
			expect(await o.f.repositories.passwords.lookupLogin(NEWCOMER)).toEqual({ status: 'missing' })
			const [open] = await o.f.repositories.membership.listOpenInvitations(APP, o.scope)
			expect(open?.accepted_at).toBeNull()
		})

		test(`${name}: the signed-in acceptance writes nothing`, async () => {
			const o = await onboarding()
			const staff = await o.f.person('staff')
			await o.f.repositories.grants.createGrant({ principalId: staff.id, app: APP, roleKey: 'staff' })
			const invitee = await o.f.person('invitee')
			await o.invite('invitee@example.test', { by: staff })
			o.membership.between = () => change(o, staff)

			const cookie = `${SESSION_COOKIE}=${await o.h.signSession(invitee.id)}`
			expect((await o.send(accept({ token: o.email.lastToken() }, { Cookie: cookie }))).status).toBe(403)
			expect(await o.f.repositories.membership.listRoleGrantsAt(APP, invitee.id, o.scope)).toEqual([])
			expect(await o.f.repositories.membership.listOpenInvitations(APP, o.scope)).toHaveLength(1)
		})
	}
})

describe('an invitation that creates its principal, opened in a browser signed in as someone else', () => {
	test('shows the invited address and asks to sign out, without consuming the link or writing anything', async () => {
		const o = await onboarding()
		await o.invite(NEWCOMER)
		const token = o.email.lastToken()
		const cookie = `${SESSION_COOKIE}=${await o.h.signSession(o.owner.id)}`

		const submissions: Record<string, string>[] = [{ token }, { token, password: PASSWORD }]
		for (const fields of submissions) {
			const response = await o.send(accept(fields, { Cookie: cookie }))
			expect(response.status).toBe(409)
			const html = await response.text()
			expect(html).toContain(NEWCOMER)
			expect(html).toContain('href="/auth/logout"')
			expect(html).not.toContain('name="password"')
			expect(response.headers.get('set-cookie')).toBeNull()
		}
		expect(await o.f.repositories.principals.getUserByEmail(NEWCOMER)).toBeNull()
		// Signed out, the same link still opens the set-password form.
		expect(await (await o.send(accept({ token }))).text()).toContain('name="password"')
	})
})
