// The leak sweep over a kit application (`access-fixture/`): a count that forgets its scope holds no value of another
// scope, so only the differential finds it; the same count scoped passes; what the sweep cannot compare is a hint, and a
// leak it found stays found when a later ask fails. The plan: what it asks, and a hint for what it does not. The
// sweep's cases skip cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { planSweep, sweepCase } from '../testing/leak-sweep'
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

describe('the leak sweep plans in memory', () => {
	const { cases, hints } = planSweep(accessApp(), tables, { inputs: { 'api.notes.gone': {} }, seeds: { 'api.notes.list': { trashed: true } } })

	test('every endpoint on, in or over a dimension is a case; the link procedure and the app form are not', () => {
		const planned = cases.map((item) => item.endpoint)
		expect(planned).toContain('api.notes.noteCount')
		expect(planned).toContain('api.notes.list')
		expect(planned).not.toContain('shared.note')
		expect(cases.find((item) => item.endpoint === 'api.notes.get')?.input).toEqual({ id: '00000000-0000-4000-8000-000000000000' })
	})

	test('what it does not ask, and an option it does not use, is a hint', () => {
		expect(hints).toEqual([
			'api.notes.allTitles: declares unscoped, so it reaches across scopes by design; the sweep does not ask it',
			'api.notes.bySlug: the sweep cannot sample its input schema (a pattern, or bounds it cannot meet); give the input in inputs',
			'api.notes.list: lists over a dimension and addresses no row, so its seed in seeds is not used',
			'api.notes.gone: inputs names it, but the sweep asks no such endpoint',
		])
	})

	test('an application with no endpoint in a dimension plans nothing, and says why', () => {
		const vocabulary = defineVocabulary({ app: 'plain', dimensions: {}, actions: { 'notes.read': 'Read notes' }, roles: {} })
		const app = defineApp(vocabulary)
		const api = app.group({ callers: ['human'] }, (r) => ({
			count: r.query({ output: z.strictObject({ count: z.int() }), access: { action: 'notes.read', app: true } }).handle(() => ({ count: 0 })),
		}))
		const plan = planSweep(serve(app.contract((c) => ({ api: c.rpc('/api', { api }) })), { database: null }), {})
		expect(plan).toEqual({
			cases: [],
			hints: ['no endpoint is on, in or over a dimension, so no answer can hold rows of another scope; the sweep asks nothing'],
		})
	})
})

describe.skipIf(postgres === null)('a case of the leak sweep', () => {
	const kit = postgres === null ? undefined : endpointAccessKit(accessApp(), tables, postgres)
	const sweep = () => {
		if (kit === undefined) throw new Error('no database')
		return kit
	}
	const swept = (endpoint: string, input: Readonly<Record<string, unknown>> = IN_ORGANIZATION) => sweepCase(sweep(), { endpoint, input, seed: {} })

	test('a count that forgets its scope leaks no value, and changes when another scope gains a row', async () => {
		expect(await sweep().leaked('api.notes.noteCount', IN_ORGANIZATION)).toEqual({ answered: true, leaked: [] })
		expect(await sweep().swept('api.notes.noteCount', IN_ORGANIZATION)).toEqual({ leaked: [], differential: 'changed', hints: [] })
		expect((await swept('api.notes.noteCount')).found).toEqual(['the answer to one scope changed when only rows of scopes it does not hold were added'])
	})

	test('the same count scoped does not change', async () => {
		expect(await swept('api.notes.scopedNoteCount')).toEqual({ found: [], hints: [] })
	})

	test('a list that forgets its scope is found by its values too', async () => {
		const { found } = await swept('api.notes.everyTitle')
		expect(found.length).toBeGreaterThan(1)
		expect(found).toContain('the answer to one scope changed when only rows of scopes it does not hold were added')
	})

	test('an answer that changes by itself is not compared, and says so', async () => {
		expect(await swept('api.notes.stampedCount')).toEqual({
			found: [],
			hints: [
				"api.notes.stampedCount: its answer changed between two asks with nothing changed (a time, the caller's id, a member made per ask), so the sweep did not compare it with rows added elsewhere",
			],
		})
	})

	test('a leak the values show stays found when the answer turns into a refusal once rows were added elsewhere', async () => {
		const { found } = await swept('api.notes.refusedOnceGrown')
		expect(found.length).toBeGreaterThan(1)
		expect(found).toContain('the answer to one scope changed when only rows of scopes it does not hold were added')
	})

	test('a case it cannot set up is a hint, not a failure', async () => {
		const { found, hints } = await swept('api.notes.get', { id: 'not-a-uuid', extra: true })
		expect(found).toEqual([])
		expect(hints[0]).toStartWith("api.notes.get: the case's input does not match the endpoint's input schema")
	})

	test('a mutation is asked once, so its answer is not compared', async () => {
		expect(await sweep().swept('api.notes.retitle', VERSIONED)).toEqual({ leaked: [], differential: 'not-compared', hints: [] })
	})
})
