// The delegated administration of an application's roles against a REAL Postgres, where another connection changes
// the administrator's authority while a grant or a revoke runs: a change committed between the check and the write, and
// one whose transaction is still open when the write starts. Either way the write lands only under the authority its
// check read. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { PostgresDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AuditWriter, createPostgresIamRepositories, type IamRepositories } from '../db'
import { consoleRpc, DelegatedBetweenCheckAndWrite, errorType, PEOPLE_SCHEMA, WIDENED_STAFF_SCHEMA } from './helpers/app-people'
import { APP, type MembershipFixture, membershipFixture, type Person } from './helpers/membership'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`app-people-postgres.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let pool: PostgresDatabase | null = null
let concurrent: IamRepositories

beforeAll(async () => {
	if (!hasPostgres || postgresUrl === null) return
	fixture = await createPostgres('iam_app_people')
	// A second pool on the same schema: the concurrent writer.
	pool = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 4 })
	concurrent = createPostgresIamRepositories(pool)
})

afterAll(async () => {
	await pool?.close()
	await fixture?.close()
})

let seq = 0

/** An application with people, over the fixture's connection, whose delegated changes run `grants.between` first. */
async function racing(): Promise<{ f: MembershipFixture; grants: DelegatedBetweenCheckAndWrite; name: (base: string) => string }> {
	if (fixture === null) throw new Error('fixture')
	const grants = new DelegatedBetweenCheckAndWrite(fixture.db, new AuditWriter(fixture.db, 'postgres'))
	const f = await membershipFixture({ ...createPostgresIamRepositories(fixture.db), grants })
	expect((await f.putSchema(PEOPLE_SCHEMA)).status).toBe(200)
	seq += 1
	const run = seq
	return { f, grants, name: (base) => `${base}-${run}` }
}

async function holding(f: MembershipFixture, name: string, roleKey: string): Promise<Person> {
	const person = await f.person(name)
	await f.repositories.grants.createRoleGrantUnlessHeld({ principalId: person.id, app: APP, roleKey })
	return person
}

/** The delegated records the administrator wrote under the application. */
async function recorded(f: MembershipFixture, administrator: Person): Promise<number> {
	const events = await f.repositories.audit.listAuditEvents({ principalId: administrator.id, limit: 50 })
	return events.filter((event) => event.action === 'iam.grant.create' || event.action === 'iam.grant.revoke').length
}

/**
 * Run `statements` in a transaction on its own connection, start `change` while it is open, show that `change` waits,
 * then commit and answer what `change` answered.
 */
async function whileHeld<T>(statements: [string, (string | number)[]][], change: () => Promise<T>): Promise<T> {
	if (fixture === null || postgresUrl === null) throw new Error('fixture')
	const holder = new SQL({ url: postgresUrl, max: 1, connection: { search_path: fixture.schema } })
	const reserved = await holder.reserve()
	try {
		await reserved.unsafe('BEGIN')
		for (const [sql, binds] of statements) await reserved.unsafe(sql, binds)
		let settled = false
		const running = change().finally(() => {
			settled = true
		})
		await Bun.sleep(300)
		expect(settled).toBe(false)
		await reserved.unsafe('COMMIT')
		return await running
	} finally {
		reserved.release()
		await holder.close()
	}
}

describe.skipIf(!hasPostgres)("an application's delegated role changes on Postgres", () => {
	test('a reconcile widening the role, committed on another connection after the check: the grant writes and records nothing', async () => {
		// Another console's fixture, made first: making one reconciles the application's schema.
		const other = await membershipFixture(concurrent)
		const { f, grants, name } = await racing()
		const administrator = await holding(f, name('widen-admin'), 'administrator')
		const target = await f.person(name('widen-target'))
		grants.between = async () => {
			expect((await other.putSchema(WIDENED_STAFF_SCHEMA)).status).toBe(200)
		}
		const refused = await consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role: 'staff', email: `${name('widen-target')}@example.test` })
		expect([refused.status, errorType(refused.body)]).toEqual([409, 'conflict'])
		expect(await f.repositories.grants.listGrants(target.id)).toEqual([])
		expect(await recorded(f, administrator)).toBe(0)
	})

	test("a grant waits for a reconcile still holding the app's revision, then writes and records nothing", async () => {
		const { f, name } = await racing()
		const administrator = await holding(f, name('held-admin'), 'administrator')
		const target = await f.person(name('held-target'))
		const refused = await whileHeld(
			[
				['UPDATE app_schema_revisions SET revision = revision + 1 WHERE app = $1', [APP]],
				[`UPDATE roles SET permissions = $1 WHERE app = $2 AND role_key = 'staff'`, [
					JSON.stringify(['notes.read', 'notes.write', 'notes.share', 'notes.admin', 'notes.publish']),
					APP,
				]],
			],
			() => consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role: 'staff', email: `${name('held-target')}@example.test` }),
		)
		expect([refused.status, errorType(refused.body)]).toEqual([409, 'conflict'])
		expect(await f.repositories.grants.listGrants(target.id)).toEqual([])
		expect(await recorded(f, administrator)).toBe(0)
	})

	test("the administrator's role removed on another connection after the check: neither a grant nor a revoke lands", async () => {
		const { f, grants, name } = await racing()
		const administrator = await holding(f, name('removed-admin'), 'administrator')
		const [managing] = await f.repositories.grants.listGrants(administrator.id)
		if (managing === undefined) throw new Error('fixture')
		const supplement = await f.repositories.grants.createGrant({ principalId: administrator.id, app: APP, roleKey: 'support' })
		const target = await f.person(name('removed-target'))
		const staff = await holding(f, name('removed-staff'), 'staff')

		grants.between = () => concurrent.grants.deleteGrant(supplement.id)
		const granted = await consoleRpc(f, administrator.id, 'appPeople.grant', {
			app: APP,
			role: 'staff',
			email: `${name('removed-target')}@example.test`,
		})
		expect([granted.status, errorType(granted.body)]).toEqual([409, 'conflict'])
		expect(await f.repositories.grants.listGrants(target.id)).toEqual([])

		grants.between = () => concurrent.grants.deleteGrant(managing.id)
		const revoked = await consoleRpc(f, administrator.id, 'appPeople.revoke', { app: APP, role: 'staff', principalId: staff.id })
		expect([revoked.status, errorType(revoked.body)]).toEqual([409, 'conflict'])
		expect((await f.repositories.grants.listGrants(staff.id)).map((grant) => grant.role_key)).toEqual(['staff'])
		expect(await recorded(f, administrator)).toBe(0)
	})

	test("a revoke waits for a removal still holding the administrator's principal row, then removes and records nothing", async () => {
		const { f, name } = await racing()
		const administrator = await holding(f, name('waiting-admin'), 'administrator')
		const staff = await holding(f, name('waiting-staff'), 'staff')
		const revoked = await whileHeld(
			[
				['UPDATE principals SET grant_revision = grant_revision + 1 WHERE id = $1', [administrator.id]],
				["DELETE FROM grants WHERE principal_id = $1 AND app = $2 AND role_key = 'administrator'", [administrator.id, APP]],
			],
			() => consoleRpc(f, administrator.id, 'appPeople.revoke', { app: APP, role: 'staff', principalId: staff.id }),
		)
		expect([revoked.status, errorType(revoked.body)]).toEqual([409, 'conflict'])
		expect((await f.repositories.grants.listGrants(staff.id)).map((grant) => grant.role_key)).toEqual(['staff'])
		expect(await recorded(f, administrator)).toBe(0)
	})

	test('an undisturbed grant and revoke, the own role included, land with one record each', async () => {
		const { f, name } = await racing()
		const administrator = await holding(f, name('calm-admin'), 'administrator')
		const target = await f.person(name('calm-target'))
		const granted = await consoleRpc(f, administrator.id, 'appPeople.grant', { app: APP, role: 'staff', email: `${name('calm-target')}@example.test` })
		expect(granted.status).toBe(200)
		expect((await f.repositories.grants.listGrants(target.id)).map((grant) => grant.role_key)).toEqual(['staff'])
		const own = await consoleRpc(f, administrator.id, 'appPeople.revoke', { app: APP, role: 'administrator', principalId: administrator.id })
		expect(own.status).toBe(200)
		expect(await f.repositories.grants.listGrants(administrator.id)).toEqual([])
		expect(await recorded(f, administrator)).toBe(2)
	})
})
