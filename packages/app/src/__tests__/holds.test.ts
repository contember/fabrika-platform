// `ctx.holds('<action>')` of an RPC procedure, through the test kit on SQLite: whether the caller's verified token holds
// an action of the vocabulary as a global grant. A scoped grant and an action outside the vocabulary hold nothing, and
// it reaches no data: `ctx.db` stays the access form's.

import { createClient } from '@fabrika/app/client'
import { type App, defineApp, type HoldsContext, type KitTypes } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { globalHolds } from '../implement/principal'
import { tables } from './cloudflare-fixture/src/db/tables'
import { vocabulary } from './cloudflare-fixture/src/vocabulary'

const app = defineApp(vocabulary, tables)

type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
/** `holds` takes an action of the vocabulary and nothing else. */
export type HoldsTakesVocabularyActions = Expect<Equal<Parameters<HoldsContext<Kit>['holds']>[0], 'notes.read' | 'notes.write'>>

const Held = z.strictObject({ read: z.boolean(), write: z.boolean(), unknown: z.boolean() })

const notes = app.group({ callers: ['human', 'machine'] }, (r) => ({
	appWide: r.query({ output: Held, access: { action: 'notes.read', app: true } }).handle(({ ctx }) => ({
		read: ctx.holds('notes.read'),
		write: ctx.holds('notes.write'),
		// Outside the vocabulary: the types refuse it, and at run time it holds nothing, whatever a wildcard grants.
		unknown: Reflect.apply(ctx.holds, undefined, ['notes.delete']) === true,
	})),
	inWorkspace: r.query({ output: Held, access: { action: 'notes.read', over: 'workspace' } }).handle(({ ctx }) => ({
		read: ctx.holds('notes.read'),
		write: ctx.holds('notes.write'),
		unknown: false,
	})),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { notes }), health: c.health('/healthz') }))

const database = await testDatabase({ migrations: new URL('./cloudflare-fixture/db/migrations/', import.meta.url), label: 'holds.test.ts' })
afterAll(() => database.close())

const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database })
type Grant = Parameters<typeof kit.testCaller>[0][number]
const asCaller = (grants: readonly Grant[]) => createClient(contract, 'api', { fetch: kit.browser(kit.testCaller(grants)) })
const asScript = (grants: readonly Grant[]) =>
	createClient(contract, 'api', { fetch: kit.fetch, key: kit.testCaller(grants, { kind: 'machine' }).key ?? '' })
const inW1 = { type: 'workspace', value: 'w1' } as const

describe('ctx.holds', () => {
	test('reports the global grants the token carries, the endpoint’s own action included', async () => {
		expect(await asCaller([{ action: 'notes.read' }]).notes.appWide()).toEqual({ read: true, write: false, unknown: false })
		expect(await asCaller([{ action: 'notes.read' }, { action: 'notes.write' }]).notes.appWide()).toEqual({
			read: true,
			write: true,
			unknown: false,
		})
	})

	test('a grant scoped to one value is not held', async () => {
		expect(await asCaller([{ action: 'notes.read' }, { action: 'notes.write', scope: inW1 }]).notes.appWide()).toEqual({
			read: true,
			write: false,
			unknown: false,
		})
	})

	test('a role held globally holds each of its actions', async () => {
		expect(await asCaller([{ role: 'editor' }]).notes.appWide()).toEqual({ read: true, write: true, unknown: false })
	})

	test('a wildcard entry holds every action of the vocabulary it covers, and none outside it', () => {
		const holds = globalHolds([{ action: 'notes.*', scope: null, source: 'grant' }], ['notes.read', 'notes.write'])
		expect([holds('notes.read'), holds('notes.write'), holds('notes.delete')]).toEqual([true, true, false])
		expect(globalHolds([{ action: 'notes.write', scope: { type: 'workspace', value: 'w1' }, source: 'grant' }], ['notes.write'])('notes.write')).toBe(
			false,
		)
	})

	test('a scoped endpoint reads it too, and a script caller has it', async () => {
		expect(await asCaller([{ action: 'notes.read', scope: inW1 }, { action: 'notes.write' }]).notes.inWorkspace()).toEqual({
			read: false,
			write: true,
			unknown: false,
		})
		expect(await asScript([{ action: 'notes.read' }]).notes.appWide()).toEqual({ read: true, write: false, unknown: false })
	})
})
