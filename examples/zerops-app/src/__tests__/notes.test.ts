// The endpoints as a person and a script call them, behind the production proxy decision. Each allowed call has a
// refused twin: another workspace, a missing action, no credential. Runs with `bun test --isolate`, because the
// generated endpoint access test boots the same application, and its data layer binds once per process.

import { createClient } from '@fabrika/app/client'
import { statusOf, type TestCaller, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { contract } from '../../fabrika.contract'
import app from '../app'

const postgres = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'notes.test.ts' })

const Uploaded = z.strictObject({ result: z.strictObject({ id: z.string() }) })

if (postgres !== null) {
	afterAll(() => postgres.close())
	const objects = new MemoryFileObjects()
	const kit = testKit(app, { database: postgres.database, files: objects })
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
			expect(await authorApi.notes.trash({ id, expectVersion: 1 })).toEqual({ id, version: 2 })
			expect(await statusOf(authorApi.notes.remove({ id, expectVersion: 2 }))).toBe(403)

			const editor = createClient(contract, 'api', { fetch: kit.browser(inW1('editor')) })
			expect(await editor.notes.remove({ id, expectVersion: 2 })).toEqual({ id })
			expect(await statusOf(editor.notes.get({ id }))).toBe(404)
		})

		test('only a note in the trash is restored', async () => {
			const { id } = await authorApi.notes.create({ workspaceId: 'w1', title: 'Kept' })
			expect(await statusOf(authorApi.notes.restore({ id, expectVersion: 1 }))).toBe(409)
			await authorApi.notes.trash({ id, expectVersion: 1 })
			expect(await authorApi.notes.restore({ id, expectVersion: 2 })).toEqual({ id, version: 3 })
			expect((await authorApi.notes.get({ id })).trashed).toBe(false)
		})

		test('the nightly purge deletes the notes in the trash and keeps the others', async () => {
			const kept = await authorApi.notes.create({ workspaceId: 'w1', title: 'Purge keeps' })
			const trashed = await authorApi.notes.create({ workspaceId: 'w1', title: 'Purge deletes' })
			await authorApi.notes.trash({ id: trashed.id, expectVersion: 1 })
			expect(await kit.runJob('purge')).toEqual({ status: 'succeeded', attempts: 1 })
			expect(await statusOf(authorApi.notes.get({ id: trashed.id }))).toBe(404)
			expect((await authorApi.notes.get({ id: kept.id })).title).toBe('Purge keeps')
		})

		test('a script with a key of its own workspace lists; without a credential the proxy sends the caller to sign in', async () => {
			const script = kit.testCaller([{ role: 'reader', scope: { type: 'workspace', value: 'w1' } }], { kind: 'machine' })
			if (script.key === null) throw new Error('a machine caller presents a key')
			const api = createClient(contract, 'api', { fetch: kit.fetch, key: script.key })
			expect((await api.notes.list()).items.length).toBeGreaterThan(0)
			expect((await kit.fetch('/api/notes.list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(302)
		})
	})

	describe('guests', () => {
		test('staff invite a guest into any workspace by e-mail; the guest accepts and reads it; a guest or a reader invites nobody', async () => {
			const staff = createClient(contract, 'people', { fetch: kit.browser(kit.testCaller([{ role: 'staff' }])) })
			const invite = { workspaceId: 'w1', email: 'guest@example.test', label: 'Acme', message: 'Welcome to Notes.', resend: true }
			const { invitationId } = await staff.guests.invite(invite)
			expect(await staff.guests.invite(invite)).toEqual({ invitationId })

			const guest = kit.acceptInvitation(invitationId)
			expect(guest).toMatchObject({ label: 'guest@example.test', affiliation: 'external' })
			const { id } = await authorApi.notes.create({ workspaceId: 'w1', title: 'For the guest' })
			const guestApi = createClient(contract, 'api', { fetch: kit.browser(guest) })
			expect((await guestApi.notes.get({ id })).title).toBe('For the guest')
			expect(await statusOf(guestApi.notes.create({ workspaceId: 'w1', title: 'No' }))).toBe(403)

			const asGuest = createClient(contract, 'people', { fetch: kit.browser(guest) })
			expect(await statusOf(asGuest.guests.invite({ workspaceId: 'w1', email: 'other@example.test' }))).toBe(403)
			const reader = createClient(contract, 'people', { fetch: kit.browser(inW1('reader')) })
			expect(await statusOf(reader.guests.invite({ workspaceId: 'w1', email: 'other@example.test' }))).toBe(403)
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

		const uploadAs = (caller: TestCaller, noteId: string) =>
			kit.browser(caller)(`/api/files.attachments.upload/${noteId}?name=hello.txt`, {
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: 'hello',
			})
		const removeAs = (caller: TestCaller, fileId: string) =>
			kit.browser(caller)('/api/files.attachments.remove', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: fileId }),
			})

		test('an author uploads; a reader of the workspace and an editor of another store nothing', async () => {
			const { id } = await authorApi.notes.create({ workspaceId: 'w1', title: 'Uploads' })
			const stored = objects.objects.size
			expect((await uploadAs(inW1('reader'), id)).status).toBe(403)
			expect((await uploadAs(kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w2' } }]), id)).status).toBe(404)
			expect(objects.objects.size).toBe(stored)
			expect((await uploadAs(author, id)).status).toBe(200)
			expect(objects.objects.size).toBe(stored + 1)
		})

		test('an editor removes a file; an author of the workspace and an editor of another remove nothing', async () => {
			const { id } = await authorApi.notes.create({ workspaceId: 'w1', title: 'Removals' })
			const fileId = Uploaded.parse(await (await uploadAs(author, id)).json()).result.id
			expect((await removeAs(author, fileId)).status).toBe(403)
			expect((await removeAs(kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w2' } }]), fileId)).status).toBe(404)
			expect((await kit.browser(author)(`/api/files.attachments/${fileId}`)).status).toBe(200)
			expect((await removeAs(inW1('editor'), fileId)).status).toBe(200)
			expect((await kit.browser(author)(`/api/files.attachments/${fileId}`)).status).toBe(404)
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
