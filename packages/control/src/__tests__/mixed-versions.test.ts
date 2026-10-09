// The console during an upgrade (B10 checkpoint C12): a proxy that already publishes Control's service table in front
// of the service before B10e. The old service ignores `X-Fabrika-Endpoint` and authenticates the injected token, so
// every request the table admits is served as before.

import { SESSION_COOKIE } from '@fabrika/auth-core'
import { serviceProxyTable } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { controlServiceContract } from '../../fabrika.service'
import { controlApp } from '../app'
import type { Env } from '../env'
import { createHarness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'
import { CONSOLE_ORIGIN, consoleBehindProxy } from './helpers/proxy'
import { unusedSourceConnection } from './helpers/source-connection'
import { adminToken, testIamEnv, testToken } from './helpers/tokens'

const machineToken = await testToken({ label: 'machine', actions: ['*'], type: 'service' })

function oldServiceEnv(): Env {
	const harness = createHarness()
	return {
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
}

const rpc = (headers: Record<string, string>) =>
	new Request(`${CONSOLE_ORIGIN}/api/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: JSON.stringify({ method: 'installation', input: null }),
	})

describe('a new proxy in front of the old service', () => {
	const env = oldServiceEnv()
	const fetch = consoleBehindProxy({
		access: { table: serviceProxyTable(controlServiceContract({ mcp: false }), { oauth: false }) },
		iam: { session: adminToken, keys: { px_machine: machineToken } },
		upstream: (request) =>
			controlApp.fetch(request, { env, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('harbor') }, { waitUntil() {} }),
	})
	const session = { cookie: `${SESSION_COOKIE}=s`, origin: CONSOLE_ORIGIN, 'sec-fetch-site': 'same-origin' }

	test('serves a machine key and a same-origin session on the RPC mount', async () => {
		expect((await fetch(rpc({ authorization: 'Bearer px_machine' }))).status).toBe(200)
		expect((await fetch(rpc(session))).status).toBe(200)
	})

	test('serves the console shell and liveness', async () => {
		const shell = await fetch(new Request(`${CONSOLE_ORIGIN}/apps/notes`, { headers: session }))
		expect(shell.status).toBe(200)
		expect(await shell.text()).toBe('dashboard')
		expect((await fetch(new Request(`${CONSOLE_ORIGIN}/healthz`))).status).toBe(200)
	})

	test('a path the old service answered with 404 is now refused at the proxy', async () => {
		expect((await fetch(new Request(`${CONSOLE_ORIGIN}/api/unknown`, { headers: { authorization: 'Bearer px_machine' } }))).status).toBe(403)
	})
})
