// The leak sweep's case (`swept`) over a kit application (`access-fixture/`): a count that forgets its scope holds no
// value of another scope, so only the differential finds it, and the same count scoped passes. A mutation is not
// compared. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migration } from './access-fixture/migration'
import { accessApp } from './access-fixture/src/app'
import { tables } from './access-fixture/src/db/tables'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-leak-sweep-'))
writeFileSync(join(migrations, '20261012120000_notes.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'leak-sweep.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

const IN_ORGANIZATION = { organizationId: 'x' }
const VERSIONED = { id: '00000000-0000-4000-8000-000000000000', expectVersion: 1 }

describe.skipIf(postgres === null)('the leak sweep', () => {
	const kit = postgres === null ? undefined : endpointAccessKit(accessApp(), tables, postgres)
	const sweep = () => {
		if (kit === undefined) throw new Error('no database')
		return kit
	}

	test('a count that forgets its scope leaks no value, and changes when another scope gains a row', async () => {
		expect(await sweep().leaked('api.notes.noteCount', IN_ORGANIZATION)).toEqual({ answered: true, leaked: [] })
		expect(await sweep().swept('api.notes.noteCount', IN_ORGANIZATION)).toEqual({ answered: true, leaked: [], changed: true, unvaried: [] })
	})

	test('the same count scoped does not change', async () => {
		expect(await sweep().swept('api.notes.scopedNoteCount', IN_ORGANIZATION)).toEqual({ answered: true, leaked: [], changed: false, unvaried: [] })
	})

	test('a list that forgets its scope is found by its values too', async () => {
		const outcome = await sweep().swept('api.notes.everyTitle', IN_ORGANIZATION)
		expect(outcome.leaked.length).toBeGreaterThan(0)
		expect(outcome.changed).toBe(true)
	})

	test('a mutation is asked once, so its answer is not compared', async () => {
		expect(await sweep().swept('api.notes.retitle', VERSIONED)).toEqual({ answered: true, leaked: [], changed: null, unvaried: [] })
	})
})
