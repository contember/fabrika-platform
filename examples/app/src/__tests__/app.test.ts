// The example's endpoints behind the production proxy decision, with test callers of the contract's roles.

import { createClient, RpcError } from '@fabrika/app/client'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { contract } from '../../fabrika.contract'
import app from '../app'

const kit = testKit(app)
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

	test('a caller without a session is sent to sign in, and one without any permission is refused', async () => {
		const anonymous = await kit.browser()('/api/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		expect(anonymous.status).toBe(401)
		const stranger = createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([])) })
		expect((await failure(stranger.me())).httpStatus).toBe(403)
	})
})
