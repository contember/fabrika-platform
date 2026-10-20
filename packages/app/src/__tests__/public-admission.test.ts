// A public procedure's admission through `boot`'s real pipeline, on a REAL Postgres: the per-client buckets and the
// endpoint's ceiling every instance shares, each charged before the body is read, and the challenge against a stand-in
// siteverify. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see scoped-database.test.ts).

import type { ChallengeFetch, ContractApp } from '@fabrika/app/implement'
import { applicationSchema, Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { BootError } from '../implement/boot'
import { bootApp, environment, frameworkEnvFor, send, type Sent } from './fixtures/implement/harness'
import { migration } from './fixtures/intake/migration'
import { intakeApp } from './fixtures/intake/src/app'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`public-admission.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const appId = `intake-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
/** The harness serves `https://notes.test`: the widget must have run on that host. */
const HOST = 'notes.test'
const opened: Database[] = []

// A test may first wait out the end of a database minute (up to six seconds).
setDefaultTimeout(20_000)

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

async function count(table: string, where = 'true'): Promise<number> {
	const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.${table} where ${where}`))
	return Number(row?.n)
}

/** Every counter lives in one database minute; a test that started a second before it ends would see two. */
async function awayFromMinuteEdge(): Promise<void> {
	const [row] = await admin((sql) => sql.unsafe('select extract(second from now())::float8 as second'))
	const second = Number(row?.second)
	if (second > 55) {
		await Bun.sleep((61 - second) * 1000)
	}
}

interface Siteverify {
	readonly calls: string[]
	answer: (token: string) => Response | Promise<Response>
}

function siteverify(): Siteverify {
	return {
		calls: [],
		answer: (token) => passed(token),
	}
}

function passed(_token: string, overrides: Record<string, unknown> = {}): Response {
	return Response.json({ success: true, challenge_ts: new Date().toISOString(), hostname: HOST, action: 'api_intake_apply', ...overrides })
}

/** A fresh instance of the application over the shared schema, as a second container would be. */
function start(verify: Siteverify = siteverify()): ContractApp {
	const connection = Database.postgres({ url, schema, max: 2 })
	opened.push(connection)
	const app = intakeApp()
	const challengeFetch: ChallengeFetch = async (request) => {
		const form = new URLSearchParams(await request.text())
		const token = form.get('response') ?? ''
		verify.calls.push(token)
		return verify.answer(token)
	}
	return bootApp(app, {
		database: connection,
		environment: environment({ ...frameworkEnvFor(app), TURNSTILE_SECRET: 'turnstile-secret-1' }),
		challengeFetch,
	})
}

function fromClient(address: string | null, extra: Record<string, string> = {}): Record<string, string> {
	return { 'Content-Type': 'application/json', ...(address === null ? {} : { 'X-Fabrika-Client-Ip': address }), ...extra }
}

function contact(app: ContractApp, address: string | null, body = 'hello', extra: Record<string, string> = {}): Promise<Sent> {
	return send(app, '/api/intake.contact', { body: { email: 'visitor@example.com', body }, headers: fromClient(address, extra) })
}

function apply(app: ContractApp, address: string, fields: Record<string, unknown> = {}): Promise<Sent> {
	return send(app, '/api/intake.apply', {
		body: { name: 'Visitor', email: 'visitor@example.com', challengeToken: `token-${Bun.randomUUIDv7()}`, ...fields },
		headers: fromClient(address),
	})
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
})

beforeEach(async () => {
	if (!hasPostgres) {
		return
	}
	await admin((sql) =>
		sql.unsafe(
			`delete from ${schema}.fabrika_form_admissions; delete from ${schema}.fabrika_form_challenges; delete from ${schema}.applications; delete from ${schema}.messages`,
		)
	)
	await awayFromMinuteEdge()
}, 20_000)

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	for (const connection of opened) {
		await connection.close()
	}
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)('the per-client bucket', () => {
	test('one address empties its bucket, and another address still submits', async () => {
		const app = start()
		const first = [await contact(app, '203.0.113.7'), await contact(app, '203.0.113.7'), await contact(app, '203.0.113.7')]
		expect(first.map((sent) => sent.status)).toEqual([200, 200, 429])
		expect((await contact(app, '198.51.100.20')).status).toBe(200)
		expect(await count('messages')).toBe(3)
	})

	test('two instances share one bucket per client', async () => {
		const one = start()
		const two = start()
		expect((await contact(one, '203.0.113.8')).status).toBe(200)
		expect((await contact(two, '203.0.113.8')).status).toBe(200)
		expect((await contact(one, '203.0.113.8')).status).toBe(429)
		expect((await contact(two, '203.0.113.8')).status).toBe(429)
	})

	test('every request of the client counts, a refused input included, before the body is read', async () => {
		const app = start()
		const refused = await send(app, '/api/intake.contact', { body: { email: 'not an address', body: 'x' }, headers: fromClient('203.0.113.9') })
		expect(refused.status).toBe(400)
		expect((await contact(app, '203.0.113.9')).status).toBe(200)
		expect((await contact(app, '203.0.113.9')).status).toBe(429)
	})

	test('only X-Fabrika-Client-Ip names the client: a forwarding header a client writes changes nothing', async () => {
		const app = start()
		const statuses: number[] = []
		for (const forwarded of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
			statuses.push((await contact(app, '203.0.113.10', 'hello', { 'X-Forwarded-For': forwarded, 'CF-Connecting-IP': forwarded })).status)
		}
		expect(statuses).toEqual([200, 200, 429])
	})

	test('a request without the client address shares one bucket with every other such request', async () => {
		const app = start()
		expect([(await contact(app, null)).status, (await contact(app, null)).status, (await contact(app, 'garbage')).status]).toEqual([200, 200, 429])
	})

	test('one IPv6 subscriber prefix is one client', async () => {
		const app = start()
		expect((await contact(app, '2001:db8:1:2::1')).status).toBe(200)
		expect((await contact(app, '2001:db8:1:2:ffff::9')).status).toBe(200)
		expect((await contact(app, '2001:db8:1:2:0:0:0:3')).status).toBe(429)
		expect((await contact(app, '2001:db8:1:3::1')).status).toBe(200)
	})
})

describe.skipIf(!hasPostgres)("the endpoint's ceiling", () => {
	test('two instances share it, whichever client submits', async () => {
		const one = start()
		const two = start()
		const statuses = [
			(await contact(one, '203.0.113.21')).status,
			(await contact(two, '203.0.113.22')).status,
			(await contact(one, '203.0.113.23')).status,
			(await contact(two, '203.0.113.24')).status,
			(await contact(one, '203.0.113.25')).status,
		]
		expect(statuses).toEqual([200, 200, 200, 200, 429])
		expect(await count('messages')).toBe(4)
	})

	test('a past minute is expired: the next admission prunes its rows', async () => {
		const app = start()
		await admin((sql) =>
			sql.unsafe(
				`insert into ${schema}.fabrika_form_admissions (form, bucket, window_start, count)
				select 'api.intake.contact', 'client:old-' || n, date_trunc('minute', now()) - interval '5 minutes', 9 from generate_series(1, 20) n`,
			)
		)
		expect((await contact(app, '203.0.113.30')).status).toBe(200)
		expect(await count('fabrika_form_admissions', `window_start < date_trunc('minute', now())`)).toBe(0)
	})
})

describe.skipIf(!hasPostgres)('the challenge', () => {
	test('a token the provider refuses is a 400 and writes no row', async () => {
		const verify = siteverify()
		verify.answer = () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] })
		const app = start(verify)
		const sent = await apply(app, '203.0.113.50')
		// A 0.5 form answered a failed challenge so: a caller on another origin sees no change.
		expect(sent.status).toBe(400)
		expect(sent.body).toEqual({ error: { type: 'challenge_failed', message: 'The challenge did not verify; solve it again' } })
		expect(await count('applications')).toBe(0)
	})

	test('an unreachable provider is a 503 and writes no row', async () => {
		const verify = siteverify()
		verify.answer = () => Promise.reject(new TypeError('connection refused'))
		const app = start(verify)
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await apply(app, '203.0.113.51')).status).toBe(503)
			verify.answer = () => new Response('bad gateway', { status: 502 })
			expect((await apply(app, '203.0.113.52')).status).toBe(503)
		} finally {
			log.mockRestore()
		}
		expect(await count('applications')).toBe(0)
	})

	test('a token for another host, another action or one too old is a 400', async () => {
		const verify = siteverify()
		const app = start(verify)
		const answers = [
			{ hostname: 'evil.example' },
			{ action: 'api_intake_contact' },
			{ challenge_ts: new Date(Date.now() - 10 * 60_000).toISOString() },
			{ challenge_ts: 'yesterday' },
		]
		for (const [index, overrides] of answers.entries()) {
			verify.answer = (token) => passed(token, overrides)
			expect((await apply(app, `203.0.113.${60 + index}`)).status).toBe(400)
		}
		expect(await count('applications')).toBe(0)
	})

	test('a token is accepted once: its replay is a 400, whatever the provider answers', async () => {
		const app = start()
		const token = 'token-replayed'
		expect((await apply(app, '203.0.113.70', { challengeToken: token })).status).toBe(200)
		expect((await apply(app, '203.0.113.71', { challengeToken: token })).status).toBe(400)
		expect(await count('applications')).toBe(1)
	})

	test("Turnstile's test-widget token is single use too: only app dev admits it again", async () => {
		const app = start()
		expect((await apply(app, '203.0.113.72', { challengeToken: 'XXXX.DUMMY.TOKEN.XXXX' })).status).toBe(200)
		expect((await apply(app, '203.0.113.73', { challengeToken: 'XXXX.DUMMY.TOKEN.XXXX' })).status).toBe(400)
		expect(await count('applications')).toBe(1)
	})

	test("refused challenges take from the endpoint's ceiling: every bucket is charged before the body is read", async () => {
		const verify = siteverify()
		verify.answer = () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] })
		const app = start(verify)
		const statuses: number[] = []
		for (let index = 0; index < 6; index++) {
			statuses.push((await apply(app, `198.51.100.${index + 1}`)).status)
		}
		expect(statuses).toEqual([400, 400, 400, 400, 400, 429])
		expect(await count('applications')).toBe(0)
	})

	test('a provider that refuses the secret is a 503, not the visitor’s fault', async () => {
		const verify = siteverify()
		verify.answer = () => Response.json({ success: false, 'error-codes': ['invalid-input-secret'] })
		const app = start(verify)
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await apply(app, '203.0.113.80')).status).toBe(503)
		} finally {
			log.mockRestore()
		}
	})

	test('the application does not boot without the variable its challenge names', () => {
		const app = intakeApp()
		const connection = Database.postgres({ url, schema, max: 1 })
		opened.push(connection)
		expect(() => bootApp(app, { database: connection })).toThrow(BootError)
		expect(() => bootApp(intakeApp(), { database: connection })).toThrow(
			"procedure 'api.intake.apply' verifies its turnstile challenge with the application variable TURNSTILE_SECRET, which is not set",
		)
	})
})
