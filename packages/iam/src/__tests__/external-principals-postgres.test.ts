// The external-role rule against concurrent writers on a REAL Postgres (ADR-0051): a grant write and a reconcile that
// narrows the role, in both orders, an invitation's acceptance with a narrowing between its statements, and a
// promotion against a password action's completion, and a login rehash against a completion and a password disable,
// all of which lock the principal row first. A
// test-only trigger pauses one transaction after one of its writes and before its commit, and the other
// runs on a second connection; the trigger decides only the schedule, both sides run their shipped SQL. SQLite and D1
// run one writer at a time, so only the batch guard of an acceptance is witnessed there. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset.

import { PostgresDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterEach, describe, expect, test } from 'bun:test'
import { type AuditEventInput, createPostgresIamRepositories, ExternalGrantError, type IamRepositories } from '../db'
import { createHarness } from './helpers/harness'
import { inviterCheck } from './helpers/membership'
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

/** Where a transaction pauses: a row written to `table` for which `when` holds. */
interface PausePoint {
	readonly table: string
	readonly when: string
}

/** The audit row of `action`, the last write of a change before its commit. */
const audited = (action: string): PausePoint => ({ table: 'audit_events', when: `NEW.action = '${action}'` })

/** A `password_accounts` write of a transaction on the fixture's own connection, which `pauseHere` marks. */
const ACCOUNT_WRITE: PausePoint = { table: 'password_accounts', when: `current_setting('race.pause', true) = 'on'` }

/** Mark the fixture's connection (a pool of one), so `ACCOUNT_WRITE` pauses its transactions and no other's. */
async function pauseHere(fixture: PostgresFixture): Promise<void> {
	await fixture.db.prepare(`SELECT set_config('race.pause', 'on', false)`).run()
}

/** Pause the transaction that writes at `point` before its commit: the trigger waits on an advisory lock this holds. */
async function pauseAt(fixture: PostgresFixture, point: PausePoint, lock: number): Promise<Pause> {
	if (postgresUrl === null) throw new Error('Postgres is required')
	const gate = new SQL({ url: postgresUrl, adapter: 'postgres', max: 1 })
	await gate.unsafe('SELECT pg_advisory_lock($1)', [lock])
	await fixture.db.prepare(`CREATE OR REPLACE FUNCTION race_pause() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF ${point.when} THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$`).run()
	await fixture.db.prepare(`CREATE TRIGGER race_pause AFTER INSERT OR UPDATE ON ${point.table} FOR EACH ROW EXECUTE FUNCTION race_pause()`).run()
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
		const pause = await pauseAt(fixture, audited('race.grant'), 1051101)
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
		const pause = await pauseAt(fixture, audited('race.reconcile'), 1051102)
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
		const pause = await pauseAt(fixture, audited('race.accept'), 1051103)
		open.push(() => pause.release())
		const accepting = repositories.membership.acceptInvitation(
			invitation,
			external.id,
			await inviterCheck(repositories, invitation, ['partner']),
			event('race.accept', external.id),
		)
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
		const pause = await pauseAt(fixture, audited('race.reconcile'), 1051104)
		open.push(() => pause.release())
		const narrowing = concurrent.appSchema.reconcileAppSchema(schema(false), event('race.reconcile', external.id))
		await pause.reached()
		const accepting = repositories.membership.acceptInvitation(invitation, external.id, await inviterCheck(repositories, invitation, ['partner']))
		await pause.blocked()
		await pause.release()

		await narrowing
		expect(await accepting).toBe('not_eligible')
		expect((await repositories.membership.getInvitationById(invitation.id))?.accepted_at).toBeNull()
		expect(await repositories.grants.listGrants(external.id)).toEqual([])
	}, 20000)
})

describe.skipIf(!hasPostgres)('a promotion and a password action completion on Postgres', () => {
	const password = { algorithm: 'test', parameters: '{}', salt: 'salt', passwordHash: 'hash' }

	async function enrolling(repositories: IamRepositories) {
		const external = await repositories.principals.inviteUser('ext@race.test', 'ext@race.test', undefined, 'external')
		await repositories.passwords.enableEnrollment(external.id)
		const expiresAt = Math.floor(Date.now() / 1000) + 600
		await repositories.passwords.issueActionToken({ principalId: external.id, purpose: 'enrollment', tokenHash: 'race-enrollment', expiresAt })
		return external
	}

	async function actions(repositories: IamRepositories, principalId: string): Promise<string[]> {
		return (await repositories.audit.listAuditEvents({ resourceId: principalId, limit: 10 })).map((row) => row.action).sort()
	}

	test('a completion first: the promotion waits for it, then both commit', async () => {
		const { repositories, concurrent, fixture } = await race()
		const external = await enrolling(repositories)
		const pause = await pauseAt(fixture, audited('race.complete'), 1051105)
		open.push(() => pause.release())
		const completing = repositories.passwords.completeAction(
			{ tokenHash: 'race-enrollment', purpose: 'enrollment', password },
			{ ...event('race.complete', external.id), resourceId: external.id },
		)
		await pause.reached()
		const promoting = concurrent.principals.promoteToInternal(external.id, { ...event('race.promote', external.id), resourceId: external.id })
		await pause.blocked()
		await pause.release()

		expect(await completing).toEqual({ principalId: external.id })
		expect(await promoting).toBe(true)
		expect((await repositories.principals.getPrincipalById(external.id))?.affiliation).toBe('internal')
		expect((await repositories.passwords.getAccount(external.id))?.state).toBe('enabled')
		expect(await actions(repositories, external.id)).toEqual(['race.complete', 'race.promote'])
	}, 20000)

	test('a promotion first: the completion waits for it and finds its action spent', async () => {
		const { repositories, concurrent, fixture } = await race()
		const external = await enrolling(repositories)
		const pause = await pauseAt(fixture, audited('race.promote'), 1051106)
		open.push(() => pause.release())
		const promoting = concurrent.principals.promoteToInternal(external.id, { ...event('race.promote', external.id), resourceId: external.id })
		await pause.reached()
		const completing = repositories.passwords.completeAction(
			{ tokenHash: 'race-enrollment', purpose: 'enrollment', password },
			{ ...event('race.complete', external.id), resourceId: external.id },
		)
		await pause.blocked()
		await pause.release()

		expect(await promoting).toBe(true)
		expect(await completing).toBeNull()
		expect((await repositories.principals.getPrincipalById(external.id))?.affiliation).toBe('internal')
		expect(await repositories.passwords.getCredential(external.id)).toBeNull()
		expect(await actions(repositories, external.id)).toEqual(['race.promote'])
	}, 20000)
})

describe.skipIf(!hasPostgres)('a password rehash against a completion and a password disable on Postgres', () => {
	const rehashed = { algorithm: 'rehashed', parameters: '{}', salt: 'salt', passwordHash: 'rehashed' }
	const reset = { algorithm: 'reset', parameters: '{}', salt: 'salt', passwordHash: 'reset' }

	/** An internal user with a password and a pending reset link: what a login rehash and a reset both write. */
	async function withPassword(repositories: IamRepositories) {
		const user = await repositories.principals.createUser('race-user', 'user@race.test')
		await repositories.passwords.upsertCredential(user.id, { algorithm: 'old', parameters: '{}', salt: 'salt', passwordHash: 'old' })
		const expiresAt = Math.floor(Date.now() / 1000) + 600
		await repositories.passwords.issueActionToken({ principalId: user.id, purpose: 'reset', tokenHash: 'race-reset', expiresAt })
		return user
	}

	async function actions(repositories: IamRepositories, principalId: string): Promise<string[]> {
		return (await repositories.audit.listAuditEvents({ resourceId: principalId, limit: 10 })).map((row) => row.action).sort()
	}

	test('a rehash holding the account: the completion waits at the principal, then both commit', async () => {
		const { repositories, concurrent, fixture } = await race()
		const user = await withPassword(repositories)
		const pause = await pauseAt(fixture, ACCOUNT_WRITE, 1051107)
		open.push(() => pause.release())
		await pauseHere(fixture)
		const rehashing = repositories.passwords.upsertCredential(user.id, rehashed, { ...event('race.rehash', user.id), resourceId: user.id })
		await pause.reached()
		const completing = concurrent.passwords.completeAction(
			{ tokenHash: 'race-reset', purpose: 'reset', password: reset },
			{ ...event('race.complete', user.id), resourceId: user.id },
		)
		await pause.blocked()
		await pause.release()

		await rehashing
		expect(await completing).toEqual({ principalId: user.id })
		expect((await repositories.passwords.getCredential(user.id))?.password_hash).toBe('reset')
		expect(await repositories.passwords.inspectActionToken('race-reset', 'reset')).toBeNull()
		expect(await actions(repositories, user.id)).toEqual(['race.complete', 'race.rehash'])
	}, 20000)

	test('a rehash holding the account: the password disable waits at the principal, then both commit', async () => {
		const { repositories, concurrent, fixture } = await race()
		const user = await withPassword(repositories)
		const pause = await pauseAt(fixture, ACCOUNT_WRITE, 1051108)
		open.push(() => pause.release())
		await pauseHere(fixture)
		const rehashing = repositories.passwords.upsertCredential(user.id, rehashed, { ...event('race.rehash', user.id), resourceId: user.id })
		await pause.reached()
		const disabling = concurrent.passwords.disableCredential(user.id, { ...event('race.disable', user.id), resourceId: user.id })
		await pause.blocked()
		await pause.release()

		await rehashing
		await disabling
		expect((await repositories.passwords.getAccount(user.id))?.state).toBe('disabled')
		expect(await repositories.passwords.getCredential(user.id)).toBeNull()
		expect(await repositories.passwords.inspectActionToken('race-reset', 'reset')).toBeNull()
		expect(await actions(repositories, user.id)).toEqual(['race.disable', 'race.rehash'])
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

		await expect(
			repositories.membership.acceptInvitation(
				invitation,
				external.id,
				await inviterCheck(repositories, invitation, ['partner']),
				event('race.accept', external.id),
			),
		).rejects.toThrow()
		expect((await repositories.membership.getInvitationById(invitation.id))?.accepted_at).toBeNull()
		expect(await repositories.audit.listAuditEvents({ action: 'race.accept', limit: 5 })).toEqual([])
	})
})
