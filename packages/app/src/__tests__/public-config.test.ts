// The public values a page reads from `<prefix>/__fabrika-config.json`: a form challenge's site key, served by every
// SPA mount, and the variables an SPA mount lists in `public`, served by that mount only. No other variable of the
// environment, the challenge's secret above all. The contract names each one, so the approval shows them. The form
// half boots a form, which needs the framework tables: it runs on a REAL Postgres and skips without
// FABRIKA_TEST_POSTGRES_URL.

import { compileContract, ContractError, defineContract } from '@fabrika/app/contract'
import { applicationSchema, Database, scoped } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { BootError } from '../implement/boot'
import { implement } from '../implement/implement'
import { bootApp, environment, frameworkEnvFor, grant, send, token } from './fixtures/implement/harness'
import { Application } from './fixtures/intake/fabrika.contract'
import { migration } from './fixtures/intake/migration'
import { tables } from './fixtures/intake/src/db/tables'
import { vocabulary } from './fixtures/intake/src/vocabulary'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`public-config.test.ts skipped its Postgres half: set ${URL_VAR} to run it`)
}

const VALUES = {
	SIGNUP_URL: 'https://signup.example.com/start',
	TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
	TURNSTILE_SECRET: 'turnstile-secret-1',
	MAIL_API_KEY: 'mail-key-1',
}

/** A public site that lists one public variable, and a member SPA beside it that lists none. */
const sites = defineContract(vocabulary, (c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true }, public: ['SIGNUP_URL'] }),
	hr: c.spa('/hr', { dir: 'dist/hr', access: { member: true } }),
}))

const sitesApp = () => implement(sites, { database: null, deps: () => ({}), handlers: () => ({}) })

/** The same, with a form whose challenge names its site key beside its secret. */
const intake = defineContract(vocabulary, (c) => ({
	apply: c.form('/apply', {
		input: Application,
		appendTo: 'applications',
		honeypot: 'website',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' },
	}),
	contact: c.form('/contact', { input: z.strictObject({ email: z.email(), body: z.string() }), appendTo: 'messages' }),
	site: c.spa('/', { dir: 'dist/site', access: { public: true }, public: ['SIGNUP_URL'] }),
	hr: c.spa('/hr', { dir: 'dist/hr', access: { member: true } }),
}))

function problemsOf(compile: () => unknown): readonly string[] {
	try {
		compile()
	} catch (error) {
		if (error instanceof ContractError) return error.problems
		throw error
	}
	throw new Error('the contract compiled')
}

describe('public variables in the artifact', () => {
	test('a challenge carries its site key and an SPA mount its public variables, by name', () => {
		const artifact = compileContract(intake, tables)
		expect(artifact.mounts['apply']).toMatchObject({
			challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SITE_KEY' },
		})
		expect(artifact.mounts['site']).toEqual({ kind: 'spa', prefix: '/', dir: 'dist/site', public: ['SIGNUP_URL'] })
		expect(artifact.mounts['hr']).toEqual({ kind: 'spa', prefix: '/hr', dir: 'dist/hr' })
	})

	test('a variable named both as a secret and as public is refused, and so is a name that is no application variable', () => {
		const leaking = defineContract(vocabulary, (c) => ({
			apply: c.form('/apply', {
				input: Application,
				appendTo: 'applications',
				honeypot: 'website',
				challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey: 'TURNSTILE_SECRET' },
			}),
			contact: c.form('/contact', { input: z.strictObject({ email: z.email(), body: z.string() }), appendTo: 'messages' }),
			site: c.spa('/', { dir: 'dist/site', access: { public: true }, public: ['TURNSTILE_SECRET', 'FABRIKA_PROXY_SECRET', 'signup url'] }),
		}))
		expect(problemsOf(() => compileContract(leaking, tables))).toEqual([
			"mount 'site': public \"FABRIKA_PROXY_SECRET\" is not the name of an application variable (allowed: 'SIGNUP_URL'; never a value, never FABRIKA_*)",
			"mount 'site': public \"signup url\" is not the name of an application variable (allowed: 'SIGNUP_URL'; never a value, never FABRIKA_*)",
			"mount 'apply': challenge siteKey 'TURNSTILE_SECRET' is the secret of form 'apply'; a secret is never public",
			"mount 'site': public 'TURNSTILE_SECRET' is the secret of form 'apply'; a secret is never public",
		])
	})
})

describe('the public values of an SPA mount', () => {
	test("the config file holds the mount's declared values and no other variable", async () => {
		const app = bootApp(sitesApp(), { environment: environment({ ...frameworkEnvFor(sitesApp()), ...VALUES }) })
		const site = await send(app, '/__fabrika-config.json')
		expect(site.status).toBe(200)
		expect(site.body).toEqual({ dsn: null, release: null, public: { SIGNUP_URL: VALUES.SIGNUP_URL } })
		const hr = await send(app, '/hr/__fabrika-config.json', { token: await token('user', [grant('applications.read')]) })
		expect(hr.body).toEqual({ dsn: null, release: null })
	})

	test('a declared variable that is not set refuses the boot', () => {
		expect(() => bootApp(sitesApp())).toThrow(BootError)
		expect(() => bootApp(sitesApp())).toThrow("mount 'site' serves the public variable SIGNUP_URL, which is not set")
	})
})

const schema = applicationSchema(`pubcfg-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
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
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const connection of opened) await connection.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)("a form challenge's site key", () => {
	const intakeApp = () => implement(intake, { database: scoped(tables), deps: () => ({}), handlers: () => ({}) })

	function start(variables: Readonly<Record<string, string>>) {
		const connection = Database.postgres({ url, schema, max: 2 })
		opened.push(connection)
		return bootApp(intakeApp(), { database: connection, environment: environment({ ...frameworkEnvFor(intakeApp()), ...variables }) })
	}

	test('every SPA mount serves it beside its own values, and never the secret', async () => {
		const app = start(VALUES)
		const site = await send(app, '/__fabrika-config.json')
		expect(site.body).toEqual({
			dsn: null,
			release: null,
			public: { TURNSTILE_SITE_KEY: VALUES.TURNSTILE_SITE_KEY, SIGNUP_URL: VALUES.SIGNUP_URL },
		})
		const hr = await send(app, '/hr/__fabrika-config.json', { token: await token('user', [grant('applications.read')]) })
		expect(hr.body).toEqual({ dsn: null, release: null, public: { TURNSTILE_SITE_KEY: VALUES.TURNSTILE_SITE_KEY } })
		expect(JSON.stringify([site.body, hr.body])).not.toContain(VALUES.TURNSTILE_SECRET)
	})

	test('without its variable the application does not boot', () => {
		const { TURNSTILE_SITE_KEY: _siteKey, ...withoutSiteKey } = VALUES
		expect(() => start(withoutSiteKey)).toThrow("form 'apply' names its turnstile site key in TURNSTILE_SITE_KEY, which is not set")
	})
})
