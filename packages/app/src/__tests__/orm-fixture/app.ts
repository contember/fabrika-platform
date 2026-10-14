// The handler tree `serve` builds for the orm-crm contract, written directly: each leaf is a staged-kit site
// (`siteHandler`), so `boot` gives it `ctx.db`. The handlers read `ctx` untyped, as the kit's types are not what this
// fixture tests; `hooks` lets a test pause a handler, make it fail, or keep a handle past its invocation.

import { ConflictError } from '@fabrika/app'
import type { ContractImplementation } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { z } from 'zod/v4'
import { siteHandler } from '../../implement/invocation'
import { tables } from '../kit-fixture/src/db/tables'
import { contract } from './fabrika.contract'

export interface OrmHooks {
	/** Runs while `deals.reopen` holds its row's lock. */
	afterLock: () => Promise<void>
	/**
	 * What `deals.rename` does after its write, or before it: `'undeclared sql'` calls `ctx.sql`, which it does not
	 * declare, and `'set nothing'` updates with `{}`.
	 */
	rename: 'answer' | 'throw' | 'refused output' | 'undeclared sql' | 'set nothing'
	/** Runs while `deals.keep` and the job keep their handles live. */
	whileKept: () => Promise<void>
	/** The handles a handler kept past its invocation. */
	kept: { target?: unknown; jobData?: unknown; jobRef?: unknown; refusal?: string }
	/** What the job does with the lead deals it lists; `'undeclared sql'` calls `tx.sql.scope` first, which it does not declare. */
	job: 'in its transaction' | 'outside its transaction' | 'undeclared sql'
	/** Each delivery's company name, as the webhook handler saw it. */
	readonly deliveries: string[]
	failNextDelivery: boolean
}

export function ormHooks(): OrmHooks {
	return {
		afterLock: () => Promise.resolve(),
		rename: 'answer',
		whileKept: () => Promise.resolve(),
		kept: {},
		job: 'in its transaction',
		deliveries: [],
		failNextDelivery: false,
	}
}

/** An object or a function, such as `ctx.sql` with its `scope`. */
function isHolder(value: unknown): value is object {
	return (typeof value === 'object' && value !== null) || typeof value === 'function'
}

/** `path` of `node`, read through own and prototype properties alike, as a handler's `ctx.db.target.get` reads. */
function at(node: unknown, path: string): unknown {
	return path.split('.').reduce<unknown>((value, part) => (isHolder(value) ? Reflect.get(value, part) : undefined), node)
}

/** Calls the method at `path`, with its holder as `this`. */
async function call(node: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const holder = parts.length === 0 ? node : at(node, parts.join('.'))
	const method = isHolder(holder) ? Reflect.get(holder, name) : undefined
	if (typeof method !== 'function') {
		throw new TypeError(`${path} is not a method`)
	}
	return Reflect.apply(method, holder, args)
}

/** Runs `work` and keeps the message of what it threw, which the server log never shows, then throws it on. */
async function kept(hooks: OrmHooks, work: () => Promise<unknown>): Promise<void> {
	try {
		await work()
	} catch (error) {
		hooks.kept.refusal = error instanceof Error ? error.message : String(error)
		throw error
	}
}

function field(value: unknown, name: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
}

function columnsOf(row: unknown): string[] {
	return typeof row === 'object' && row !== null ? Object.keys(row).sort() : []
}

export function ormApp(hooks: OrmHooks): ContractImplementation<typeof contract> {
	const tree = {
		api: {
			deals: {
				columns: siteHandler(async ({ ctx }) => ({ columns: columnsOf(await call(ctx, 'db.target.get')) }), undefined),
				margin: siteHandler(async ({ ctx }) => {
					const deal = await call(ctx, 'db.target.get')
					return { margin: field(deal, 'margin'), columns: columnsOf(deal) }
				}, undefined),
				reopen: siteHandler(async ({ input, ctx }) => {
					const deal = await call(ctx, 'db.target.getForUpdate')
					await hooks.afterLock()
					const stage = field(deal, 'stage')
					if (stage !== 'won' && stage !== 'lost') {
						throw new ConflictError('only a won or lost deal reopens')
					}
					return call(ctx, 'db.target.update', { stage: 'proposal' }, { expectVersion: field(input, 'expectVersion') })
				}, undefined),
				rename: siteHandler(async ({ input, ctx }) => {
					if (hooks.rename === 'undeclared sql') {
						await kept(hooks, () => call(ctx, 'sql', z.object({ n: z.number() })))
					}
					const values = hooks.rename === 'set nothing' ? {} : { title: field(input, 'title') }
					const saved = await call(ctx, 'db.target.update', values, { expectVersion: field(input, 'expectVersion') })
					if (hooks.rename === 'throw') {
						throw new Error('the handler failed after its write')
					}
					return hooks.rename === 'refused output' ? { id: 'not a uuid', version: field(saved, 'version') } : saved
				}, undefined),
				retitle: siteHandler(async ({ input, ctx }) => {
					await call(ctx, 'db.unscoped.deals.update', field(input, 'id'), { title: field(input, 'title') }, {
						expectVersion: field(input, 'expectVersion'),
					})
					return { ok: true }
				}, { unscoped: { deals: 'read' } }),
				keep: siteHandler(async ({ ctx }) => {
					hooks.kept.target = at(ctx, 'db.target')
					await hooks.whileKept()
					return { ok: true }
				}, undefined),
				replay: siteHandler(async () => {
					await call(hooks.kept.target, 'get')
					return { ok: true }
				}, undefined),
				exportDeal: siteHandler(async ({ input, ctx }) => {
					await call(ctx, 'db.target.update', { title: 'exported' }, { expectVersion: field(input, 'expectVersion') })
					const line = 'x'.repeat(Number(field(input, 'width')))
					return Array.from({ length: Number(field(input, 'rows')) }, () => ({ line }))
				}, undefined),
			},
		},
		github: siteHandler(async ({ input, ctx }) => {
			const name = `${String(field(input, 'ref'))} ${hooks.deliveries.length}`
			hooks.deliveries.push(name)
			await call(at(ctx, 'db'), 'in', field(at(ctx, 'refs'), 'crm.write')).then((org) => call(org, 'companies.insert', { name }))
			if (hooks.failNextDelivery) {
				hooks.failNextDelivery = false
				throw new Error('the delivery failed after its write')
			}
		}, undefined),
		jobs: {
			close: siteHandler(async ({ ctx }) => {
				const within = await call(ctx, 'within', 'crm.read', 'company')
				const page = await call(await call(ctx, 'db.over', within), 'deals.list', { where: [['stage', '=', 'lead']] })
				const leads = field(page, 'items')
				for (const deal of Array.isArray(leads) ? leads : []) {
					const ref = await call(ctx, 'ref', 'deals.write', 'deal', field(deal, 'id'))
					const lose = async (db: unknown) => call(await call(db, 'on', ref), 'update', { stage: 'lost' }, { expectVersion: field(deal, 'version') })
					hooks.kept.jobData = at(ctx, 'db')
					hooks.kept.jobRef = ref
					if (hooks.job === 'outside its transaction') {
						await lose(at(ctx, 'db'))
					} else {
						await call(ctx, 'transaction', async (tx: unknown) => {
							if (hooks.job === 'undeclared sql') {
								await kept(hooks, () => call(tx, 'sql.scope', ref, 'deals'))
							}
							return lose(at(tx, 'db'))
						})
					}
				}
			}, undefined),
		},
	}
	return { contract, database: scoped(tables), connect: {}, handlers: () => tree }
}
