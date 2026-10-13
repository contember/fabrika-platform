// The external-role rule against concurrent writers on a REAL Postgres (ADR-0051): a grant write and a reconcile that
// narrows the role, in both orders, and an invitation's acceptance with a narrowing between its statements. A
// test-only trigger on `audit_events` pauses one transaction after its change and before its commit, and the other
// runs on a second connection; the trigger decides only the schedule, both sides run their shipped SQL. SQLite and D1
// run one writer at a time, so only the batch guard of an acceptance is witnessed there. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset.

import { PostgresDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterEach, describe, expect, test } from 'bun:test'
import { type AuditEventInput, createPostgresIamRepositories, ExternalGrantError, type IamRepositories } from '../db'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, postgresUrl, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`external-principals-postgres.test.ts ${skipReason}`)
}

const APP = 'race@stage'
const SCOPE = { type: 'workspace', value: 'race-workspace' }

function schema(external: boolean) {
	return {
		app: APP,
		scopes: [{ scopeType: SCOPE.type }],
		actions: [{ action: 'notes.read' }],
		roles: [{ roleKey: 'partner', name: 'Partner', permissions: ['notes.read'], memberScope: SCOPE.type, assignableBy: ['partner'], external }],
		contract: true,
	}
}

function event(action: string, principalId: string): AuditEventInput {
	return { requestId: `req-${action}`, principalId, principalLabel: principalId, app: APP, action, resourceType: 'test' }
}

interface Pause {
	/** Resolves once a transaction is held at the pause. */
	reached(): Promise<void>
	/** Resolves once a transaction other than the paused one waits on a row lock. */
	blocked(): Promise<void>
	release(): Promise<void>
}

/** Pause the transaction that records `action` before its commit: its audit row waits on an advisory lock this holds. */
async function pauseAt(fixture: PostgresFixture, action: string, lock: number): Promise<Pause> {
	if (postgresUrl === null) throw new Error('Postgres is required')
	const gate = new SQL({ url: postgresUrl, adapter: 'postgres', max: 1 })
	await gate.unsafe('SELECT pg_advisory_lock($1)', [lock])
	await fixture.db.prepare(`CREATE OR REPLACE FUNCTION race_pause() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.action = '${action}' THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`).run()
	await fixture.db.prepare('CREATE TRIGGER race_pause BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION race_pause()').run()
	const until = async (sql: string, args: unknown[], what: string) => {
		for (let attempt = 0; attempt < 500; attempt += 1) {
			const rows = await gate.unsafe<{ found: boolean }[]>(sql, args)
			if (rows[0]?.found === true) return
			await Bun.sleep(10)
		}
		throw new Error(`timed out waiting for ${what}`)
	}
	let released = false
	return {
		reached: () =>
			until(
				`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted) AS found`,
				[lock],
				'the pause',
			),
		blocked: () =>
			until(
				`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype IN ('transactionid', 'tuple') AND NOT granted) AS found`,
				[],
				'a blocked writer',
			),
		async release() {
			if (released) return
			released = true
			await gate.unsafe('SELECT pg_advisory_unlock($1)', [lock])
			await gate.close()
		},
	}
}

interface Race {
	readonly repositories: IamRepositories
	readonly concurrent: IamRepositories
	readonly fixture: PostgresFixture
}

const open: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const close of open.splice(0).reverse()) await close()
})

async function race(): Promise<Race> {
	if (postgresUrl === null) throw new Error('Postgres is required')
	const fixture = await createPostgres('iam_external_race')
	const second = PostgresDatabase.connect(postgresUrl, { connection: { search_path: fixture.schema }, max: 1 })
	open.push(() => fixture.close(), () => second.close())
	const repositories = createPostgresIamRepositories(fixture.db)
	await repositories.appSchema.reconcileAppSchema(schema(true))
	return { repositories, concurrent: createPostgresIamRepositories(second), fixture }
}

describe.skipIf(!hasPostgres)('the external-role rule under concurrent writers on Postgres', () => {
	test('a grant write first: the narrowing waits for it and its batch guard rolls it back', async () => {
		const { repositories, concurrent, fixture } = await race()
		const external = await repositories.principals.inviteUser('ext@race.test', 'ext@race.test', undefined, 'external')
		const pause = await pauseAt(fixture, 'race.grant', 1051101)
		open.push(() => pause.release())
		const grant = { principalId: external.id, app: APP, roleKey: 'partner', scopeType: SCOPE.type, scopeValue: SCOPE.value }
		const granting = repositories.grants.createGrant(grant, () => event('race.grant', external.id))
		await pause.reached()
		const narrowing = concurrent.appSchema.reconcileAppSchema(schema(false)).then(() => 'committed', () => 'rolled back')
		await pause.blocked()
		await pause.release()

		expect((await granting).principal_id).toBe(external.id)
		expect(await narrowing).toBe('rolled back')
		expect((await repositories.appSchema.getRole(APP, 'partner'))?.external).toBe(1)
	}, 20000)

	test('a narrowing first: the grant write waits for it and writes nothing', async () => {
		const { repositories, concurrent, fixture } = await race()
		const external = await repositories.principals.inviteUser('ext@race.test', 'ext@race.test', undefined, 'external')
		const pause = await pauseAt(fixture, 'race.reconcile', 1051102)
		open.push(() => pause.release())
		const narrowing = concurrent.appSchema.reconcileAppSchema(schema(false), event('race.reconcile', external.id))
		await pause.reached()
		const grant = { principalId: external.id, app: APP, roleKey: 'partner', scopeType: SCOPE.type, scopeValue: SCOPE.value }
		const granting = repositories.grants.createGrant(grant).then(() => 'granted', (cause) => cause)
		await pause.blocked()
		await pause.release()

		await narrowing
		expect(await granting).toBeInstanceOf(ExternalGrantError)
		expect(await repositories.grants.listGrants(external.id)).toEqual([])
		expect((await repositories.appSchema.getRole(APP, 'partner'))?.external).toBe(0)
	}, 20000)

	test('an acceptance holds the role across its statements: a narrowing between them waits and rolls back', async () => {
		const { repositories, concurrent, fixture } = await race()
		const external = await repositories.principals.inviteUser('ext@race.test', 'ext@race.test', undefined, 'external')
		const inviter = await repositories.principals.createUser('race-inviter', 'inviter@race.test')
		await repositories.grants.createGrant({ principalId: inviter.id, app: APP, roleKey: 'partner', scopeType: SCOPE.type, scopeValue: SCOPE.value })
		const { invitation } = await repositories.membership.openInvitation({
			tokenHash: 'race-invitation',
			app: APP,
			scope: SCOPE,
			roleKey: 'partner',
			email: 'ext@race.test',
			invitedBy: inviter.id,
			expiresAt: Math.floor(Date.now() / 1000) + 600,
		})
		const pause = await pauseAt(fixture, 'race.accept', 1051103)
		open.push(() => pause.release())
		const accepting = repositories.membership.acceptInvitation(invitation, external.id, ['partner'], event('race.accept', external.id))
		await pause.reached()
		const narrowing = concurrent.appSchema.reconcileAppSchema(schema(false)).then(() => 'committed', () => 'rolled back')
		await pause.blocked()
		await pause.release()

		expect(await accepting).toBe('accepted')
		expect(await narrowing).toBe('rolled back')
		expect((await repositories.grants.listGrants(external.id)).map((grant) => grant.role_key)).toEqual(['partner'])
	}, 20000)

	test('a narrowing before an acceptance: the acceptance waits, consumes nothing and answers not_eligible', async () => {
		const { repositories, concurrent, fixture } = await race()
		const external = await repositories.principals.inviteUser('ext@race.test', 'ext@race.test', undefined, 'external')
		const inviter = await repositories.principals.createUser('race-inviter', 'inviter@race.test')
		await repositories.grants.createGrant({ principalId: inviter.id, app: APP, roleKey: 'partner', scopeType: SCOPE.type, scopeValue: SCOPE.value })
		const { invitation } = await repositories.membership.openInvitation({
			tokenHash: 'race-invitation',
			app: APP,
			scope: SCOPE,
			roleKey: 'partner',
			email: 'ext@race.test',
			invitedBy: inviter.id,
			expiresAt: Math.floor(Date.now() / 1000) + 600,
		})
		const pause = await pauseAt(fixture, 'race.reconcile', 1051104)
		open.push(() => pause.release())
		const narrowing = concurrent.appSchema.reconcileAppSchema(schema(false), event('race.reconcile', external.id))
		await pause.reached()
		const accepting = repositories.membership.acceptInvitation(invitation, external.id, ['partner'])
		await pause.blocked()
		await pause.release()

		await narrowing
		expect(await accepting).toBe('not_eligible')
		expect((await repositories.membership.getInvitationById(invitation.id))?.accepted_at).toBeNull()
		expect(await repositories.grants.listGrants(external.id)).toEqual([])
	}, 20000)
})

describe('an acceptance whose grant writes nothing', () => {
	test('rolls back: the invitation stays open and nothing is recorded', async () => {
		const h = createHarness()
		const repositories = h.repositories
		await repositories.appSchema.reconcileAppSchema(schema(true))
		const external = await repositories.principals.inviteUser('ext@race.test', 'ext@race.test', undefined, 'external')
		const inviter = await repositories.principals.createUser('race-inviter', 'inviter@race.test')
		await repositories.grants.createGrant({ principalId: inviter.id, app: APP, roleKey: 'partner', scopeType: SCOPE.type, scopeValue: SCOPE.value })
		const { invitation } = await repositories.membership.openInvitation({
			tokenHash: 'race-invitation',
			app: APP,
			scope: SCOPE,
			roleKey: 'partner',
			email: 'ext@race.test',
			invitedBy: inviter.id,
			expiresAt: Math.floor(Date.now() / 1000) + 600,
		})
		// Stands in for a grant insert that matches nothing after the invitation was consumed.
		h.sqlite.exec(`CREATE TRIGGER drop_grant BEFORE INSERT ON grants WHEN NEW.principal_id = '${external.id}' BEGIN SELECT RAISE(IGNORE); END`)

		await expect(repositories.membership.acceptInvitation(invitation, external.id, ['partner'], event('race.accept', external.id))).rejects.toThrow()
		expect((await repositories.membership.getInvitationById(invitation.id))?.accepted_at).toBeNull()
		expect(await repositories.audit.listAuditEvents({ action: 'race.accept', limit: 5 })).toEqual([])
	})
})
