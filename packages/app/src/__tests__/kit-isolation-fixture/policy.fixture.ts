// A generated policy isolation file among the run's files: its probe binds a data layer of its own over the same tables.

import { policyIsolationKit } from '@fabrika/app/testing/isolation'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, expect, test } from 'bun:test'
import { tables } from '../cloudflare-fixture/src/db/tables'
import { contract } from './app'

const database = await testDatabase({ migrations: new URL('../cloudflare-fixture/db/migrations/', import.meta.url), label: 'policy' })
afterAll(() => database.close())
const kit = policyIsolationKit(contract, tables, 'notes', database)

test('policy: a caller of one workspace reaches no note of another', async () => {
	expect((await kit.get('own')).status).toBe(200)
	expect((await kit.get('other')).status).toBe(404)
	expect(await kit.list()).toEqual({ status: 200, rows: ['own'] })
})
