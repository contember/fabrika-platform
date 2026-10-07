import { afterAll, beforeAll, describe } from 'bun:test'
import { leaseContract } from './helpers/lease'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`lease-postgres.test.ts ${skipReason}`)

let fixture: PostgresFixture
beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('lease')
})
afterAll(async () => {
	if (hasPostgres) await fixture.close()
})

describe.skipIf(!hasPostgres)('lease on Postgres', () => {
	leaseContract(() => fixture.db)
})
