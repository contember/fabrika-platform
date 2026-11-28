// The generated policy isolation cases of an application whose vocabulary declares a relation: the probe contract they
// boot keeps the vocabulary's relations, so a table that confers one, and a role that holds actions through it, compile.
// Without them every generated case of such an application failed to boot the probe.

import { defineApp } from '@fabrika/app/contract'
import { policyIsolationKit } from '@fabrika/app/testing/isolation'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { tables } from './relations-fixture/tables'
import { vocabulary } from './relations-fixture/vocabulary'

const app = defineApp(vocabulary, tables)
const contract = app.contract((c) => ({ health: c.health('/healthz') }))
const database = await testDatabase({
	migrations: new URL('./relations-fixture/db/migrations/', import.meta.url),
	label: 'policy-isolation-relations.test.ts',
})
afterAll(() => database.close())

describe('policy isolation of an application with a relation', () => {
	test('the probe of a dimension table boots and reaches only its own row', async () => {
		const kit = policyIsolationKit(contract, tables, 'projects', database)
		expect((await kit.get('own')).status).toBe(200)
		expect((await kit.get('other')).status).toBe(404)
	})
})
