// The rows a global case's caller holds (`callerRows`): an application whose handlers look up the caller's own record
// (a person's card bound to the account) before they answer refuses a caller without one, so a global case reaches the
// handler only when the kit seeds that record for its caller, and removes it once the case is over. On SQLite, which
// needs no service.

import { ForbiddenError } from '@fabrika/app'
import { defineApp, defineVocabulary, GENERATED_CALLER } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const vocabulary = defineVocabulary({
	app: 'staff',
	dimensions: { site: {} },
	actions: { 'shifts.read': 'Read shifts' },
	roles: { staff: { grants: ['shifts.read'] } },
})

interface DB {
	people: { id: string; nickname: string; principal_id: string | null }
}

const columns: TypedColumnList<DB> = { people: { columns: ['id', 'nickname', 'principal_id'], foreignKeys: [] } }

const tables = defineTables(vocabulary, columns)({
	people: { scope: { app: 'the cards of the staff' }, actions: { read: 'shifts.read' } },
})

const app = defineApp(vocabulary, tables)
const Card = z.strictObject({ nickname: z.string() })
const shifts = app.group({ callers: ['human'] }, (r) => ({
	mine: r.query({ output: Card, access: { action: 'shifts.read', app: true } })
		.handle(async ({ ctx }) => {
			const card = (await ctx.db.app.people.list({ where: [['principal_id', '=', ctx.principal.id]], limit: 1 })).items[0]
			if (card === undefined) throw new ForbiddenError('No card is bound to this account.')
			return { nickname: card.nickname }
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { shifts }) }))

const migrations = mkdtempSync(join(tmpdir(), 'caller-rows-'))
writeFileSync(
	join(migrations, '20261120120000_init.sql'),
	'CREATE TABLE people (id TEXT PRIMARY KEY NOT NULL, nickname TEXT NOT NULL, principal_id TEXT UNIQUE);\n',
)
const database = await testDatabase({ migrations, label: 'endpoint-access-caller-rows.test.ts' })
afterAll(async () => {
	await database.close()
	rmSync(migrations, { recursive: true, force: true })
})

describe("the rows a global case's caller holds", () => {
	test("with them, each global case's caller finds its own record", async () => {
		const kit = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, database, {
			callerRows: { people: { principal_id: GENERATED_CALLER } },
		})
		expect(await kit.global('api.shifts.mine', {})).toEqual({ answered: true })
		expect(await kit.global('api.shifts.mine', {})).toEqual({ answered: true })
	})

	// A new kit's first caller has the id the last kit's first caller had, so a record left behind would answer it.
	test('without them, a handler that looks up the caller refuses it: no case left its record behind', async () => {
		const kit = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, database)
		expect(await kit.global('api.shifts.mine', {})).toEqual({ answered: false, status: 403 })
	})
})
