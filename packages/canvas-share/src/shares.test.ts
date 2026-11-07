// Shares in the worker: Lopata runs the Worker, its R2 bucket and its KV namespace in process.

import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { createTestEnv, type TestEnv } from 'lopata/testing'
import { z } from 'zod'
import worker, { ReviewProject } from './index'

const ORIGIN = 'https://share.test'
const createdSchema = z.object({ shareId: z.string(), ownerToken: z.string() })
const uploadedSchema = z.object({ url: z.string(), mime: z.string() })
const feedbackListSchema = z.object({ entries: z.array(z.object({ generalNote: z.string().optional() })) })

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

const deployed: TestEnv[] = []
afterEach(() => {
	setSystemTime()
	for (const env of deployed.splice(0)) env.dispose()
})

async function setUp(vars: Record<string, string> = {}) {
	const testEnv = await createTestEnv({
		worker: { default: worker, ReviewProject },
		bindings: { REVIEWS: { type: 'durable-object', className: 'ReviewProject' }, BLOBS: 'r2', FEEDBACK: 'kv' },
		vars,
	})
	deployed.push(testEnv)
	const response = await testEnv.fetch(`${ORIGIN}/shares`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			version: 1,
			origin: { sessionId: 's1', revision: 1, createdAt: '2026-04-09T00:00:00.000Z' },
			canvasFiles: [{ filename: 'plan.jsx', compiledJs: 'export default ()=>null' }],
			runtime: { componentsVersion: '0.1.0' },
		}),
	})
	expect(response.status).toBe(200)
	const { shareId, ownerToken } = createdSchema.parse(await response.json())

	const upload = (bytes: Uint8Array, name: string, type: string) => {
		const form = new FormData()
		form.set('image', new File([bytes], name, { type }))
		return testEnv.fetch(`${ORIGIN}/s/${shareId}/upload`, { method: 'POST', body: form })
	}
	const revoke = () => testEnv.fetch(`${ORIGIN}/shares/${shareId}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${ownerToken}` } })
	return { testEnv, shareId, upload, revoke }
}

describe('a revoked or expired share', () => {
	test('a revoked share no longer lists its feedback', async () => {
		const { testEnv, shareId, revoke } = await setUp()
		const submitted = await testEnv.fetch(`${ORIGIN}/s/${shareId}/feedback`, {
			method: 'POST',
			body: JSON.stringify({ author: { name: 'Reviewer' }, revision: 1, annotations: [], generalNote: 'Looks good' }),
		})
		expect(submitted.status).toBe(200)
		const listed = await testEnv.fetch(`${ORIGIN}/shares/${shareId}/feedback`)
		expect(feedbackListSchema.parse(await listed.json()).entries.map((e) => e.generalNote)).toEqual(['Looks good'])

		expect((await revoke()).status).toBe(200)
		expect((await testEnv.fetch(`${ORIGIN}/shares/${shareId}/feedback`)).status).toBe(404)
	})

	test('a revoked share no longer serves its uploads', async () => {
		const { testEnv, upload, revoke } = await setUp()
		const { url } = uploadedSchema.parse(await (await upload(PNG, 'shot.png', 'image/png')).json())
		expect((await testEnv.fetch(url)).status).toBe(200)

		expect((await revoke()).status).toBe(200)
		expect((await testEnv.fetch(url)).status).toBe(404)
	})

	test('an expired share no longer serves its uploads or its feedback', async () => {
		const { testEnv, shareId, upload } = await setUp({ SHARE_TTL_SECONDS: '60' })
		const { url } = uploadedSchema.parse(await (await upload(PNG, 'shot.png', 'image/png')).json())
		expect((await testEnv.fetch(url)).status).toBe(200)

		setSystemTime(new Date(Date.now() + 61_000))
		expect((await testEnv.fetch(url)).status).toBe(404)
		expect((await testEnv.fetch(`${ORIGIN}/shares/${shareId}/feedback`)).status).toBe(404)
	})
})
