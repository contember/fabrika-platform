// User administration (ADR-0058): a `user-admin` at `propustka` manages the people of the applications in its scope,
// holds nothing it grants, and stops at the installation. Each test is one rule of the ADR's safety argument, most of
// them an escalation attempt, and every suite runs on SQLite and, with FABRIKA_TEST_POSTGRES_URL, on Postgres.

import type { AppSchema } from '@fabrika/auth-core'
import { IAM_APP_ID, IAM_APP_SCHEMA, USER_ADMIN_ROLE } from '@fabrika/iam-contract'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AdminContext } from '../admin/context'
import { adminUseCases } from '../admin/handlers'
import { adminRpcRouter } from '../admin/rpc'
import { administrationOf } from '../admin/user-admin'
import { issueSession } from '../auth/sessions'
import { createPostgresIamRepositories, type IamRepositories, type PrincipalRow } from '../db'
import { prop } from '../json'
import { resolvePermissionsAt } from '../resolve'
import { procedureInput, routerLeaves, USER_ADMINISTRATION } from './helpers/admin-router'
import { bearerRpc, consoleRpc, errorType, result } from './helpers/app-people'
import { adminTokenFor, CONSOLE_APP, createHarness } from './helpers/harness'
import { APP, CapturingEmail, type MembershipFixture, membershipFixture, ORIGIN } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

/** An application that is not a contract one, so its built-in `admin` (`*` there) can be granted. */
const CRM = 'crm@prod'
const CRM_SCHEMA: AppSchema = {
	scopes: [{ type: 'region' }],
	actions: [{ action: 'crm.read' }, { action: 'crm.write' }],
	roles: { viewer: { name: 'Viewer', permissions: ['crm.read'] } },
}
/** The console's vocabulary, enough to grant a deployer there. */
const CONSOLE_SCHEMA: AppSchema = {
	scopes: [],
	actions: [{ action: 'deploy.read' }, { action: 'deploy.trigger' }],
	roles: { deployer: { name: 'Deployer', permissions: ['deploy.*'] } },
}

const BOOTSTRAP_MAILBOX = 'founder@example.test'
const PASSWORDS = { authentication: { oidc: true, password: true }, bootstrapAdmins: new Set([BOOTSTRAP_MAILBOX]) }

let seq = 0
const unique = (base: string): string => `${base}-${++seq}-${crypto.randomUUID().slice(0, 8)}`

interface Installation {
	readonly f: MembershipFixture
	/** A signed-in person with no grant. */
	person(base: string): Promise<PrincipalRow>
	/** A user administrator, globally or scoped to the given applications. */
	userAdmin(apps?: readonly string[]): Promise<PrincipalRow>
	grant(principal: PrincipalRow, app: string | null, roleKey: string): Promise<void>
	/** The use cases as the console's gateway would run them for `principal` (password and bootstrap rules need services). */
	direct(principal: PrincipalRow): Promise<AdminContext>
}

async function installation(repositories: IamRepositories, email: CapturingEmail | null = null): Promise<Installation> {
	const f = await membershipFixture(repositories, { email, services: PASSWORDS })
	for (const [schema, app] of [[IAM_APP_SCHEMA, IAM_APP_ID], [CRM_SCHEMA, CRM], [CONSOLE_SCHEMA, CONSOLE_APP]] as const) {
		const reconciled = await f.putSchema(schema, app)
		if (reconciled.status !== 200) throw new Error(`schema refused: ${await reconciled.text()}`)
	}
	const person = async (base: string): Promise<PrincipalRow> => {
		const name = unique(base)
		return repositories.principals.createUser(`sub-${name}`, `${name}@example.test`)
	}
	const grant = async (principal: PrincipalRow, app: string | null, roleKey: string): Promise<void> => {
		await repositories.grants.createRoleGrantUnlessHeld({ principalId: principal.id, app, roleKey })
	}
	return {
		f,
		person,
		grant,
		async userAdmin(apps) {
			const admin = await person('user-admin')
			if (apps === undefined) {
				await grant(admin, IAM_APP_ID, USER_ADMIN_ROLE)
			}
			for (const app of apps ?? []) {
				await repositories.grants.createRoleGrantUnlessHeld({
					principalId: admin.id,
					app: IAM_APP_ID,
					roleKey: USER_ADMIN_ROLE,
					scopeType: 'app',
					scopeValue: app,
				})
			}
			return admin
		},
		async direct(principal) {
			const permissions = await resolvePermissionsAt(f.services, principal, IAM_APP_ID)
			const admin = { id: principal.id, type: principal.type, label: principal.label, permissions }
			const administration = administrationOf({ ...admin, audience: CONSOLE_APP, session: true })
			if (administration === null) throw new Error('not an administrator')
			const url = new URL(`${ORIGIN}/admin/rpc`)
			return { services: f.services, request: new Request(url), url, admin, administration, app: IAM_APP_ID, requestId: unique('req'), ctx: f.ctx }
		},
	}
}

/** The rejection a use case throws, as `{ status, message }`, or null when it succeeded. */
async function refusal(run: () => Promise<unknown>): Promise<{ status: number; message: string } | null> {
	try {
		await run()
		return null
	} catch (cause) {
		const status: unknown = prop(cause, 'httpStatus')
		if (typeof status !== 'number' || !(cause instanceof Error)) throw cause
		return { status, message: cause.message }
	}
}

const status = async (call: Promise<{ status: number; body: unknown }>): Promise<number> => (await call).status

function userAdministrationSuite(label: string, repositories: () => IamRepositories) {
	describe(`user administration (${label})`, () => {
		test("IAM's vocabulary registers under propustka, and an installation admin grants `user-admin` there", async () => {
			const i = await installation(repositories())
			const admin = await i.person('to-be-user-admin')
			const granted = await i.f.adminRpc('grants.create', { principalId: admin.id, app: IAM_APP_ID, roleKey: USER_ADMIN_ROLE })
			expect(granted.status).toBe(200)
			const me = await consoleRpc(i.f, admin.id, 'me', null)
			expect(me.status).toBe(200)
			expect(prop(result(me.body), 'permissions')).toEqual([{ action: 'iam.users.manage', scope: null, source: 'grant' }])
		})

		test("grants any role, the app's own `admin` and inline permissions at an application, holding none of them", async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const newcomer = await i.person('newcomer')
			for (const grant of [{ roleKey: 'admin' }, { roleKey: 'viewer' }, { permissions: ['crm.write'] }]) {
				expect(await status(consoleRpc(i.f, admin.id, 'grants.create', { principalId: newcomer.id, app: CRM, ...grant }))).toBe(200)
			}
			const atCrm = await resolvePermissionsAt(i.f.services, newcomer, CRM)
			expect(atCrm.map((entry) => entry.action).sort()).toEqual(['*', 'crm.read', 'crm.write'])
			// The app's own `admin` is `*` at that app only: nothing at the console, at IAM, or at another application.
			for (const app of [CONSOLE_APP, IAM_APP_ID, APP]) {
				expect(await resolvePermissionsAt(i.f.services, newcomer, app)).toEqual([])
			}
			expect(await resolvePermissionsAt(i.f.services, admin, CRM)).toEqual([])
		})

		test('granting `admin` cross-app is refused', async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const call = await consoleRpc(i.f, admin.id, 'grants.create', { principalId: admin.id, roleKey: 'admin' })
			expect([call.status, errorType(call.body)]).toEqual([403, 'forbidden'])
			expect(await i.f.repositories.grants.listGrants(admin.id)).toHaveLength(1)
		})

		test("granting at the console or at IAM is refused, `user-admin` and the console's own `admin` included", async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const accomplice = await i.person('accomplice')
			for (
				const grant of [
					{ app: CONSOLE_APP, roleKey: 'deployer' },
					{ app: CONSOLE_APP, roleKey: 'admin' },
					{ app: IAM_APP_ID, roleKey: USER_ADMIN_ROLE },
					{ app: IAM_APP_ID, permissions: ['iam.admin'] },
				]
			) {
				for (const principalId of [admin.id, accomplice.id]) {
					const call = await consoleRpc(i.f, admin.id, 'grants.create', { principalId, ...grant })
					expect([grant, call.status]).toEqual([grant, 403])
				}
			}
			expect(await i.f.repositories.grants.listGrants(accomplice.id)).toEqual([])
		})

		test("revoking a grant at the console is refused, so a user admin cannot strip a deployer's role", async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const deployer = await i.person('deployer')
			await i.grant(deployer, CONSOLE_APP, 'deployer')
			const [held] = await i.f.repositories.grants.listGrants(deployer.id)
			if (held === undefined) throw new Error('no grant')
			expect(await status(consoleRpc(i.f, admin.id, 'grants.delete', { id: held.id }))).toBe(403)
			expect(await i.f.repositories.grants.listGrants(deployer.id)).toHaveLength(1)
		})

		test("an API key's grants are out of reach at an application it administers: adding and removing one are refused", async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const provisioned = await i.f.adminRpc('apiKeys.provision', { label: 'crm-sync', type: 'service', app: CRM, roleKey: 'viewer' })
			const keyId = prop(prop(await provisioned.json(), 'result'), 'principalId')
			if (typeof keyId !== 'string') throw new Error('no key provisioned')
			const [held] = await i.f.repositories.grants.listGrants(keyId)
			if (held === undefined) throw new Error('no grant')

			const added = await consoleRpc(i.f, admin.id, 'grants.create', { principalId: keyId, app: CRM, permissions: ['crm.write'] })
			expect([added.status, errorType(added.body)]).toEqual([403, 'forbidden'])
			expect(await status(consoleRpc(i.f, admin.id, 'grants.delete', { id: held.id }))).toBe(403)
			expect((await i.f.repositories.grants.listGrants(keyId)).map((grant) => grant.id)).toEqual([held.id])
		})

		test('a user admin scoped to one application grants and acts only there', async () => {
			const i = await installation(repositories())
			const scoped = await i.userAdmin([CRM])
			const person = await i.person('person')
			expect(await status(consoleRpc(i.f, scoped.id, 'grants.create', { principalId: person.id, app: CRM, roleKey: 'viewer' }))).toBe(200)
			expect(await status(consoleRpc(i.f, scoped.id, 'grants.create', { principalId: person.id, app: APP, roleKey: 'staff' }))).toBe(403)

			const elsewhere = await i.person('elsewhere')
			await i.grant(elsewhere, APP, 'staff')
			const [held] = await i.f.repositories.grants.listGrants(elsewhere.id)
			if (held === undefined) throw new Error('no grant')
			expect(await status(consoleRpc(i.f, scoped.id, 'grants.delete', { id: held.id }))).toBe(403)
			expect(await status(consoleRpc(i.f, scoped.id, 'principals.update', { principalId: elsewhere.id, disabled: true }))).toBe(403)
			expect(await status(consoleRpc(i.f, scoped.id, 'sessions.revokeAll', { principalId: elsewhere.id }))).toBe(403)
			// The person it just granted at its own application it may act on.
			expect(await status(consoleRpc(i.f, scoped.id, 'principals.update', { principalId: person.id, disabled: true }))).toBe(200)
		})

		test('disabling or signing out an IAM admin, a console admin, a deployer or another user admin is refused', async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const iamAdmin = await i.person('iam-admin')
			await i.grant(iamAdmin, null, 'admin')
			const consoleAdmin = await i.person('console-admin')
			await i.grant(consoleAdmin, CONSOLE_APP, 'admin')
			const deployer = await i.person('deployer')
			await i.grant(deployer, CONSOLE_APP, 'deployer')
			const peer = await i.userAdmin()
			for (const target of [iamAdmin, consoleAdmin, deployer, peer]) {
				for (
					const [method, input] of [
						['principals.update', { principalId: target.id, disabled: true }],
						['sessions.revokeAll', { principalId: target.id }],
					] as const
				) {
					expect([target.label, method, await status(consoleRpc(i.f, admin.id, method, input))]).toEqual([target.label, method, 403])
				}
			}
			for (const target of [iamAdmin, consoleAdmin, deployer, peer]) {
				expect((await i.f.repositories.principals.getPrincipalById(target.id))?.disabled_at).toBeNull()
			}
		})

		test('a session of a console admin cannot be revoked by id either', async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const consoleAdmin = await i.person('console-admin')
			await i.grant(consoleAdmin, CONSOLE_APP, 'admin')
			const sessionId = await i.f.repositories.sessions.createSession({
				tokenHash: unique('hash'),
				principalId: consoleAdmin.id,
				authenticationMethod: 'password',
				expiresAt: Math.floor(Date.now() / 1000) + 3600,
			})
			expect(await status(consoleRpc(i.f, admin.id, 'sessions.revoke', { id: sessionId }))).toBe(403)
		})

		test('a bootstrap mailbox is out of reach though it holds no grant row', async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const founder = await i.f.repositories.principals.createUser(`sub-${unique('founder')}`, BOOTSTRAP_MAILBOX)
			const c = await i.direct(admin)
			expect(await refusal(() => adminUseCases.updatePrincipal(c, { principalId: founder.id, disabled: true }))).toMatchObject({ status: 403 })
			expect(await refusal(() => adminUseCases.issuePasswordEnrollment(c, { principalId: founder.id }))).toMatchObject({ status: 403 })
		})

		test("resetting a console admin's password is refused, with an email sender too", async () => {
			const i = await installation(repositories(), new CapturingEmail())
			const admin = await i.userAdmin()
			const consoleAdmin = await i.person('console-admin')
			await i.grant(consoleAdmin, CONSOLE_APP, 'admin')
			const c = await i.direct(admin)
			for (const run of [adminUseCases.issuePasswordReset, adminUseCases.issuePasswordEnrollment, adminUseCases.disablePassword]) {
				expect(await refusal(() => run(c, { principalId: consoleAdmin.id }))).toMatchObject({ status: 403 })
			}
		})

		test('with an email sender, the links for a person it may act on go to that person', async () => {
			const email = new CapturingEmail()
			const i = await installation(repositories(), email)
			const admin = await i.userAdmin()
			const person = await i.person('person')
			await i.grant(person, CRM, 'viewer')
			const c = await i.direct(admin)
			expect(await adminUseCases.issuePasswordEnrollment(c, { principalId: person.id })).toMatchObject({ delivery: 'email' })
			expect(email.messages.at(-1)?.to).toBe(person.email ?? 'no mailbox')
		})

		test('without an email sender, an enrollment URL reaches only an installation admin, not even for a fresh invitation', async () => {
			const i = await installation(repositories())
			for (const admin of [await i.userAdmin(), await i.userAdmin([CRM])]) {
				const c = await i.direct(admin)
				// The invited row is the one the real person's OIDC sign-in claims later; a password set now would survive that claim.
				const invited = await adminUseCases.invitePrincipal(c, { email: `${unique('newhire')}@example.test` })
				expect(await refusal(() => adminUseCases.issuePasswordEnrollment(c, { principalId: invited.id }))).toMatchObject({ status: 403 })
				expect(await i.f.repositories.passwords.getAccount(invited.id)).toBeNull()
				const events = await i.f.repositories.audit.listAuditEvents({ principalId: admin.id, limit: 20 })
				expect(events.map((event) => event.action)).not.toContain('iam.password.enrollment.issue')

				const installationAdmin = await i.person('installation-admin')
				await i.grant(installationAdmin, null, 'admin')
				expect(await adminUseCases.issuePasswordEnrollment(await i.direct(installationAdmin), { principalId: invited.id })).toMatchObject({
					delivery: 'manual',
				})
			}
		})

		test('without an email sender, a reset URL reaches only an installation admin', async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const person = await i.person('person')
			const installationAdmin = await i.person('installation-admin')
			await i.grant(installationAdmin, null, 'admin')
			await i.f.repositories.passwords.upsertCredential(person.id, { algorithm: 'old', parameters: '{}', salt: 'salt', passwordHash: 'old' })
			const asUserAdmin = await i.direct(admin)
			expect(await refusal(() => adminUseCases.issuePasswordReset(asUserAdmin, { principalId: person.id }))).toMatchObject({ status: 403 })
			expect(await adminUseCases.issuePasswordReset(await i.direct(installationAdmin), { principalId: person.id })).toMatchObject({
				delivery: 'manual',
			})
		})

		test('a user admin reaches no procedure but its own, and only from a session', async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const reached: string[] = []
			for (const { method } of routerLeaves(adminRpcRouter)) {
				if (USER_ADMINISTRATION.includes(method) || method.startsWith('appPeople.')) continue
				const call = await consoleRpc(i.f, admin.id, method, procedureInput(method))
				if (call.status !== 403) reached.push(`${method} → ${call.status}`)
			}
			expect(reached).toEqual([])
			const key = await adminTokenFor(i.f.repositories, admin.id, { issuer: ORIGIN, session: false })
			expect((await bearerRpc(i.f, key, 'me', null)).status).toBe(403)
		})

		test('apps.list marks the installation apps; a user admin request writes its access row and its change', async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin()
			const apps = await consoleRpc(i.f, admin.id, 'apps.list', null)
			const items = prop(result(apps.body), 'items')
			expect(Array.isArray(items) ? items.filter((app) => prop(app, 'installation') === true).map((app) => prop(app, 'id')).sort() : null).toEqual([
				IAM_APP_ID,
				CONSOLE_APP,
			].sort())

			const person = await i.person('person')
			expect(await status(consoleRpc(i.f, admin.id, 'grants.create', { principalId: person.id, app: CRM, roleKey: 'viewer' }))).toBe(200)
			const events = await i.f.repositories.audit.listAuditEvents({ principalId: admin.id, limit: 20 })
			expect(events.map((event) => event.action).sort()).toEqual(['iam.admin.access', 'iam.admin.access', 'iam.grant.create'])
		})

		test("a user admin's login is privileged", async () => {
			const i = await installation(repositories())
			const admin = await i.userAdmin([CRM])
			const requestId = unique('login')
			await issueSession(new Request(`${ORIGIN}/auth/login`), i.f.services, i.f.ctx, {
				principalId: admin.id,
				authenticationMethod: 'password',
				redirect: null,
				reason: 'password',
				requestId,
			})
			const [row] = await i.f.repositories.audit.listAuthLog({ principalId: admin.id, limit: 5 })
			expect(row?.privileged).toBe(1)
		})
	})
}

userAdministrationSuite('SQLite', () => createHarness().repositories)

if (!hasPostgres) {
	console.warn(`user-admin.test.ts ${skipReason}`)
}

describe.skipIf(!hasPostgres)('on Postgres', () => {
	let fixture: PostgresFixture | null = null
	beforeAll(async () => {
		fixture = await createPostgres('iam_user_admin')
	})
	afterAll(async () => {
		await fixture?.close()
	})
	userAdministrationSuite('Postgres', () => {
		if (fixture === null) throw new Error('fixture')
		return createPostgresIamRepositories(fixture.db)
	})
})
