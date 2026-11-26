// The database setup on a real PostgreSQL, run by a master that is no superuser (`LOGIN CREATEROLE CREATEDB`, the
// ACL position an RDS master meets): each service's user logs in to its own database and to no other service's, the
// setup's checks hold, and a second run (an upgrade) succeeds and keeps it so. It skips unless
// `FABRIKA_TEST_POSTGRES_URL` names a server whose user may create roles and databases (CLAUDE.md shows the
// `docker run` for one). The URL is a credential: it is never logged.
//
// The roles and databases are the setup's fixed names (`fabrika_iam`, …), cluster-wide: the suite drops any left by an
// earlier run before it starts and everything it made when it ends.

import { scramVerifier } from '@fabrika/platform-node/scram'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	AWS_DATABASE_SERVICES,
	awsDatabaseRole,
	type AwsDatabaseService,
	awsDatabaseSession,
	awsDatabaseSetupSteps,
	runAwsDatabaseSetup,
} from '../database'

const serverUrl = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? null
if (serverUrl === null) console.warn('database-setup.postgres.test.ts: skipped: set FABRIKA_TEST_POSTGRES_URL to run it')

const MASTER = 'fabrika_test_setup_master'
const MASTER_PASSWORD = 'Master0123456789abcdefghijABCDEF'
const PASSWORDS: Readonly<Record<AwsDatabaseService, string>> = {
	iam: 'Iam0123456789abcdefghijABCDEFGHIJ',
	control: 'Control0123456789abcdefghijABCDE',
	operations: 'Operations0123456789abcdefghijAB',
}

/** The server's URL as `user` with `password`, to `database`. */
function urlAs(user: string, password: string, database: string): string {
	const url = new URL(serverUrl ?? '')
	url.username = user
	url.password = password
	url.pathname = `/${database}`
	return url.toString()
}

/** Whether `user` logs in to `database`. */
async function connects(user: string, password: string, database: string): Promise<boolean> {
	const sql = new SQL({ url: urlAs(user, password, database), adapter: 'postgres', max: 1 })
	try {
		await sql.unsafe('SELECT 1')
		return true
	} catch {
		return false
	} finally {
		await sql.close()
	}
}

async function dropAll(admin: SQL): Promise<void> {
	for (const service of AWS_DATABASE_SERVICES) {
		const role = awsDatabaseRole(service)
		await admin.unsafe(`DROP DATABASE IF EXISTS "${role}" WITH (FORCE)`)
		await admin.unsafe(`DROP ROLE IF EXISTS "${role}"`)
	}
	await admin.unsafe(`DROP ROLE IF EXISTS "${MASTER}"`)
}

describe.skipIf(serverUrl === null)('the database setup on a real PostgreSQL, run by a master that is no superuser', () => {
	let admin: SQL | null = null

	beforeAll(async () => {
		admin = new SQL({ url: serverUrl ?? '', adapter: 'postgres', max: 1 })
		await dropAll(admin)
		await admin.unsafe(`CREATE ROLE "${MASTER}" WITH LOGIN CREATEROLE CREATEDB PASSWORD '${scramVerifier(MASTER_PASSWORD)}'`)
	})

	afterAll(async () => {
		if (admin === null) return
		await dropAll(admin)
		await admin.close()
	})

	test('each service logs in to its own database alone, on install and again after an upgrade', async () => {
		// The master works in the server's own database, as an RDS master works in `postgres`.
		const serverDatabase = new URL(serverUrl ?? '').pathname.slice(1) || 'postgres'
		for (const run of ['install', 'upgrade']) {
			const master = new SQL({ url: urlAs(MASTER, MASTER_PASSWORD, serverDatabase), adapter: 'postgres', max: 1 })
			try {
				// Throws when a step fails or a check does not hold.
				await runAwsDatabaseSetup(awsDatabaseSession(master), awsDatabaseSetupSteps(PASSWORDS))
			} finally {
				await master.close()
			}
			for (const service of AWS_DATABASE_SERVICES) {
				for (const other of AWS_DATABASE_SERVICES) {
					const reached = await connects(awsDatabaseRole(service), PASSWORDS[service], awsDatabaseRole(other))
					expect({ run, service, database: other, reached }).toEqual({ run, service, database: other, reached: service === other })
				}
			}
		}
	})
})
