import { SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { handleAuth } from '../auth/routes'
import { assignMember, createScope, requestDelegation } from '../membership'
import { createHarness, type Harness } from './helpers/harness'
import {
	APP,
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	type MembershipFixture,
	membershipFixture,
	ORIGIN,
} from './helpers/membership'

// The page an invitation link opens on IAM's own host. It accepts for the principal signed in there,
// same-origin only, and the one-time token arrives in the form — copied from the link's fragment.

interface Invited {
	h: Harness
	f: MembershipFixture
	token: string
	scope: { type: string; value: string }
}

async function invited(): Promise<Invited> {
	const h = createHarness()
	const email = new CapturingEmail()
	const f = await membershipFixture(h.repositories, { email })
	const owner = await f.person('owner')
	await f.repositories.grants.createGrant({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const call = async (endpoint: string, requestId: string) => {
		const base = { app: APP, credential: await owner.token(), requestId }
		const grant = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...base, endpoint })
		if (!grant.ok) throw new Error('no delegation')
		return { ...base, delegation: grant.grant }
	}
	const created = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await call(CREATE_ENDPOINT, 'req-create')), dimension: 'workspace' })
	if (!created.ok) throw new Error('no workspace')
	await assignMember(f.services, CALLER_ENV, f.ctx, {
		...(await call(INVITE_ENDPOINT, 'req-invite')),
		scope: created.scope,
		role: 'editor',
		member: { email: 'invitee@example.test' },
	})
	return { h, f, token: email.lastToken(), scope: created.scope }
}

function accept(token: string, headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}/auth/invitations/accept`, {
		method: 'POST',
		headers: { Origin: 'null', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams({ token }),
	})
}

async function signedIn(i: Invited, name: string): Promise<{ id: string; cookie: string }> {
	const person = await i.f.person(name)
	return { id: person.id, cookie: `${SESSION_COOKIE}=${await i.h.signSession(person.id)}` }
}

const send = (i: Invited, request: Request): Promise<Response> => handleAuth(request, i.f.services, CALLER_ENV, i.f.ctx)

describe('/auth/invitations/accept', () => {
	test('the link opens a form that takes its token from the fragment', async () => {
		const i = await invited()
		const page = await send(i, new Request(`${ORIGIN}/auth/invitations/accept`))
		expect(page.status).toBe(200)
		const html = await page.text()
		expect(html).toContain('id="action-token"')
		expect(html).toContain("getElementById('action-token')")
		expect(page.headers.get('referrer-policy')).toBe('no-referrer')
	})

	test('the invited mailbox owner, signed in here, accepts once', async () => {
		const i = await invited()
		const invitee = await signedIn(i, 'invitee')
		const response = await send(i, accept(i.token, { Cookie: invitee.cookie }))
		expect(response.status).toBe(200)
		expect(await response.text()).toContain('Invitation accepted')
		expect((await i.f.repositories.membership.listRoleGrantsAt(APP, invitee.id, i.scope)).map((grant) => grant.role_key)).toEqual(['editor'])
		expect((await send(i, accept(i.token, { Cookie: invitee.cookie }))).status).toBe(400)
	})

	test('another signed-in principal cannot accept with the link', async () => {
		const i = await invited()
		const colleague = await signedIn(i, 'colleague')
		const response = await send(i, accept(i.token, { Cookie: colleague.cookie }))
		expect(response.status).toBe(403)
		expect(await response.text()).not.toContain('invitee@example.test')
	})

	test('without a session the page asks to sign in and accepts nothing', async () => {
		const i = await invited()
		const response = await send(i, accept(i.token))
		expect(response.status).toBe(401)
		expect(await response.text()).toContain('/auth/login?redirect=')
	})

	test('a cross-site post and a malformed token are refused', async () => {
		const i = await invited()
		const invitee = await signedIn(i, 'invitee')
		expect((await send(i, accept(i.token, { Cookie: invitee.cookie, 'Sec-Fetch-Site': 'cross-site' }))).status).toBe(403)
		expect((await send(i, accept('short', { Cookie: invitee.cookie }))).status).toBe(400)
		expect(await i.f.repositories.membership.listRoleGrantsAt(APP, invitee.id, i.scope)).toEqual([])
	})
})
