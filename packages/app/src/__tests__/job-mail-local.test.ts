// The local stack's mail path without Docker: `fabrika job run` of a `mailer: 'installation'` job, booted by the Bun
// adapter as the composed container boots it, captures its message with the `directory` provider under a loopback
// issuer, and refuses that provider behind any other issuer. Needs FABRIKA_TEST_POSTGRES_URL, since a job's lease
// lives in @fabrika/db.

import { runContractJob } from '@fabrika/app/bun'
import { defineApp } from '@fabrika/app/contract'
import { BootError, serve } from '@fabrika/app/implement'
import { transportMailKey } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { readCapturedEmails } from '@fabrika/email/directory'
import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_ID, frameworkEnvFor, keepingProcessEnvironment, PROXY_SECRET, serveStandInIam } from './fixtures/implement/harness'
import { migration } from './fixtures/scoped-notes/migration'
import { tables } from './fixtures/scoped-notes/src/db/tables'
import { vocabulary } from './fixtures/scoped-notes/src/vocabulary'

const URL_VARIABLE = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VARIABLE] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`job-mail-local.test.ts skipped: set ${URL_VARIABLE} to run it (a job's lease lives in @fabrika/db)`)
}

const app = defineApp(vocabulary, tables)
const notify = app.cron('* * * * *', { actions: ['notes.read'], mailer: 'installation' }).handle(async ({ ctx }) => {
	await ctx.mail.send({ to: 'ada@example.com', subject: 'Welcome aboard', text: 'Hello Ada', idempotencyKey: 'welcome-ada' })
})
const contract = app.contract(() => ({ jobs: { notify } }))
/** A fresh implementation per run: a data layer is bound once. */
const implementation = () => serve(contract, { database: scoped(tables) })

const appId = `jobmaillocal-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let directory = ''

describe.skipIf(!hasPostgres)("the local stack's directory provider, through fabrika job run", () => {
	beforeAll(async () => {
		const framework = { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS }
		await definePostgresApplicationMigrations({ appId, directory: '/unused', framework }).migrate(url, [{
			name: '20261015120000_notes.sql',
			sql: migration,
		}])
		directory = mkdtempSync(join(tmpdir(), 'fabrika-job-mail-local-'))
	})

	afterAll(async () => {
		rmSync(directory, { recursive: true, force: true })
		await dropApplicationDatabase(url, appId)
	})

	/** What the deploy of a local `mailer: 'installation'` contract writes, behind the IAM at `issuer`. */
	const variables = (issuer: string) => ({
		...frameworkEnvFor(implementation()),
		FABRIKA_IAM_ISSUER: issuer,
		FABRIKA_APP_ID: appId,
		FABRIKA_APP_RUNTIME_DATABASE_URL: applicationRuntimeUrl(url, appId),
		FABRIKA_PROXY_SECRET: PROXY_SECRET,
		FABRIKA_EMAIL_PROVIDER: 'directory',
		FABRIKA_EMAIL_FROM: 'Fabrika local <mail@local.test>',
		FABRIKA_EMAIL_DIRECTORY: directory,
	})
	const run = (env: Readonly<Record<string, string>>) =>
		keepingProcessEnvironment(() => runContractJob(() => Promise.resolve({ default: implementation() }), env, 'notify'))

	test('under a loopback issuer the job succeeds and its message is captured under its transport key', async () => {
		const iam = serveStandInIam(implementation())
		try {
			expect(await run(variables(iam.origin))).toEqual({ status: 'succeeded', attempts: 1 })
			const captured = await readCapturedEmails(directory)
			expect(captured.map((email) => email.idempotencyKey)).toEqual([transportMailKey({ issuer: iam.origin, appId: APP_ID }, 'welcome-ada')])
			expect(captured[0]).toMatchObject({ to: 'ada@example.com', subject: 'Welcome aboard', text: 'Hello Ada' })
		} finally {
			await iam.stop()
		}
	})

	test('behind any other issuer the provider is unknown, and the refusal names the variable and no value', async () => {
		const refused = await run(variables('https://iam.example.test')).then(() => null, (error: unknown) => error)
		if (!(refused instanceof BootError)) throw new Error('expected a BootError')
		expect(refused.problems).toEqual([
			"the installation's mail transport: FABRIKA_EMAIL_PROVIDER must be none or one of: resend, smartemailing",
		])
		expect(refused.message).not.toContain(directory)
	})
})
