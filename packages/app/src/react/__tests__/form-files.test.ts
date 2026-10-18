// A form that takes files, submitted under `installDom`, as a screen test of a page submits it: happy-dom replaces the
// stream classes, and the upload digests its file through Bun's. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import './dom'

import type { ChallengeFetch } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { applicationSchema, Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { migration } from '../../__tests__/fixtures/form-files/migration'
import { signupApp } from '../../__tests__/fixtures/form-files/src/app'

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const schema = applicationSchema(`signup-dom-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const opened: Database[] = []

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (url === '') return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
})

afterAll(async () => {
	if (url === '') return
	for (const connection of opened) await connection.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

const siteverify: ChallengeFetch = async (_request, check) =>
	Response.json({ success: true, challenge_ts: new Date().toISOString(), hostname: check.hostname, action: check.action })

describe.skipIf(url === '')('a form with a file under installDom', () => {
	test('is received: the file streams through the stream classes of Bun', async () => {
		const database = Database.postgres({ url, schema, max: 2 })
		opened.push(database)
		const store = new MemoryFileObjects()
		const kit = testKit(signupApp(), { database, files: store, challengeFetch: siteverify, env: { TURNSTILE_SECRET: 'turnstile-secret' } })
		const body = new FormData()
		body.append('input', JSON.stringify({ email: 'jana@example.com', name: 'Jana', challengeToken: 'token-dom' }))
		body.append('photo', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], 'jana.jpg', { type: 'image/jpeg' }))
		const answer = await kit.fetch('/register', { method: 'POST', body, headers: { Origin: kit.origin } })
		expect(answer.status).toBe(200)
		expect(store.objects.size).toBe(1)
		await kit.drain()
	})
})
