// A generated endpoint access file among the run's files: it boots the application every other file boots.

import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, expect, test } from 'bun:test'
import { tables } from '../cloudflare-fixture/src/db/tables'
import { implementation } from './app'

const database = await testDatabase({ migrations: new URL('../cloudflare-fixture/db/migrations/', import.meta.url), label: 'endpoint-access' })
afterAll(() => database.close())
const kit = endpointAccessKit(implementation, tables, database)

test('endpoint access: a caller of one workspace reaches nothing of another', async () => {
	expect(await kit.denied('api.notes.titles', {})).toEqual({ status: 403 })
	expect(await kit.leaked('api.notes.titles', {})).toEqual({ answered: true, leaked: [] })
})
