// The kit's stand-in IAM mints for the key a share link it issued through `ctx.links` carries, as IAM resolves a link
// key: the holder reads the link's object, nothing once the link is revoked, and a key the stand-in never issued is
// refused. `devKit`, what `fabrika app dev` serves, answers the kit's own people and a caller's live roles.
// Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { serve } from '@fabrika/app/implement'
import { devKit, testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { migration } from './access-fixture/migration'
import { app } from './access-fixture/src/app-kit'
import { tables } from './access-fixture/src/db/tables'
import { shared } from './access-fixture/src/notes/endpoints'
import { ById } from './access-fixture/src/schemas'

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-kit-links-'))
writeFileSync(join(migrations, '20261012120000_notes.sql'), migration)
const postgres = await testDatabase({ migrations, label: 'test-kit-links.test.ts' })

afterAll(async () => {
	await postgres?.close()
	rmSync(migrations, { recursive: true, force: true })
})

const Link = z.strictObject({ id: z.string(), url: z.string() })
const Done = z.strictObject({ id: z.uuid() })
const Unshare = z.strictObject({ id: z.uuid(), linkId: z.string() })

const sharing = app.group({ callers: ['human'] }, (r) => ({
	share: r.mutation({ input: ById, output: Link, access: { action: 'notes.share', on: 'note', from: 'id' }, issues: 'shared' })
		.handle(async ({ ctx }) => {
			const link = await ctx.links.issue(ctx.target, { mount: 'shared', days: 7 })
			return { id: link.id, url: link.url }
		}),
	unshare: r.mutation({ input: Unshare, output: Done, access: { action: 'notes.share', on: 'note', from: 'id' }, issues: 'shared' })
		.handle(async ({ input, ctx }) => {
			await ctx.links.revoke(input.linkId)
			return { id: ctx.target.value }
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { sharing }), shared }))
const served = serve(contract, { database: scoped(tables) })

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json', ...headers },
	body: JSON.stringify(body),
})

describe.skipIf(postgres === null)('a share link the application issued through the kit', () => {
	test('opens as its holder, reaches only its note, and stops once revoked; a key the stand-in never issued is refused', async () => {
		if (postgres === null) return
		const kit = testKit(served, { database: postgres.database })
		const worlds = await postgres.seedWorlds(tables, 'notes', {})
		const editor = kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: worlds.own.scope } }])
		const issued = await kit.browser(editor)('/api/sharing.share', post({ id: worlds.own.key }))
		expect(issued.status).toBe(200)
		const { result } = z.strictObject({ result: Link }).parse(await issued.json())
		const key = result.url.slice(result.url.indexOf('#') + 1)
		expect(result.url).toBe(`/s/#${key}`)

		const read = () => kit.fetch('/s/api/note', post({}, { Authorization: `Bearer ${key}` }))
		const opened = await read()
		expect(opened.status).toBe(200)
		expect(await opened.json()).toMatchObject({ result: { id: worlds.own.key } })
		expect((await kit.fetch('/s/api/note', post({}, { Authorization: 'Bearer px_link_neverissued' }))).status).toBe(401)

		const revoked = await kit.browser(editor)('/api/sharing.unshare', post({ id: worlds.own.key, linkId: result.id }))
		expect(revoked.status).toBe(200)
		expect((await read()).status).toBe(401)
	})
})

describe('the dev kit', () => {
	test("answers a person only for a caller the kit made, and a caller's roles as the stand-in holds them now", () => {
		const dev = devKit(serve(contract, { database: scoped(tables) }), postgres === null ? {} : { database: postgres.database })
		const editor = dev.kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }], { label: 'Eda', email: 'eda@notes.test' })
		expect(dev.membershipsOf(editor)).toEqual([{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }])
		expect(dev.personOf(editor)).toBe(editor)
		expect(dev.personOf({ ...editor })).toBeUndefined()
		expect(dev.personOf(dev.kit.testCaller([], { kind: 'machine' }))).toBeUndefined()
		expect(dev.invitations()).toEqual([])
	})
})
