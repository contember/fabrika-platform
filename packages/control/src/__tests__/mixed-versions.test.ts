// The console during an upgrade (B10 checkpoint C12). The proxy deploys first, so the window is a proxy that publishes
// the console's table in front of the service before B10e; the commit that recorded it tested that old service, which
// ignored `X-Fabrika-Endpoint` and served what the table admitted. The reverse — the new service behind an older proxy
// that names no endpoint — is the brief window of a paired deploy that lands in the wrong order: every credentialed row
// answers 503, while liveness and the self-authenticating rows still answer.

import { PROXY_TOKEN_HEADER, SESSION_COOKIE } from '@fabrika/auth-core'
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

function serviceEnv(): Env {
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

describe('the service behind the proxy that publishes its table', () => {
	const env = serviceEnv()
	const fetch = consoleBehindProxy({
		table: serviceProxyTable(controlServiceContract({ mcp: false }), { oauth: false }),
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

	test('a path the service answers with 404 is refused at the proxy', async () => {
		expect((await fetch(new Request(`${CONSOLE_ORIGIN}/api/unknown`, { headers: { authorization: 'Bearer px_machine' } }))).status).toBe(403)
	})
})

describe('the service behind an older proxy that injects a token but names no endpoint', () => {
	const env = serviceEnv()
	// What such a proxy forwarded: its verified token, and no `X-Fabrika-Endpoint`.
	const fetch = (request: Request) => {
		const headers = new Headers(request.headers)
		headers.set(PROXY_TOKEN_HEADER, adminToken)
		return controlApp.fetch(new Request(request, { headers }), {
			env,
			provider: fakeControlProvider,
			sourceConnection: unusedSourceConnection('harbor'),
		}, { waitUntil() {} })
	}

	test('every credentialed row answers 503: nothing names the endpoint the service checks', async () => {
		expect((await fetch(rpc({}))).status).toBe(503)
		expect((await fetch(new Request(`${CONSOLE_ORIGIN}/apps/notes`))).status).toBe(503)
	})

	test('liveness and the self-authenticating rows still answer', async () => {
		expect((await fetch(new Request(`${CONSOLE_ORIGIN}/healthz`))).status).toBe(200)
		expect((await fetch(new Request(`${CONSOLE_ORIGIN}/api/health`))).status).toBe(200)
		const webhook = await fetch(new Request(`${CONSOLE_ORIGIN}/webhooks/github/unknown-connection`, { method: 'POST', body: '{}' }))
		expect(webhook.status).not.toBe(503)
	})
})
