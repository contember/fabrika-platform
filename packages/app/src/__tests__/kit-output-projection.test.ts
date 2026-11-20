// A kit handler may return fields its output does not declare: the types admit them, and the answer drops them, at
// any depth, before the strict output schema validates what is left.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

const vocabulary = defineVocabulary({
	app: 'plain',
	dimensions: { project: {} },
	actions: { 'projects.read': 'Read projects', 'projects.write': 'Write projects' },
	roles: { writer: { grants: ['projects.read', 'projects.write'] } },
})
const app = defineApp(vocabulary)
const Project = z.strictObject({ id: z.string(), owner: z.strictObject({ label: z.string() }) })
const Saved = z.strictObject({ id: z.string(), version: z.int() })

const projects = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ output: Project, access: { action: 'projects.read', over: 'project' } })
		.handle(() => ({ id: 'p1', secret: 'internal', owner: { label: 'Ada', email: 'ada@example.com' } })),
	rename: r.mutation({ output: Saved, access: { action: 'projects.write', over: 'project' } })
		.handle(() => ({ id: 'p1', version: 2, previous: 'old name' })),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { projects }) }))

describe('a kit handler returning undeclared fields', () => {
	const kit = testKit(serve(contract, { database: null }))
	const writer = kit.testCaller([
		{ action: 'projects.read', scope: { type: 'project', value: 'p1' } },
		{ action: 'projects.write', scope: { type: 'project', value: 'p1' } },
	])

	async function call(path: string): Promise<Response> {
		return await kit.browser(writer)(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
	}

	test('a query answers 200 without them, a nested object included', async () => {
		const response = await call('/api/projects.get')
		expect(response.status).toBe(200)
		expect(await response.json()).toStrictEqual({ result: { id: 'p1', owner: { label: 'Ada' } } })
	})

	test('a mutation answers 200 without them', async () => {
		const response = await call('/api/projects.rename')
		expect(response.status).toBe(200)
		expect(await response.json()).toStrictEqual({ result: { id: 'p1', version: 2 } })
	})
})
