// The rows a global case's caller holds (`callerRows`): an application whose handlers look up the caller's own record
// (a person's card bound to the account) before they answer refuses a caller without one, so a global case reaches the
// handler only when the kit seeds that record for its caller. The kit keeps it for the file, as production keeps a
// card, so a row a handler wrote that refers to it (a page's version by its author) is there for the next case. On
// SQLite, which needs no service.

import { ForbiddenError } from '@fabrika/app'
import { defineApp, defineVocabulary, GENERATED_CALLER } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const vocabulary = defineVocabulary({
	app: 'staff',
	dimensions: { site: {} },
	actions: { 'shifts.read': 'Read shifts', 'pages.write': 'Write pages' },
	roles: { staff: { grants: ['shifts.read', 'pages.write'] } },
})

interface DB {
	people: { id: string; nickname: string; principal_id: string | null }
	pages: { id: string; title: string }
	page_versions: { id: string; page_id: string; author_id: string }
}

const columns: TypedColumnList<DB> = {
	people: { columns: ['id', 'nickname', 'principal_id'], foreignKeys: [] },
	pages: { columns: ['id', 'title'], foreignKeys: [] },
	page_versions: {
		columns: ['id', 'page_id', 'author_id'],
		foreignKeys: [{ columns: ['page_id'], table: 'pages', references: ['id'] }, { columns: ['author_id'], table: 'people', references: ['id'] }],
	},
}

const tables = defineTables(vocabulary, columns)({
	people: { scope: { app: 'the cards of the staff' }, actions: { read: ['shifts.read', 'pages.write'] } },
	pages: { scope: { app: 'the pages' }, actions: { read: 'pages.write', insert: 'pages.write' }, insert: ['title'] },
	page_versions: {
		scope: { app: 'every page has one, by its author' },
		actions: { read: 'pages.write', insert: 'pages.write' },
		insert: ['page_id', 'author_id'],
	},
})

const app = defineApp(vocabulary, tables)
const Card = z.strictObject({ nickname: z.string() })
const shifts = app.group({ callers: ['human'] }, (r) => ({
	mine: r.query({ output: Card, access: { action: 'shifts.read', app: true } })
		.handle(async ({ ctx }) => {
			const card = (await ctx.db.app.people.list({ where: [['principal_id', '=', ctx.principal.id]], limit: 1 })).items[0]
			if (card === undefined) throw new ForbiddenError('No card is bound to this account.')
			return { nickname: card.nickname }
		}),
}))
const Done = z.strictObject({ count: z.number() })
const pages = app.group({ callers: ['human'] }, (r) => ({
	// A page and its first version, by the caller's card.
	create: r.mutation({ output: Done, access: { action: 'pages.write', app: true } })
		.handle(async ({ ctx }) => {
			const card = (await ctx.db.app.people.list({ where: [['principal_id', '=', ctx.principal.id]], limit: 1 })).items[0]
			if (card === undefined) throw new ForbiddenError('No card is bound to this account.')
			const page = await ctx.db.app.pages.insert({ title: 'Home' })
			await ctx.db.app.page_versions.insert({ page_id: page.id, author_id: card.id })
			return { count: 1 }
		}),
	// Every page has a version: one without is a broken invariant, a 500.
	overview: r.query({ output: Done, access: { action: 'pages.write', app: true } })
		.handle(async ({ ctx }) => {
			const listed = (await ctx.db.app.pages.list({ limit: 100 })).items
			for (const page of listed) {
				const versions = (await ctx.db.app.page_versions.list({ where: [['page_id', '=', page.id]], limit: 1 })).items
				if (versions.length === 0) throw new Error(`page ${page.id} has no version`)
			}
			return { count: listed.length }
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { shifts, pages }) }))

const migrations = mkdtempSync(join(tmpdir(), 'caller-rows-'))
writeFileSync(
	join(migrations, '20261120120000_init.sql'),
	[
		'CREATE TABLE people (id TEXT PRIMARY KEY NOT NULL, nickname TEXT NOT NULL, principal_id TEXT UNIQUE);',
		'CREATE TABLE pages (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL);',
		'CREATE TABLE page_versions (id TEXT PRIMARY KEY NOT NULL, page_id TEXT NOT NULL REFERENCES pages (id), author_id TEXT NOT NULL REFERENCES people (id));',
		'',
	].join('\n'),
)
const database = await testDatabase({ migrations, label: 'endpoint-access-caller-rows.test.ts' })
afterAll(async () => {
	await database.close()
	rmSync(migrations, { recursive: true, force: true })
})

describe("the rows a global case's caller holds", () => {
	// A new kit's first caller has the id the last kit's first caller had, so a record left behind would answer it.
	test("with them, each global case's caller finds its own record; without them, the handler refuses it", async () => {
		const seeded = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, database, {
			callerRows: { people: { principal_id: GENERATED_CALLER } },
		})
		expect(await seeded.global('api.shifts.mine', {})).toEqual({ answered: true })
		expect(await seeded.global('api.shifts.mine', {})).toEqual({ answered: true })
		const bare = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, database)
		expect(await bare.global('api.shifts.mine', {})).toEqual({ answered: false, status: 403 })
	})

	test("a row a global case wrote that refers to the caller's record is there for the next global case", async () => {
		const kit = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, database, {
			callerRows: { people: { principal_id: GENERATED_CALLER } },
		})
		expect(await kit.global('api.pages.create', {})).toEqual({ answered: true })
		expect(await kit.global('api.pages.overview', {})).toEqual({ answered: true })
	})
})
