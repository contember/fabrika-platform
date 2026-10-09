// The endpoints as a person and a script call them, behind the production proxy decision. Each allowed call has a
// refused twin: another workspace, a missing action, no credential. Runs with `bun test --isolate`, because the
// generated endpoint access test boots the same application, and its data layer binds once per process.

import { createClient, RpcError } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { contract } from '../../fabrika.contract'
import app from '../app'

const postgres = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'notes.test.ts' })

const Uploaded = z.strictObject({ result: z.strictObject({ id: z.string() }) })

const statusOf = async (call: Promise<unknown>): Promise<number | undefined> => {
	try {
		await call
		return 200
	} catch (error) {
		return error instanceof RpcError ? error.httpStatus : undefined
	}
}

if (postgres !== null) {
	afterAll(() => postgres.close())
	const kit = testKit(app, { database: postgres.database, files: new MemoryFileObjects() })
	const inW1 = (role: 'reader' | 'author' | 'editor') => kit.testCaller([{ role, scope: { type: 'workspace', value: 'w1' } }])
	const author = inW1('author')
	const authorApi = createClient(contract, 'api', { fetch: kit.browser(author) })

	describe('notes', () => {
		test('an author creates a note in its workspace, and a caller of another workspace neither lists nor reads it', async () => {
			const { id } = await authorApi.notes.create({ workspaceId: 'w1', title: 'Plan' })
			expect((await authorApi.notes.list()).items).toEqual([{ id, title: 'Plan', trashed: false, version: 1 }])

			const outsider = createClient(contract, 'api', {
				fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w2' } }])),
			})
			expect((await outsider.notes.list()).items).toEqual([])
			expect(await statusOf(outsider.notes.get({ id }))).toBe(404)
			expect(await statusOf(outsider.notes.create({ workspaceId: 'w1', title: 'Not mine' }))).toBe(403)
		})

		test('a reader reads but does not write; an author trashes but does not delete; an editor deletes', async () => {
			const { id } = await authorApi.notes.create({ workspaceId: 'w1', title: 'Draft' })
			const reader = createClient(contract, 'api', { fetch: kit.browser(inW1('reader')) })
			expect((await reader.notes.get({ id })).title).toBe('Draft')
			expect(await statusOf(reader.notes.create({ workspaceId: 'w1', title: 'No' }))).toBe(403)

			expect(await statusOf(authorApi.notes.trash({ id, expectVersion: 2 }))).toBe(409)
			expect(await authorApi.notes.trash({ id, expectVersion: 1 })).toEqual({ id })
			expect(await statusOf(authorApi.notes.remove({ id }))).toBe(403)

			const editor = createClient(contract, 'api', { fetch: kit.browser(inW1('editor')) })
			expect(await editor.notes.remove({ id })).toEqual({ id })
			expect(await statusOf(editor.notes.get({ id }))).toBe(404)
		})

		test('a script with a key of its own workspace lists; without a credential the proxy sends the caller to sign in', async () => {
			const script = kit.testCaller([{ role: 'reader', scope: { type: 'workspace', value: 'w1' } }], { kind: 'machine' })
			if (script.key === null) throw new Error('a machine caller presents a key')
			const api = createClient(contract, 'api', { fetch: kit.fetch, key: script.key })
			expect((await api.notes.list()).items.length).toBeGreaterThan(0)
			expect((await kit.fetch('/api/notes.list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(302)
		})
	})

	describe('attachments', () => {
		test("a file reaches what its note reaches: the author's workspace downloads it, another workspace does not", async () => {
			const { id } = await authorApi.notes.create({ workspaceId: 'w1', title: 'With a file' })
			const upload = await kit.browser(author)(`/api/files.attachments.upload/${id}?name=hello.txt`, {
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: 'hello',
			})
			expect(upload.status).toBe(200)
			const fileId = Uploaded.parse(await upload.json()).result.id

			const download = await kit.browser(author)(`/api/files.attachments/${fileId}`)
			expect(download.status).toBe(200)
			expect(await download.text()).toBe('hello')

			const outsider = kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w2' } }])
			expect((await kit.browser(outsider)(`/api/files.attachments/${fileId}`)).status).toBe(404)
		})

		test('a type the collection does not declare is refused', async () => {
			const { id } = await authorApi.notes.create({ workspaceId: 'w1', title: 'Wrong type' })
			const upload = await kit.browser(author)(`/api/files.attachments.upload/${id}`, {
				method: 'POST',
				headers: { 'Content-Type': 'text/html' },
				body: '<p>hi</p>',
			})
			expect(upload.status).toBe(400)
		})
	})
}
