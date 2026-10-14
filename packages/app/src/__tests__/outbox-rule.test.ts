// The rule the generated tests hold a request handler to: it calls no outside service; it records an outbox row in its
// own transaction, and a job sends it. The generated cases boot the application without its variables, so a handler
// that calls out answers 500 there, and the one that records the row answers 200. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset.

import { defineApp } from '@fabrika/app/contract'
import { defineDeps, serve } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { tables } from './kit-fixture/src/db/tables'
import { vocabulary } from './kit-fixture/src/vocabulary'
import { migration } from './orm-fixture/migration'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-outbox-rule-'))
writeFileSync(join(migrations, '20261014120000_init.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'outbox-rule.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

/** A mail provider's client, which reads its variable where it is used, as the skill says. */
const mailer = defineDeps((env) => ({
	async send(signal: AbortSignal): Promise<void> {
		const url = env['MAIL_API_URL']
		if (typeof url !== 'string' || url === '') {
			throw new Error('the application variable MAIL_API_URL is not set')
		}
		await fetch(url, { method: 'POST', signal })
	},
}))

const app = defineApp(vocabulary, tables)
const Notify = z.strictObject({ id: z.string() })
const Notified = z.strictObject({ ok: z.boolean() })

const deals = app.group({ callers: ['human'] }, (r) => ({
	/** Records the notification in the request's transaction: a job sends it. */
	notify: r.mutation({ input: Notify, output: Notified, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			await ctx.db.target.deal_activities.insert({ body: 'notify the owner' })
			return { ok: true }
		}),
	/** Calls the provider from the handler: what the rule forbids. */
	notifyNow: r.mutation({ input: Notify, output: Notified, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			await mailer.get().send(ctx.signal)
			return { ok: true }
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { deals }), health: c.health('/healthz') }))

if (postgres !== null) {
	describe('an outbound call in the generated cases', () => {
		const kit = endpointAccessKit(serve(contract, { database: scoped(tables), deps: mailer }), tables, postgres)

		test('a handler that records an outbox row reaches its own object; one that calls out answers 500', async () => {
			expect(await kit.own('api.deals.notify', { id: 'x' })).toEqual({ status: 200 })
			const log = spyOn(console, 'error').mockImplementation(() => {})
			try {
				expect(await kit.own('api.deals.notifyNow', { id: 'x' })).toEqual({ status: 500 })
			} finally {
				log.mockRestore()
			}
		})
	})
}
