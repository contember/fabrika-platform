// The leak sweep and the endpoint access kit over an application with `anyOf` endpoints (`any-of-fixture/`): the sweep
// plans without throwing and names each `anyOf` endpoint as one it does not ask; the kit's `scoped` case holds every listed
// action in one scope only (403), and its `global` case asks once per listed action, each holder of only that one, and
// once with every listed action held. The kit's cases skip cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { endpointAccessKit } from '../testing/endpoint-access'
import { planSweep } from '../testing/leak-sweep'
import { contract } from './any-of-fixture/fabrika.contract'
import { tables } from './any-of-fixture/src/db/tables'
import { vocabulary } from './any-of-fixture/src/vocabulary'

const MIGRATION = `
CREATE TABLE desks (
	id text PRIMARY KEY,
	label text NOT NULL,
	status text NOT NULL,
	audit_note text NOT NULL,
	created_by text NOT NULL,
	version integer NOT NULL
);
CREATE TABLE entries (
	id text PRIMARY KEY,
	desk_id text NOT NULL,
	amount integer NOT NULL,
	created_by text NOT NULL
);
`

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-any-of-access-'))
writeFileSync(join(migrations, '20261120100000_desks.sql'), MIGRATION)
const postgres = await testDatabase({ migrations, label: 'any-of-access-kit.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

describe('the leak sweep over anyOf endpoints', () => {
	test('plans without throwing, and names each anyOf endpoint as one it does not ask', () => {
		expect(planSweep(serve(contract, { database: scoped(tables) }), tables)).toEqual({
			cases: [],
			hints: [
				'api.cash.detail: admits any of several actions application-wide, so it answers no scope of its own; the sweep does not ask it',
				'api.cash.list: admits any of several actions application-wide, so it answers no scope of its own; the sweep does not ask it',
				'api.cash.record: admits any of several actions application-wide, so it answers no scope of its own; the sweep does not ask it',
				'no endpoint is on, in or over a dimension, so no answer can hold rows of another scope; the sweep asks nothing',
			],
		})
	})
})

describe.skipIf(postgres === null)('the endpoint access kit over anyOf endpoints', () => {
	const kit = postgres === null ? null : endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)

	test('a caller holding every listed action in one scope only is refused', async () => {
		expect(await kit?.scoped('api.cash.list', {})).toEqual({ status: 403 })
		expect(await kit?.scoped('api.cash.record', { deskId: 'd', amount: 1 })).toEqual({ status: 403 })
	})

	test('each listed action held alone globally is asked: the list answers each, the write refuses the one its table does not name', async () => {
		expect(await kit?.global('api.cash.list', {})).toEqual({ answered: true })
		expect(await kit?.global('api.cash.record', { deskId: 'd', amount: 1 })).toEqual({ answered: false, status: 403 })
	})
})

describe.skipIf(postgres === null)('the endpoint access kit over an anyOf endpoint that fails only under every listed action', () => {
	const app = defineApp(vocabulary, tables)
	// Answers each listed action held alone, and fails where the actions meet: only the call holding them all finds it.
	const combined = app.group({ callers: ['human'] }, (r) => ({
		board: r.query({ output: z.strictObject({}), access: { anyOf: ['cash.read', 'cash.audit'], app: true } }).handle(({ ctx }) => {
			if (ctx.app.actions.length > 1) throw new Error('the reaches of two actions met')
			return {}
		}),
	}))
	const kit = postgres === null
		? null
		: endpointAccessKit(serve(app.contract((c) => ({ api: c.rpc('/api', { combined }) })), { database: scoped(tables) }), tables, postgres)

	test('global asks once more with every listed action held, and reports its 500', async () => {
		expect(await kit?.global('api.combined.board', {})).toEqual({ answered: false, status: 500 })
	})
})
