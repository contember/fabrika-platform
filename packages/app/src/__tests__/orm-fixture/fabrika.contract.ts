// The kit fixture's CRM as a contract `boot` serves, for the mini-ORM's runtime: each procedure, the webhook and the
// job is a staged-kit site. The shell declares each site's reach, which the approved artifact carries; the handlers that
// reach data through `ctx.db` are the tree `app.ts` writes, so the handlers here are never served.

import { defineApp } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { tables } from '../kit-fixture/src/db/tables'
import { vocabulary } from '../kit-fixture/src/vocabulary'
export const ById = z.strictObject({ id: z.uuid() })
export const Columns = z.strictObject({ columns: z.array(z.string()) })
export const Margin = z.strictObject({ margin: z.nullable(z.number()), columns: z.array(z.string()) })
export const ReopenDeal = z.strictObject({ id: z.uuid(), expectVersion: z.int() })
export const Rename = z.strictObject({ id: z.uuid(), title: z.string(), expectVersion: z.int() })
export const Saved = z.strictObject({ id: z.uuid(), version: z.int() })
export const Ok = z.strictObject({ ok: z.boolean() })
export const Push = z.strictObject({ ref: z.string() })

/** A site of this shell: `app.ts` serves its own tree in its place. */
const servedByTheTree = (): never => {
	throw new Error('the orm fixture serves the handler tree app.ts writes')
}

// The harness serves the application `notes`; the vocabulary is the kit fixture's otherwise.
const kit = defineApp({ ...vocabulary, app: 'notes' }, tables)

const deals = kit.group({ callers: ['human'] }, (r) => ({
	columns: r.query({ input: ById, output: Columns, access: { action: 'crm.read', on: 'deal', from: 'id' } }).handle(servedByTheTree),
	margin: r.mutation({ input: ById, output: Margin, access: { action: 'deals.write', on: 'deal', from: 'id' } }).handle(servedByTheTree),
	reopen: r.mutation({ input: ReopenDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } }).handle(servedByTheTree),
	rename: r.mutation({ input: Rename, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } }).handle(servedByTheTree),
	retitle: r.query({ input: Rename, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' }, unscoped: { deals: 'read' } })
		.handle(servedByTheTree),
	keep: r.query({ input: ById, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' } }).handle(servedByTheTree),
	replay: r.query({ input: ById, output: Ok, access: { action: 'crm.read', on: 'deal', from: 'id' } }).handle(servedByTheTree),
}))

const github = kit.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'org', actions: ['crm.write'], input: Push }).handle(servedByTheTree)

const close = kit.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'], scope: 'app' }).handle(servedByTheTree)

export const contract = kit.contract((c) => ({
	api: c.rpc('/api', { deals }),
	github,
	health: c.health('/healthz'),
	jobs: { close },
}))
