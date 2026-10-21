// An ALTCHA challenge through `boot`'s real pipeline, on a REAL Postgres: the application issues it at its own endpoint,
// behind that endpoint's buckets, and verifies the solution before the handler; a passed challenge is recorded, so its
// second use is a replay however its payload is spelled. Through the test kit it meets the production proxy decision.
// Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset (see scoped-database.test.ts).

import { createClient, RpcError } from '@fabrika/app/client'
import type { ContractApp } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { SQL } from 'bun'
import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '../implement'
import { BootError } from '../implement/boot'
import { altchaChallenge, MINIMAL_CHALLENGE_WORK } from '../implement/challenge'
import { solveChallengeAt } from '../testing/challenge'
import { altchaApp } from './fixtures/altcha/app'
import { contract } from './fixtures/altcha/fabrika.contract'
import { migration } from './fixtures/altcha/migration'
import { tables } from './fixtures/altcha/src/db/tables'
import { bootApp, environment, frameworkEnvFor, send, type Sent } from './fixtures/implement/harness'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-altcha-admission-'))
writeFileSync(join(migrations, '20261021090000_intake.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'altcha-admission.test.ts' })

// A test may first wait out the end of a database minute.
setDefaultTimeout(20_000)

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

const KEY = 'altcha-hmac-key-of-thirty-two-chars-1'
const REGISTER = '/api/signups.register'
const ISSUER = '/__fabrika/challenge/api_signups_register'

function start(): ContractApp {
	if (postgres === null) throw new Error('no database')
	return bootApp(altchaApp(), {
		database: postgres.database,
		environment: environment({ ...frameworkEnvFor(altchaApp()), ALTCHA_HMAC_KEY: KEY }),
		challengeWork: MINIMAL_CHALLENGE_WORK,
	})
}

const fromClient = (address: string): Record<string, string> => ({ 'Content-Type': 'application/json', 'X-Fabrika-Client-Ip': address })

/** A challenge the application issued at `issuer`, solved as the widget solves it. */
function solve(app: ContractApp, issuer = ISSUER, address = '203.0.113.7'): Promise<string> {
	return solveChallengeAt((input, init) => {
		const request = new Request(input, init)
		request.headers.set('X-Fabrika-Client-Ip', address)
		return app.fetch(request)
	}, `https://notes.test${issuer}`)
}

function register(app: ContractApp, challengeToken: string, address = '203.0.113.7'): Promise<Sent> {
	return send(app, REGISTER, { body: { name: 'Visitor', email: 'visitor@example.com', challengeToken }, headers: fromClient(address) })
}

async function admin<T>(work: (sql: SQL, schema: string) => Promise<T>): Promise<T> {
	if (postgres === null) throw new Error('no database')
	const sql = new SQL({ url: process.env['FABRIKA_TEST_POSTGRES_URL'] ?? '', adapter: 'postgres', max: 1 })
	try {
		return await work(sql, postgres.schema)
	} finally {
		await sql.close()
	}
}

async function registrations(): Promise<number> {
	const [row] = await admin((sql, schema) => sql.unsafe(`select count(*)::int as n from ${schema}.applications`))
	return Number(row?.n)
}

if (postgres !== null) {
	beforeEach(async () => {
		await admin((sql, schema) =>
			sql.unsafe(`delete from ${schema}.fabrika_form_admissions; delete from ${schema}.fabrika_form_challenges; delete from ${schema}.applications`)
		)
	})

	describe('a public procedure behind an ALTCHA challenge', () => {
		test('the application issues a challenge, and a solution of it registers once', async () => {
			const app = start()
			const issued = await send(app, ISSUER, { headers: fromClient('203.0.113.7') })
			expect(issued.status).toBe(200)
			expect(issued.headers.get('Cache-Control')).toBe('no-store')
			expect(issued.body).toMatchObject({ parameters: { algorithm: 'PBKDF2/SHA-256', data: { action: 'api_signups_register', host: 'notes.test' } } })
			const token = await solve(app)
			expect((await register(app, token)).status).toBe(200)
			expect(await registrations()).toBe(1)
		})

		test('a solution is accepted once: its replay, respelled or not, is a 400 and writes nothing', async () => {
			const app = start()
			const token = await solve(app)
			expect((await register(app, token)).status).toBe(200)
			const replay = await register(app, token)
			expect(replay).toMatchObject({ status: 400, body: { error: { type: 'challenge_failed' } } })
			const payload: unknown = JSON.parse(atob(token))
			const respelled = btoa(
				JSON.stringify({ solution: Reflect.get(Object(payload), 'solution'), challenge: Reflect.get(Object(payload), 'challenge') }),
			)
			expect((await register(app, respelled)).status).toBe(400)
			// A second instance reads the same record.
			expect((await register(start(), token)).status).toBe(400)
			expect(await registrations()).toBe(1)
		})

		test('a shorter-lived deployment retains a previous challenge through its signed expiry', async () => {
			const previous = altchaChallenge(KEY, { action: 'enroll', cost: 2000, maxAgeMs: 600_000 }, MINIMAL_CHALLENGE_WORK)
			const issued = await previous.issuer.issue('notes.test')
			const token = await solveChallengeAt(async () => Response.json(issued), 'https://notes.test/__fabrika/challenge/enroll')
			// This deployment issues enroll challenges for 120 seconds, with the same key and action.
			const app = start()
			const submit = () =>
				send(app, '/enroll', {
					body: { name: 'Visitor', email: 'visitor@example.com', challengeToken: token },
					headers: fromClient('203.0.113.7'),
				})
			expect((await submit()).status).toBe(200)
			const [record] = await admin((sql, schema) =>
				sql.unsafe(`select extract(epoch from expires_at)::float8 * 1000 as expires_ms from ${schema}.fabrika_form_challenges`)
			)
			expect(Number(record?.expires_ms)).toBeGreaterThan(Number(issued.parameters['expiresAt']) * 1000)
			expect((await submit()).status).toBe(400)
			expect(await registrations()).toBe(1)
		})

		test('a challenge issued for another procedure, or no solution at all, is a 400', async () => {
			const app = start()
			const enroll = await solve(app, '/__fabrika/challenge/enroll')
			expect((await register(app, enroll)).status).toBe(400)
			expect((await register(app, '')).status).toBe(400)
			expect((await register(app, btoa(JSON.stringify({ challenge: null, solution: null, test: true })))).status).toBe(400)
			expect(await registrations()).toBe(0)
		})

		test('the issuing endpoint has its own bucket per client, twice the procedure’s', async () => {
			const app = start()
			const statuses: number[] = []
			// Twice the procedure's 20 per client.
			for (let i = 0; i < 41; i++) {
				statuses.push((await send(app, ISSUER, { headers: fromClient('198.51.100.9') })).status)
			}
			expect(statuses.filter((status) => status === 200)).toHaveLength(40)
			expect(statuses.at(-1)).toBe(429)
			// The procedure's own bucket is untouched: the same client still registers.
			expect((await register(app, await solve(app, ISSUER, '198.51.100.10'), '198.51.100.9')).status).toBe(200)
		})

		test('the application does not boot without the variable its challenge names', () => {
			if (postgres === null) return
			expect(() => bootApp(altchaApp(), { database: postgres.database, environment: environment(frameworkEnvFor(altchaApp())) })).toThrow(BootError)
		})

		test('nor with a key short enough to guess from the signatures every challenge publishes, which no log names', () => {
			if (postgres === null) return
			const short = 'changeme-but-not-long-enough'
			let thrown: unknown
			try {
				bootApp(altchaApp(), { database: postgres.database, environment: environment({ ...frameworkEnvFor(altchaApp()), ALTCHA_HMAC_KEY: short }) })
			} catch (error) {
				thrown = error
			}
			expect(thrown).toBeInstanceOf(BootError)
			expect(String(thrown)).toContain('ALTCHA_HMAC_KEY, which holds fewer than 32 characters')
			expect(String(thrown)).not.toContain(short)
		})

		test('a path under the challenge prefix that no row serves is a 404', async () => {
			expect((await send(start(), '/__fabrika/challenge/unknown', { headers: fromClient('203.0.113.7') })).status).toBe(404)
		})
	})

	describe('through the test kit, behind the production proxy decision', () => {
		test('kit.solveChallenge solves the challenge of a client procedure, and the call registers', async () => {
			const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database, env: { ALTCHA_HMAC_KEY: KEY } })
			const api = createClient(contract, 'api', { fetch: kit.fetch, baseUrl: kit.origin })
			const challengeToken = await kit.solveChallenge(api.signups.register)
			expect(await api.signups.register({ name: 'Visitor', email: 'visitor@example.com', challengeToken })).toEqual({ received: true })
			const replay = api.signups.register({ name: 'Visitor', email: 'visitor@example.com', challengeToken })
			expect(replay).rejects.toBeInstanceOf(RpcError)
			expect(await api.signups.enroll({ name: 'Other', email: 'other@example.com', challengeToken: await kit.solveChallenge(api.signups.enroll) }))
				.toEqual({ received: true })
		})

		test('a page on a listed origin reads the challenge cross-origin; the browser keeps it from any other', async () => {
			const kit = testKit(serve(contract, { database: scoped(tables) }), {
				database: postgres.database,
				env: { ALTCHA_HMAC_KEY: KEY },
				crossOrigins: ['https://www.example.com'],
			})
			const listed = await kit.fetch(new URL(ISSUER, kit.origin), { headers: { Origin: 'https://www.example.com' } })
			expect(listed.status).toBe(200)
			expect(listed.headers.get('Access-Control-Allow-Origin')).toBe('https://www.example.com')
			// A simple GET needs no preflight: the proxy answers it, without the header a browser needs to hand it to the page.
			const other = await kit.fetch(new URL(ISSUER, kit.origin), { headers: { Origin: 'https://evil.example.com' } })
			expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull()
		})

		test('the generated cases boot without the HMAC key and see a 400 without a solved challenge', async () => {
			const kit = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)
			expect(await kit.anyone('api.signups.register', { name: 'Visitor', email: 'visitor@example.com', challengeToken: 'x' })).toEqual({
				answered: false,
				status: 400,
			})
		})
	})
}
