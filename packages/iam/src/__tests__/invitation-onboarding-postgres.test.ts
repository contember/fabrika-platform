// An invitation that creates its principal, against a REAL Postgres: the one transaction that creates the external
// principal, its password and its grant; and what no single connection can show — two concurrent acceptances, of one
// invitation or of two invitations to the same new mailbox, create exactly one principal, and an acceptance waits for
// a removal of the inviter's grant and then creates nothing. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { type AppSchema, type Scope } from '@fabrika/auth-core'
import { PostgresDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPostgresIamRepositories, type IamRepositories, type InvitationRow } from '../db'
import { acceptCreatingPrincipal, assignMember, createScope, invitationOffer, requestDelegation } from '../membership'
import type { StoredPasswordHash } from '../password-crypto'
import { hashToken } from '../secret'
import type { Services } from '../services'
import {
	APP,
	CALLER_ENV,
	CapturingEmail,
	CREATE_ENDPOINT,
	INVITE_ENDPOINT,
	type MembershipFixture,
	membershipFixture,
	NOTES_SCHEMA,
	type Person,
} from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`invitation-onboarding-postgres.test.ts ${skipReason}`)
}

const ONBOARDING_SCHEMA: AppSchema = {
	...NOTES_SCHEMA,
	roles: {
		...NOTES_SCHEMA.roles,
		partner: { name: 'Partner', permissions: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner', 'staff'] }, external: true },
	},
}

const PASSWORD: StoredPasswordHash = { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: 'hash:a sufficiently long passphrase' }

let fixture: PostgresFixture | null = null
let pool: PostgresDatabase | null = null
let repositories: IamRepositories
let concurrent: IamRepositories

beforeAll(async () => {
	if (!hasPostgres || postgresUrl === null) return
	fixture = await createPostgres('iam_onboarding')
	repositories = createPostgresIamRepositories(fixture.db)
	pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 4 })
	concurrent = createPostgresIamRepositories(pool)
})

afterAll(async () => {
	await pool?.close()
	await fixture?.close()
})

let seq = 0

interface Onboarding {
	readonly f: MembershipFixture
	readonly email: CapturingEmail
	readonly owner: Person
	readonly scope: Scope
	/** The fixture's services over the second pool, whose connections run transactions side by side. */
	readonly parallel: Services
	invite(address: string, options?: { resend?: boolean; by?: Person; scope?: Scope }): Promise<InvitationRow>
	workspace(): Promise<Scope>
}

async function onboarding(): Promise<Onboarding> {
	const email = new CapturingEmail()
	const f = await membershipFixture(repositories, { email, services: { authentication: { oidc: true, password: true } } })
	expect((await f.putSchema(ONBOARDING_SCHEMA)).status).toBe(200)
	seq += 1
	const owner = await f.person(`owner-${seq}`)
	await repositories.grants.createRoleGrantUnlessHeld({ principalId: owner.id, app: APP, roleKey: 'starter' })
	const delegated = async (person: Person, endpoint: string) => {
		seq += 1
		const base = { app: APP, credential: await person.token(), requestId: `pg-onboarding-${seq}` }
		const grant = await requestDelegation(f.services, CALLER_ENV, f.ctx, { ...base, endpoint })
		if (!grant.ok) throw new Error(`no delegation: ${grant.reason}`)
		return { ...base, delegation: grant.grant }
	}
	const workspace = async (): Promise<Scope> => {
		const created = await createScope(f.services, CALLER_ENV, f.ctx, { ...(await delegated(owner, CREATE_ENDPOINT)), dimension: 'workspace' })
		if (!created.ok) throw new Error(`no workspace: ${created.reason}`)
		return created.scope
	}
	const scope = await workspace()
	return {
		f,
		email,
		owner,
		scope,
		parallel: { ...f.services, repositories: concurrent },
		workspace,
		async invite(address, options = {}) {
			const result = await assignMember(f.services, CALLER_ENV, f.ctx, {
				...(await delegated(options.by ?? owner, INVITE_ENDPOINT)),
				scope: options.scope ?? scope,
				role: 'partner',
				member: { email: address },
				...(options.resend === true ? { invitation: { resend: true } } : {}),
			})
			if (!result.ok || !('invited' in result)) throw new Error(`no invitation: ${JSON.stringify(result)}`)
			const invitation = await repositories.membership.getInvitationByHash(await hashToken(email.lastToken()))
			if (invitation === null) throw new Error('no invitation row')
			return invitation
		},
	}
}

async function principalsOf(mailbox: string): Promise<number> {
	if (fixture === null) throw new Error('fixture')
	const { results } = await fixture.db.prepare('SELECT id FROM principals WHERE email = ?').bind(mailbox).all()
	return results.length
}

describe.skipIf(!hasPostgres)('an invitation that creates its principal, on Postgres', () => {
	test('one transaction creates the external principal, its password, its grant and the records', async () => {
		const o = await onboarding()
		const mailbox = `newcomer-${seq}@partner.test`
		const invitation = await o.invite(mailbox)
		const offer = await invitationOffer(o.f.services, o.email.lastToken())
		expect(offer.kind).toBe('create')

		const accepted = await acceptCreatingPrincipal(o.f.services, invitation, PASSWORD, 'pg-accept')
		if (!accepted.ok) throw new Error(`refused: ${accepted.reason}`)
		expect(accepted.principal).toMatchObject({ affiliation: 'external', email: mailbox, label: mailbox })
		expect((await repositories.membership.listRoleGrantsAt(APP, accepted.principal.id, o.scope)).map((grant) => grant.role_key)).toEqual(['partner'])
		expect(await repositories.passwords.lookupLogin(mailbox)).toMatchObject({ status: 'found' })
		const actions = (await repositories.audit.listAuditEvents({ limit: 200 }))
			.filter((event) => event.principal_id === accepted.principal.id)
			.map((event) => event.action)
		expect(actions.sort()).toEqual(['iam.member.accept', 'iam.password.enrollment.complete', 'iam.principal.create'])
		expect(await acceptCreatingPrincipal(o.f.services, invitation, PASSWORD, 'pg-accept-again')).toEqual({ ok: false, reason: 'sign_in' })
	})

	test('two concurrent acceptances of one invitation create one principal', async () => {
		const o = await onboarding()
		for (let round = 0; round < 5; round++) {
			const mailbox = `twice-${seq}-${round}@partner.test`
			const invitation = await o.invite(mailbox)
			const outcomes = await Promise.all([
				acceptCreatingPrincipal(o.parallel, invitation, PASSWORD, `pg-twice-a-${round}`),
				acceptCreatingPrincipal(o.parallel, invitation, PASSWORD, `pg-twice-b-${round}`),
			])
			expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
			expect(outcomes.filter((outcome) => !outcome.ok).map((outcome) => !outcome.ok && outcome.reason)).toEqual(['sign_in'])
			expect(await principalsOf(mailbox)).toBe(1)
		}
	})

	test('two concurrent acceptances of two invitations to one new mailbox create one principal; the other signs in and accepts', async () => {
		const o = await onboarding()
		const second = await o.workspace()
		for (let round = 0; round < 5; round++) {
			const mailbox = `two-companies-${seq}-${round}@partner.test`
			const first = await o.invite(mailbox)
			const other = await o.invite(mailbox, { scope: second })
			const outcomes = await Promise.all([
				acceptCreatingPrincipal(o.parallel, first, PASSWORD, `pg-first-${round}`),
				acceptCreatingPrincipal(o.parallel, other, PASSWORD, `pg-other-${round}`),
			])
			expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
			expect(await principalsOf(mailbox)).toBe(1)
			const principal = await repositories.principals.getUserByEmail(mailbox)
			if (principal === null) throw new Error('no principal')
			const loser = outcomes[0]?.ok === true ? other : first
			expect(await repositories.membership.acceptInvitation(loser, principal.id, ['owner', 'staff'])).toBe('accepted')
		}
	})

	test('a resent link invalidates the old one', async () => {
		const o = await onboarding()
		const mailbox = `resent-${seq}@partner.test`
		const before = await o.invite(mailbox)
		const oldToken = o.email.lastToken()
		const after = await o.invite(mailbox, { resend: true })
		expect(after.id).toBe(before.id)
		expect(after.token_hash).not.toBe(before.token_hash)
		expect(await invitationOffer(o.f.services, oldToken)).toEqual({ kind: 'invalid' })
		// A submission read under the old link writes nothing, even when it got past the lookup.
		expect(await repositories.membership.acceptAsNewPrincipal({ invitation: before, assigners: ['owner'], password: PASSWORD }, eventsFor)).toEqual({
			outcome: 'not_open',
		})
		expect(await principalsOf(mailbox)).toBe(0)
		const accepted = await acceptCreatingPrincipal(o.f.services, after, PASSWORD, 'pg-resent')
		expect(accepted.ok).toBe(true)
	})

	test("an acceptance waits for a removal that holds the inviter's grant, then creates nothing", async () => {
		if (fixture === null || postgresUrl === null) throw new Error('fixture')
		const o = await onboarding()
		const staff = await o.f.person(`staff-${seq}`)
		await repositories.grants.createRoleGrantUnlessHeld({ principalId: staff.id, app: APP, roleKey: 'staff' })
		const mailbox = `waiting-${seq}@partner.test`
		const invitation = await o.invite(mailbox, { by: staff })

		const removal = new SQL({ url: postgresUrl, max: 1, connection: { search_path: fixture.schema } })
		const reserved = await removal.reserve()
		try {
			await reserved.unsafe('BEGIN')
			await reserved.unsafe('DELETE FROM grants WHERE app = $1 AND principal_id = $2 AND role_key = $3', [APP, staff.id, 'staff'])
			let settled = false
			const acceptance = concurrent.membership.acceptAsNewPrincipal({ invitation, assigners: ['owner', 'staff'], password: PASSWORD }, eventsFor)
				.finally(() => {
					settled = true
				})
			await Bun.sleep(300)
			expect(settled).toBe(false)
			await reserved.unsafe('COMMIT')
			expect(await acceptance).toEqual({ outcome: 'not_allowed' })
		} finally {
			reserved.release()
			await removal.close()
		}
		expect(await principalsOf(mailbox)).toBe(0)
		const open = await repositories.membership.getInvitationById(invitation.id)
		expect([open?.accepted_at, open?.revoked_at]).toEqual([null, null])
	})
})

function eventsFor(principalId: string) {
	const event = (action: string) => ({
		requestId: 'pg-direct',
		principalId,
		principalLabel: principalId,
		app: 'propustka',
		action,
		resourceType: 'principal',
		resourceId: principalId,
	})
	return { principal: event('iam.principal.create'), acceptance: event('iam.member.accept'), password: event('iam.password.enrollment.complete') }
}
