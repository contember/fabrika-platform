// The endpoint access kit seeds a row an input field names (`fabrika:row:<table>`) under every access form that has a
// scope: in the target of an `in` endpoint, in a scope an `over` endpoint lists, and in the scope of the capability a
// field names (`fabrika:row:<table>@<capability>`). A handler that looks the row up answers 200 only when the row lies
// where the caller reaches. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { NotFoundError } from '@fabrika/app'
import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { endpointAccessKit } from '@fabrika/app/testing/isolation'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

const migration = `
create table organizations (id text primary key, name text not null);
create table workspaces (
	id text primary key,
	organization_id text not null references organizations (id),
	name text not null,
	unique (id, organization_id)
);
create table notes (
	id text primary key,
	workspace_id text not null,
	organization_id text not null,
	title text not null,
	foreign key (workspace_id, organization_id) references workspaces (id, organization_id) on update cascade
);
`

const vocabulary = defineVocabulary({
	app: 'rows',
	dimensions: { organization: {}, workspace: { in: 'organization' }, note: { in: 'workspace' } },
	actions: { 'workspaces.read': 'Read workspaces', 'notes.read': 'Read notes' },
	roles: {},
})

interface DB {
	organizations: { id: string; name: string }
	workspaces: { id: string; organization_id: string; name: string }
	notes: { id: string; workspace_id: string; organization_id: string; title: string }
}

const columns: TypedColumnList<DB> = {
	organizations: { columns: ['id', 'name'], foreignKeys: [] },
	workspaces: {
		columns: ['id', 'organization_id', 'name'],
		foreignKeys: [{ columns: ['organization_id'], table: 'organizations', references: ['id'] }],
	},
	notes: {
		columns: ['id', 'workspace_id', 'organization_id', 'title'],
		foreignKeys: [{ columns: ['workspace_id', 'organization_id'], table: 'workspaces', references: ['id', 'organization_id'] }],
	},
}

const tables = defineTables(vocabulary, columns)({
	organizations: { scope: { dimension: 'organization', key: 'id' }, actions: { read: 'workspaces.read' } },
	workspaces: {
		scope: { dimension: 'workspace', key: 'id', in: { dimension: 'organization', column: 'organization_id' } },
		actions: { read: 'workspaces.read' },
	},
	notes: { scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } }, actions: { read: 'notes.read' } },
})

const app = defineApp(vocabulary, tables)

const Found = z.strictObject({ id: z.string() })

const notes = app.group({ callers: ['human'] }, (r) => ({
	lookUp: r.query({
		input: z.strictObject({ workspaceId: z.string(), noteId: z.string() }),
		output: Found,
		access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' },
	}).handle(async ({ input, ctx }) => {
		const [note] = (await ctx.db.target.notes.list({ where: [['id', '=', input.noteId]] })).items
		if (note === undefined) throw new NotFoundError('the workspace holds no such note')
		return { id: note.id }
	}),
	thread: r.query({ input: z.strictObject({ rootId: z.string() }), output: Found, access: { action: 'notes.read', over: 'workspace' } })
		.handle(async ({ input, ctx }) => {
			const [root] = (await ctx.db.within.notes.list({ where: [['id', '=', input.rootId]] })).items
			if (root === undefined) throw new NotFoundError('no listed workspace holds the root note')
			return { id: root.id }
		}),
	relate: r.query({
		input: z.strictObject({ noteId: z.string(), organizationId: z.string(), intoId: z.string() }),
		output: Found,
		access: {
			capabilities: {
				source: { action: 'notes.read', over: 'workspace' },
				target: { action: 'workspaces.read', in: 'organization', from: 'organizationId' },
			},
		},
	}).handle(async ({ input, ctx }) => {
		const [note] = (await ctx.db.over(ctx.capabilities.source).notes.list({ where: [['id', '=', input.noteId]] })).items
		const [workspace] = (await ctx.db.in(ctx.capabilities.target).workspaces.list({ where: [['id', '=', input.intoId]] })).items
		if (note === undefined || workspace === undefined) throw new NotFoundError('no such note or workspace')
		return { id: `${note.id}:${workspace.id}` }
	}),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { notes }) }))

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-endpoint-access-rows-'))
writeFileSync(join(migrations, '20261103120000_init.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'endpoint-access-rows.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

describe.skipIf(postgres === null)('the endpoint access kit seeds a named row under every access form with a scope', () => {
	const accessKit = () => {
		if (postgres === null) throw new Error('no test database')
		return endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)
	}

	test('an in endpoint finds the row in its own target, and a made-up id is not found', async () => {
		const kit = accessKit()
		expect(await kit.leaked('api.notes.lookUp', { workspaceId: 'x', noteId: 'fabrika:row:notes' })).toEqual({ answered: true, leaked: [] })
		expect(await kit.leaked('api.notes.lookUp', { workspaceId: 'x', noteId: 'x' })).toEqual({ answered: false, leaked: [], status: 404 })
		expect(await kit.denied('api.notes.lookUp', { workspaceId: 'x', noteId: 'fabrika:row:notes' })).toEqual({ status: 403 })
	})

	test('an over endpoint finds the row in a scope it lists, and a made-up id is not found', async () => {
		const kit = accessKit()
		expect(await kit.leaked('api.notes.thread', { rootId: 'fabrika:row:notes' })).toEqual({ answered: true, leaked: [] })
		expect(await kit.leaked('api.notes.thread', { rootId: 'x' })).toEqual({ answered: false, leaked: [], status: 404 })
	})

	test('each capability seeds the rows that name it, and a row naming no capability says so', async () => {
		const kit = accessKit()
		const input = { noteId: 'fabrika:row:notes@source', organizationId: 'x', intoId: 'fabrika:row:workspaces@target' }
		expect(await kit.capability('api.notes.relate', 'source', input)).toEqual({ status: 403 })
		expect(await kit.capability('api.notes.relate', 'target', input)).toEqual({ status: 403 })
		await expect(kit.capability('api.notes.relate', 'source', { ...input, noteId: 'fabrika:row:notes' })).rejects.toThrow(
			'api.notes.relate: noteId names a row in the scope of no capability of it',
		)
	})

	test('a row of a table the over dimension does not list says so', async () => {
		await expect(accessKit().leaked('api.notes.thread', { rootId: 'fabrika:row:organizations' })).rejects.toThrow(
			'a list of workspace reaches no organizations row, so the kit seeds none for rootId',
		)
	})
})
