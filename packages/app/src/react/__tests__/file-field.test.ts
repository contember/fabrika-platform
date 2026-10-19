// A procedure's file field, sent under `installDom` as a screen test of a page sends it: happy-dom replaces the stream
// classes, and the upload digests its file through Bun's. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import './dom'

import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { contract } from '../../__tests__/stored-files-fixture/fabrika.contract'
import { tables } from '../../__tests__/stored-files-fixture/src/db/tables'
import { passingChallenge } from '../../testing/challenge'

const postgres = await testDatabase({
	migrations: join(import.meta.dir, '..', '..', '__tests__', 'stored-files-fixture', 'db', 'migrations'),
	label: 'react/file-field.test.ts',
})

afterAll(async () => {
	await postgres?.close()
})

describe.skipIf(postgres === null)('a file field under installDom', () => {
	test('is received: the file streams through the stream classes of Bun', async () => {
		if (postgres === null) return
		const admin = new SQL({ url: process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '', adapter: 'postgres', max: 1 })
		try {
			await admin.unsafe(`insert into ${postgres.schema}.deals (id, org_id, name) values ('d1', 'o1', 'One')`)
		} finally {
			await admin.close()
		}
		const store = new MemoryFileObjects()
		const kit = testKit(serve(contract, { database: scoped(tables) }), {
			database: postgres.database,
			files: store,
			challengeFetch: passingChallenge,
			env: { TURNSTILE_SECRET: 'secret', TURNSTILE_SITE_KEY: 'site-key' },
		})
		const staff = kit.testCaller([{ action: 'deals.write', scope: { type: 'org', value: 'o1' } }])
		const body = new FormData()
		body.append('input', JSON.stringify({ dealId: 'd1', name: 'Offer' }))
		body.append('file', new File([new TextEncoder().encode('%PDF-1.7\n%%EOF\n')], 'offer.pdf', { type: 'application/pdf' }))
		const answer = await kit.browser(staff)('/api/attachments.upload', { method: 'POST', body })
		expect(answer.status).toBe(200)
		expect(store.objects.size).toBe(1)
		await kit.drain()
	})
})
