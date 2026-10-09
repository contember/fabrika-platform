// Admission of the console's state changes through the real proxy (ADR-0022): which requests reach Control on the
// three JSON mounts, the GitHub connection mutations and the approvals, and who refuses the rest. A session needs
// `Sec-Fetch-Site: same-origin` at the proxy; a bearer is explicit authority, which the browser never attaches itself.

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
import { adminToken, testIamEnv } from './helpers/tokens'

const SIBLING_ORIGIN = 'https://evil.control.test'

/** Who answered a request: the proxy before Control was asked, or Control with its status. */
type Outcome = `proxy ${number}` | `control ${number}`

function admissionFixture(): (request: Request) => Promise<Outcome> {
	const harness = createHarness()
	const upstreamOk = () => Promise.resolve(Response.json({ result: null }))
	const env: Env = {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'local',
		FABRIKA_CONTROL_DOMAIN: CONSOLE_ORIGIN,
		IAM_ADMIN: { fetch: upstreamOk },
		OPERATIONS: { fetch: upstreamOk },
		...testIamEnv,
	}
	let reached = false
	const fetch = consoleBehindProxy({
		access: { table: serviceProxyTable(controlServiceContract({ mcp: false }), { oauth: false }) },
		iam: { session: adminToken, keys: { px_admin: adminToken } },
		upstream: (request) => {
			reached = true
			return controlApp.fetch(request, { env, provider: fakeControlProvider, sourceConnection: unusedSourceConnection('harbor') }, { waitUntil() {} })
		},
	})
	return async (request) => {
		reached = false
		const response = await fetch(request)
		return reached ? `control ${response.status}` : `proxy ${response.status}`
	}
}

type Credential = 'same-origin session' | 'cross-site session' | 'same-site session' | 'bearer' | 'bearer and cookie'

const CREDENTIALS: Readonly<Record<Credential, Record<string, string>>> = {
	'same-origin session': { cookie: `${SESSION_COOKIE}=s`, origin: CONSOLE_ORIGIN, 'sec-fetch-site': 'same-origin' },
	'cross-site session': { cookie: `${SESSION_COOKIE}=s`, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
	'same-site session': { cookie: `${SESSION_COOKIE}=s`, origin: SIBLING_ORIGIN, 'sec-fetch-site': 'same-site' },
	'bearer': { authorization: 'Bearer px_admin' },
	'bearer and cookie': { authorization: 'Bearer px_admin', cookie: `${SESSION_COOKIE}=s` },
}

interface Call {
	readonly name: string
	readonly path: string
	readonly body: unknown
}

const rpc = (method: string, input: unknown): Call => ({ name: method, path: '/api/rpc', body: { method, input } })

const call = (target: Call, credential: Credential) =>
	new Request(`${CONSOLE_ORIGIN}${target.path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...CREDENTIALS[credential] },
		body: JSON.stringify(target.body),
	})

const MOUNTS: readonly Call[] = [
	rpc('installation', null),
	{ name: 'iam admin', path: '/iam/admin/rpc', body: { method: 'listPrincipals', input: null } },
	{ name: 'operations', path: '/operations/api/rpc', body: { method: 'issues', input: null } },
]
const GITHUB: readonly Call[] = [
	rpc('sourceConnection.start', { organization: 'acme', appName: 'Acme', visibility: 'private', repositories: [] }),
	rpc('sourceConnection.verifyInstallation', { connectionId: 'missing' }),
	rpc('sourceConnection.repair', { connectionId: 'missing' }),
	rpc('sourceConnection.reconcile', { connectionId: 'missing' }),
]
const APPROVALS: readonly Call[] = [
	rpc('approvals.complete', {
		runId: 'missing',
		decision: 'approve',
		candidateDigest: `sha256:${'a'.repeat(64)}`,
		baselineDigest: `sha256:${'b'.repeat(64)}`,
	}),
	rpc('apps.environments.protect', { appId: 'missing', env: 'stage', protected: false }),
]

describe('a session reaches a console state change only from the console itself', () => {
	const fetch = admissionFixture()

	for (const target of [...MOUNTS, ...GITHUB, ...APPROVALS]) {
		test(`${target.name}: cross-site and same-site sessions are refused at the proxy`, async () => {
			expect(await fetch(call(target, 'cross-site session'))).toBe('proxy 403')
			expect(await fetch(call(target, 'same-site session'))).toBe('proxy 403')
		})

		test(`${target.name}: a same-origin session reaches Control and passes its admission`, async () => {
			const outcome = await fetch(call(target, 'same-origin session'))
			expect(outcome.startsWith('control ')).toBe(true)
			expect(outcome).not.toBe('control 403')
		})
	}
})

test('a doubled slash cannot route a session around the RPC row', async () => {
	const fetch = admissionFixture()
	const doubled = { name: 'installation', path: '//api/rpc', body: { method: 'installation', input: null } }
	expect(await fetch(call(doubled, 'cross-site session'))).toBe('proxy 400')
})

describe('a bearer is explicit authority', () => {
	const fetch = admissionFixture()

	for (const target of MOUNTS.slice(0, 2)) {
		test(`${target.name}: a bearer, with or without a cookie, is served`, async () => {
			expect(await fetch(call(target, 'bearer'))).toBe('control 200')
			expect(await fetch(call(target, 'bearer and cookie'))).toBe('control 200')
		})
	}

	// Control's own same-origin guards still refuse these; the proxy's admission is meant to replace them.
	for (const target of [...MOUNTS.slice(2), ...GITHUB]) {
		test(`${target.name}: a bearer without the console's origin is refused by Control`, async () => {
			expect(await fetch(call(target, 'bearer'))).toBe('control 403')
			expect(await fetch(call(target, 'bearer and cookie'))).toBe('control 403')
		})
	}

	for (const target of APPROVALS) {
		test(`${target.name}: a key is refused by authorization, cookie or not`, async () => {
			expect(await fetch(call(target, 'bearer'))).toBe('control 403')
			expect(await fetch(call(target, 'bearer and cookie'))).toBe('control 403')
		})
	}
})
