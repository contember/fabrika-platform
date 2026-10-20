// The public values a page reads from `<prefix>/__fabrika-config.json`: a public procedure's challenge site key, served
// by every SPA mount, and the variables an SPA mount lists in `public`, served by that mount only. No other variable of
// the environment, the challenge's secret above all. The contract names each one, so the approval shows them. The
// challenge half boots a public procedure, which needs the framework tables: it runs on a REAL Postgres and skips without
// FABRIKA_TEST_POSTGRES_URL.

import { compileContract, ContractError, defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { BootError } from '../implement/boot'
import { bootApp, environment, frameworkEnvFor, grant, send, token } from './fixtures/implement/harness'
import { app } from './public-fixture/src/app-kit'
import { tables } from './public-fixture/src/db/tables'
import { vocabulary } from './public-fixture/src/vocabulary'

const APP_ID = 'intake@prod'

const VALUES = {
	SIGNUP_URL: 'https://signup.example.com/start',
	GREETING_PREFIX: ' Hello ',
	TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
	TURNSTILE_SECRET: 'turnstile-secret-1',
	MAIL_API_KEY: 'mail-key-1',
}

const Apply = z.strictObject({ name: z.string(), challengeToken: z.string() })
const Empty = z.strictObject({})

/** A public site that lists one public variable, and a member SPA beside it that lists none: no tables, no database. */
const sites = defineApp(vocabulary).contract((c) => ({
	site: c.spa('/', { dir: 'dist/site', access: { public: true }, browserConfig: ['SIGNUP_URL', 'GREETING_PREFIX'] }),
	hr: c.spa('/hr', { dir: 'dist/hr', access: { member: true } }),
}))

const sitesApp = () => serve(sites, { database: null })

/** A public procedure whose challenge names its site key beside its secret. */
const applying = (siteKey: string) =>
	app.group({}, (r) => ({
		apply: r.mutation({
			input: Apply,
			output: Empty,
			access: { public: true },
			actions: ['intake.register'],
			admission: { challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET', siteKey } },
		}).handle(() => ({})),
	}))

/** The same sites, beside the public procedure. */
const intake = app.contract((c) => ({
	api: c.rpc('/api', { join: applying('TURNSTILE_SITE_KEY') }),
	site: c.spa('/', { dir: 'dist/site', access: { public: true }, browserConfig: ['SIGNUP_URL'] }),
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
		expect(artifact.procedures?.['api.join.apply']?.challenge).toEqual({
			provider: 'turnstile',
			secret: 'TURNSTILE_SECRET',
			siteKey: 'TURNSTILE_SITE_KEY',
		})
		expect(artifact.mounts['site']).toEqual({ kind: 'spa', prefix: '/', dir: 'dist/site', public: ['SIGNUP_URL'] })
		expect(artifact.mounts['hr']).toEqual({ kind: 'spa', prefix: '/hr', dir: 'dist/hr' })
	})

	test('a variable named both as a secret and as public is refused, and so is a name that is no application variable', () => {
		const leaking = app.contract((c) => ({
			api: c.rpc('/api', { join: applying('TURNSTILE_SECRET') }),
			site: c.spa('/', { dir: 'dist/site', access: { public: true }, browserConfig: ['TURNSTILE_SECRET', 'FABRIKA_PROXY_SECRET', 'signup url'] }),
		}))
		expect(problemsOf(() => compileContract(leaking, tables))).toEqual([
			"mount 'site': browserConfig \"FABRIKA_PROXY_SECRET\" is not the name of an application variable (allowed: 'SIGNUP_URL'; never a value, never FABRIKA_*)",
			"mount 'site': browserConfig \"signup url\" is not the name of an application variable (allowed: 'SIGNUP_URL'; never a value, never FABRIKA_*)",
			"procedure 'api.join.apply': challenge siteKey 'TURNSTILE_SECRET' is the secret of the challenge of 'api.join.apply'; a secret is never public",
			"mount 'site': browserConfig 'TURNSTILE_SECRET' is the secret of the challenge of 'api.join.apply'; a secret is never public",
		])
	})
})

describe('the public values of an SPA mount', () => {
	test("the config file holds the mount's declared values and no other variable", async () => {
		const served = bootApp(sitesApp(), { environment: environment({ ...frameworkEnvFor(sitesApp()), FABRIKA_IAM_APP_ID: APP_ID, ...VALUES }) })
		const site = await send(served, '/__fabrika-config.json')
		expect(site.status).toBe(200)
		// A value is served verbatim: the page and the server put the same string together.
		expect(site.body).toEqual({ dsn: null, release: null, environment: null, public: { SIGNUP_URL: VALUES.SIGNUP_URL, GREETING_PREFIX: ' Hello ' } })
		const hr = await send(served, '/hr/__fabrika-config.json', { token: await token('user', [grant('intake.read')], APP_ID) })
		expect(hr.body).toEqual({ dsn: null, release: null, environment: null })
	})

	test('a declared variable that is not set refuses the boot', () => {
		const unset = { environment: environment({ ...frameworkEnvFor(sitesApp()), FABRIKA_IAM_APP_ID: APP_ID }) }
		expect(() => bootApp(sitesApp(), unset)).toThrow(BootError)
		expect(() => bootApp(sitesApp(), unset)).toThrow("mount 'site' serves the public variable SIGNUP_URL, which is not set")
	})
})

const postgres = await testDatabase({ migrations: join(import.meta.dir, 'public-fixture', 'db', 'migrations'), label: 'public-config.test.ts' })

afterAll(async () => {
	await postgres?.close()
})

describe.skipIf(postgres === null)("a public procedure challenge's site key", () => {
	const intakeApp = () => serve(intake, { database: scoped(tables) })

	function start(variables: Readonly<Record<string, string>>) {
		if (postgres === null) throw new Error('the suite runs on Postgres only')
		return bootApp(intakeApp(), {
			database: postgres.database,
			environment: environment({ ...frameworkEnvFor(intakeApp()), FABRIKA_IAM_APP_ID: APP_ID, ...variables }),
		})
	}

	test('every SPA mount serves it beside its own values, and never the secret', async () => {
		const served = start(VALUES)
		const site = await send(served, '/__fabrika-config.json')
		expect(site.body).toEqual({
			dsn: null,
			release: null,
			environment: null,
			public: { TURNSTILE_SITE_KEY: VALUES.TURNSTILE_SITE_KEY, SIGNUP_URL: VALUES.SIGNUP_URL },
		})
		const hr = await send(served, '/hr/__fabrika-config.json', { token: await token('user', [grant('intake.read')], APP_ID) })
		expect(hr.body).toEqual({ dsn: null, release: null, environment: null, public: { TURNSTILE_SITE_KEY: VALUES.TURNSTILE_SITE_KEY } })
		expect(JSON.stringify([site.body, hr.body])).not.toContain(VALUES.TURNSTILE_SECRET)
	})

	test('without its variable the application does not boot', () => {
		const { TURNSTILE_SITE_KEY: _siteKey, ...withoutSiteKey } = VALUES
		expect(() => start(withoutSiteKey)).toThrow("procedure 'api.join.apply' names its turnstile site key in TURNSTILE_SITE_KEY, which is not set")
	})
})
