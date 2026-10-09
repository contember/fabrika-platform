// The console behind the real proxy, deciding from the table it publishes: which caller reaches which row, and
// what the proxy answers instead. The upstream is Control's own application, so an admitted request is served.

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { CONTROL_MCP_SCOPE, controlMcpResource, controlMcpResourceMetadata, controlServiceContract } from '../../fabrika.service'
import { createControlApp } from '../app'
import type { Env } from '../env'
import { createHarness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'
import { CONSOLE_ORIGIN, consoleBehindProxy } from './helpers/proxy'
import { unusedSourceConnection } from './helpers/source-connection'
import { adminToken, TEST_ISSUER, testIamEnv, testResourceToken, testToken } from './helpers/tokens'

const keys = {
	px_user: adminToken,
	px_machine: await testToken({ label: 'machine', actions: ['*'], type: 'service' }),
	px_job: await testToken({ label: 'job', actions: ['*'], type: 'job' }),
	px_link: await testToken({ label: 'link', actions: ['*'], type: 'link' }),
}
const RESOURCE = controlMcpResource(CONSOLE_ORIGIN)
const METADATA = controlMcpResourceMetadata(CONSOLE_ORIGIN)

function console_(options: { readonly mcp: boolean }): (request: Request) => Promise<Response> {
	const harness = createHarness()
	const env: Env = {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'local',
		FABRIKA_CONTROL_DOMAIN: CONSOLE_ORIGIN,
		...testIamEnv,
	}
	const app = createControlApp(options.mcp ? () => Promise.resolve(new Response('mcp')) : null)
	return consoleBehindProxy({
		table: serviceProxyTable(controlServiceContract(options), { oauth: options.mcp }),
		...(options.mcp
			? {
				oauthResources: [{ resource: RESOURCE, resourceMetadata: METADATA, authorizationServers: [TEST_ISSUER], scopesSupported: [CONTROL_MCP_SCOPE] }],
			}
			: {}),
		iam: { session: adminToken, keys },
		upstream: (request) =>
			app.fetch(request, { env, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('harbor') }, { waitUntil() {} }),
	})
}

const rpc = (headers: Record<string, string>) =>
	new Request(`${CONSOLE_ORIGIN}/api/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ method: 'installation', input: null }),
	})
const session = { cookie: `${SESSION_COOKIE}=s` }
const mcpCall = (headers: Record<string, string>) =>
	new Request(`${CONSOLE_ORIGIN}/mcp`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
	})

describe('the console behind its table', () => {
	const fetch = console_({ mcp: false })

	test('an anonymous navigation to the console is bounced to login', async () => {
		const response = await fetch(new Request(`${CONSOLE_ORIGIN}/apps/notes`, { headers: { 'sec-fetch-mode': 'navigate' } }))
		expect(response.status).toBe(302)
		expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/login')
	})

	test('a job key or a link token on the RPC mount is refused at the proxy', async () => {
		for (const key of ['px_job', 'px_link']) {
			expect((await fetch(rpc({ authorization: `Bearer ${key}` }))).status).toBe(403)
		}
		expect((await fetch(rpc({ authorization: 'Bearer px_machine' }))).status).toBe(200)
	})

	test('a CLI asking for a connector reaches its procedure on the RPC mount', async () => {
		const describe = new Request(`${CONSOLE_ORIGIN}/api/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: 'Bearer px_machine' },
			body: JSON.stringify({ method: 'connectors.describe', input: { consumer: 'shop', env: 'prod', app: 'notes', export: 'notes', version: 1 } }),
		})
		const response = await fetch(describe)
		expect(response.status).toBe(404)
		expect(await response.text()).toContain('has approved no export notes@1 for shop')
	})

	test('with MCP off, /mcp is a session row the service answers 404', async () => {
		expect((await fetch(mcpCall({ ...session, 'sec-fetch-site': 'same-origin' }))).status).toBe(404)
		expect((await fetch(mcpCall({ authorization: 'Bearer px_machine' }))).status).toBe(403)
	})
})

describe('the console behind its MCP table', () => {
	const fetch = console_({ mcp: true })
	const challenge = `Bearer resource_metadata="${METADATA}"`

	test('a session on /mcp gets 401 with the resource challenge, never a login bounce', async () => {
		const response = await fetch(mcpCall({ ...session, 'sec-fetch-site': 'same-origin' }))
		expect(response.status).toBe(401)
		expect(response.headers.get('www-authenticate')).toStartWith(challenge)
	})

	test('a px_ key on /mcp gets 403 with the challenge', async () => {
		for (const key of ['px_user', 'px_machine']) {
			const response = await fetch(mcpCall({ authorization: `Bearer ${key}` }))
			expect(response.status).toBe(403)
			expect(response.headers.get('www-authenticate')).toStartWith(challenge)
		}
	})

	test('a resource token for the console reaches the MCP route', async () => {
		const token = await testResourceToken({ resource: RESOURCE, label: 'author', actions: ['*'] })
		const response = await fetch(mcpCall({ authorization: `Bearer ${token}` }))
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('mcp')
	})
})
