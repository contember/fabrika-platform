// The kit fixture's CRM as a contract `boot` serves, for the mini-ORM's runtime: each procedure, the webhook and the
// job is a staged-kit site (`siteHandler` in `app.ts`), so its handler reaches data through `ctx.db` alone.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { vocabulary } from '../kit-fixture/src/vocabulary'

export const ById = z.strictObject({ id: z.uuid() })
export const Columns = z.strictObject({ columns: z.array(z.string()) })
export const Margin = z.strictObject({ margin: z.nullable(z.number()), columns: z.array(z.string()) })
export const ReopenDeal = z.strictObject({ id: z.uuid(), expectVersion: z.int() })
export const Rename = z.strictObject({ id: z.uuid(), title: z.string(), expectVersion: z.int() })
export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const Ok = z.strictObject({ ok: z.boolean() })
export const Push = z.strictObject({ ref: z.string() })

// The harness serves the application `notes`; the vocabulary is the kit fixture's otherwise.
export const contract = defineContract({ ...vocabulary, app: 'notes' }, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		deals: {
			columns: c.query({ input: ById, output: Columns, access: { action: 'crm.read', on: 'deal', from: 'id' } }),
			margin: c.mutation({ input: ById, output: Margin, access: { action: 'deals.write', on: 'deal', from: 'id' } }),
			reopen: c.mutation({ input: ReopenDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } }),
			rename: c.mutation({ input: Rename, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } }),
			retitle: c.query({ input: Rename, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' } }),
			keep: c.query({ input: ById, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' } }),
			replay: c.query({ input: ById, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' } }),
		},
	}),
	github: c.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'org', actions: ['crm.write'], input: Push }),
	health: c.health('/healthz'),
	jobs: { close: c.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'], scope: 'app' }) },
}))
