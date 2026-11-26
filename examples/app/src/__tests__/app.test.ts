// The example's endpoints behind the production proxy decision, with test callers of the contract's roles, over the
// application's SQLite schema. Runs with `bun test --isolate`, and beside the generated endpoint access test in one
// process: a later kit of the application takes its data layer over.

import { createClient, download, RpcError } from '@fabrika/app/client'
import { statusOf, testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { contract } from '../../fabrika.contract'
import app from '../app'

const sqlite = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label: 'app.test.ts' })
afterAll(() => sqlite.close())
const objects = new MemoryFileObjects()
const kit = testKit(app, { database: sqlite.database, files: objects })
const DEMO = { type: 'project', value: 'demo' } as const
const ACME = { type: 'organization', value: 'acme' } as const

async function failure(call: Promise<unknown>): Promise<RpcError> {
	try {
		await call
	} catch (error) {
		if (error instanceof RpcError) return error
		throw error
	}
	throw new Error('expected the call to fail')
}

describe('the example application', () => {
	test('the health check needs no credential', async () => {
		const response = await kit.fetch('/healthz')
		expect(response.status).toBe(200)
		const body: unknown = await response.json()
		expect(body).toEqual({ status: 'ok' })
	})

	test('a viewer of one project reads that project and no organization', async () => {
		const viewer = kit.testCaller([{ role: 'viewer', scope: DEMO }], { id: 'viewer-1', label: 'viewer@example.test' })
		const api = createClient(contract, 'api', { fetch: kit.browser(viewer) })
		expect(await api.me()).toEqual({ id: 'viewer-1', label: 'viewer@example.test' })
		expect(await api.projects()).toEqual({ all: false, values: ['demo'] })
		expect((await failure(api.organizations())).httpStatus).toBe(403)
	})

	test('a global grant reads every value of the dimension', async () => {
		const reader = kit.testCaller([{ action: 'example.read' }])
		const api = createClient(contract, 'api', { fetch: kit.browser(reader) })
		expect(await api.organizations()).toEqual({ all: true, values: [] })
	})

	test('a machine key reaches the API with its own grants', async () => {
		const machine = kit.testCaller([{ action: 'example.read', scope: ACME }], { kind: 'machine' })
		const api = createClient(contract, 'api', { fetch: kit.fetch, key: machine.key ?? '' })
		expect(await api.organizations()).toEqual({ all: false, values: ['acme'] })
	})

	test('the organizations the console offers: every one to a global reader, the held ones otherwise, none without the action', async () => {
		const everyone = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'example.read' }])) })
		expect((await everyone.organizationValues()).values.map((entry) => entry.value)).toEqual(['acme', 'globex', 'hooli', 'initech', 'umbrella'])
		const one = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ action: 'example.read', scope: ACME }])) })
		expect(await one.organizationValues()).toEqual({ values: [{ value: 'acme', label: 'Acme Corporation' }] })
		const viewer = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'viewer', scope: DEMO }])) })
		expect((await failure(viewer.organizationValues())).httpStatus).toBe(403)
	})

	test('a caller without a session is sent to sign in, and one without any permission is refused', async () => {
		const anonymous = await kit.browser()('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		expect(anonymous.status).toBe(401)
		const stranger = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([])) })
		expect((await failure(stranger.me())).httpStatus).toBe(403)
	})
})

describe('notes', () => {
	const editor = kit.testCaller([{ role: 'editor', scope: DEMO }])
	const editorApi = createClient(contract, 'notes', { fetch: kit.browser(editor) })
	const viewer = kit.testCaller([{ role: 'viewer', scope: DEMO }])
	const viewerApi = createClient(contract, 'notes', { fetch: kit.browser(viewer) })
	const outsider = kit.testCaller([{ role: 'editor', scope: { type: 'project', value: 'other' } }])
	const outsiderApi = createClient(contract, 'notes', { fetch: kit.browser(outsider) })
	const readme = () => new File(['read me first'], 'readme.txt', { type: 'text/plain' })

	test('an editor writes a note and the project reads it back; a viewer cannot write, another project reads nothing', async () => {
		const { id } = await editorApi.create({ projectId: 'demo', title: 'first' })
		expect((await viewerApi.list({ projectId: 'demo' })).items).toContainEqual({ id, title: 'first', reviewedAt: null, attachment: null })
		expect(await statusOf(viewerApi.create({ projectId: 'demo', title: 'refused' }))).toBe(403)
		expect(await statusOf(outsiderApi.list({ projectId: 'demo' }))).toBe(403)
		expect((await outsiderApi.list({ projectId: 'other' })).items).toEqual([])
	})

	test("a note's file is downloaded by its project and by nobody else", async () => {
		const stored = objects.objects.size
		const { id } = await editorApi.create({ projectId: 'demo', title: 'with a file', attachment: readme() })
		expect(objects.objects.size).toBe(stored + 1)
		const listed = (await viewerApi.list({ projectId: 'demo' })).items.find((note) => note.id === id)
		expect(listed?.attachment).toEqual({ id: expect.any(String), name: 'readme.txt', type: 'text/plain', size: 13, status: 'live' })
		const download = await kit.browser(viewer)(viewerApi.attachment.url({ id }))
		expect(download.status).toBe(200)
		expect(await download.text()).toBe('read me first')
		expect((await kit.browser(outsider)(outsiderApi.attachment.url({ id }))).status).toBe(404)
		const plain = await editorApi.create({ projectId: 'demo', title: 'no file' })
		expect((await kit.browser(viewer)(viewerApi.attachment.url({ id: plain.id }))).status).toBe(404)
	})

	test('a file of a type the kind does not admit is refused and nothing is stored', async () => {
		const stored = objects.objects.size
		const pdf = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' })
		expect(await statusOf(editorApi.create({ projectId: 'demo', title: 'refused', attachment: pdf }))).toBe(415)
		expect(objects.objects.size).toBe(stored)
	})

	test('the review job stamps every unreviewed note once', async () => {
		const { id } = await editorApi.create({ projectId: 'demo', title: 'to review' })
		expect(await kit.runJob('review')).toEqual({ status: 'succeeded', attempts: 1 })
		const reviewed = (await viewerApi.list({ projectId: 'demo' })).items
		expect(reviewed.every((note) => note.reviewedAt !== null)).toBe(true)
		const stamp = reviewed.find((note) => note.id === id)?.reviewedAt
		expect(await kit.runJob('review')).toEqual({ status: 'succeeded', attempts: 1 })
		expect((await viewerApi.list({ projectId: 'demo' })).items.find((note) => note.id === id)?.reviewedAt).toBe(stamp)
	})
})

describe("a person's agent (ADR-0090)", () => {
	const OTHER = { type: 'project', value: 'other' } as const
	const person = kit.testCaller([{ role: 'editor', scope: DEMO }, { role: 'editor', scope: OTHER }])
	const own = createClient(contract, 'notes', { fetch: kit.browser(person) })

	test('a grant narrowed to one project reads that project and nothing of another, and writes nothing', async () => {
		const { id } = await own.create({ projectId: 'demo', title: 'for the agent' })
		const elsewhere = await own.create({ projectId: 'other', title: 'not for the agent' })
		const { token } = await kit.agentGrant(person, { scope: 'read:project=demo', label: 'summary script' })
		const agent = createClient(contract, 'notes', { fetch: kit.fetch, key: token })
		expect((await agent.list({ projectId: 'demo' })).items.map((note) => note.id)).toContain(id)
		expect(await statusOf(agent.list({ projectId: 'other' }))).toBe(403)
		expect(await statusOf(download(agent.attachment, { id: elsewhere.id }))).toBe(404)
		expect(await statusOf(agent.create({ projectId: 'demo', title: 'refused' }))).toBe(403)
	})
})
