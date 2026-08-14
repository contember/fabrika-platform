import { describe, expect, test } from 'bun:test'
import { ApiError, type ControlFetch, createControlClient } from '../lib/api'

interface RpcCall {
	method: string
	input: unknown
}

function recordingFetch(calls: RpcCall[], result: unknown = null): ControlFetch {
	return async (_input, init) => {
		if (typeof init?.body !== 'string') throw new Error('expected JSON RPC body')
		const body: unknown = JSON.parse(init.body)
		if (body === null || typeof body !== 'object' || !('method' in body) || typeof body.method !== 'string' || !('input' in body)) {
			throw new Error('expected RPC envelope')
		}
		calls.push({ method: body.method, input: body.input })
		return Response.json({ result })
	}
}

describe('Delivery RPC client', () => {
	test('maps every registry procedure used by the dashboard', async () => {
		const calls: RpcCall[] = []
		const client = createControlClient(recordingFetch(calls))
		const envelope = { provider: 'zerops', version: 2, payload: {} }
		const environment = {
			domain: 'billing.example.com',
			publicOrigin: 'https://billing.example.com',
			triggerRef: 'refs/heads/main',
			namespaceId: 'apps-prod',
			target: envelope,
			artifact: envelope,
		}

		await client.apps.list()
		await client.apps.get({ appId: 'billing' })
		await client.apps.update({ appId: 'billing', app: { defaultBranch: 'trunk' } })
		await client.apps.delete({ appId: 'billing' })
		await client.apps.environments.list({ appId: 'billing' })
		await client.apps.environments.put({ appId: 'billing', env: 'prod', environment })
		await client.apps.environments.delete({ appId: 'billing', env: 'prod' })
		await client.apps.secrets.list({ appId: 'billing' })
		await client.apps.secrets.put({ appId: 'billing', secret: { name: 'TOKEN', valueRef: 'env:TOKEN', env: null } })
		await client.apps.secrets.delete({ appId: 'billing', name: 'TOKEN', env: null })
		await client.apps.variables.list({ appId: 'billing' })
		await client.apps.variables.put({ appId: 'billing', variable: { name: 'LOG_LEVEL', value: 'info', env: 'prod' } })
		await client.apps.variables.delete({ appId: 'billing', name: 'LOG_LEVEL', env: 'prod' })

		expect(calls).toEqual([
			{ method: 'apps.list', input: null },
			{ method: 'apps.get', input: { appId: 'billing' } },
			{ method: 'apps.update', input: { appId: 'billing', app: { defaultBranch: 'trunk' } } },
			{ method: 'apps.delete', input: { appId: 'billing' } },
			{ method: 'apps.environments.list', input: { appId: 'billing' } },
			{ method: 'apps.environments.put', input: { appId: 'billing', env: 'prod', environment } },
			{ method: 'apps.environments.delete', input: { appId: 'billing', env: 'prod' } },
			{ method: 'apps.secrets.list', input: { appId: 'billing' } },
			{ method: 'apps.secrets.put', input: { appId: 'billing', secret: { name: 'TOKEN', valueRef: 'env:TOKEN', env: null } } },
			{ method: 'apps.secrets.delete', input: { appId: 'billing', name: 'TOKEN', env: null } },
			{ method: 'apps.variables.list', input: { appId: 'billing' } },
			{ method: 'apps.variables.put', input: { appId: 'billing', variable: { name: 'LOG_LEVEL', value: 'info', env: 'prod' } } },
			{ method: 'apps.variables.delete', input: { appId: 'billing', name: 'LOG_LEVEL', env: 'prod' } },
		])
	})

	test('maps namespace procedures used by the dashboard', async () => {
		const calls: RpcCall[] = []
		const client = createControlClient(recordingFetch(calls))
		const target = { provider: 'zerops', version: 2, payload: { projectId: 'project-1' } }

		await client.namespaces.list()
		await client.namespaces.get({ namespaceId: 'apps-prod' })
		await client.namespaces.plan({ id: 'apps-prod', env: 'prod', preset: 'shared' })
		await client.namespaces.create({ id: 'apps-prod', env: 'prod', exclusiveAppId: null, target })
		await client.namespaces.reconcile({ namespaceId: 'apps-prod' })

		expect(calls).toEqual([
			{ method: 'namespaces.list', input: null },
			{ method: 'namespaces.get', input: { namespaceId: 'apps-prod' } },
			{ method: 'namespaces.plan', input: { id: 'apps-prod', env: 'prod', preset: 'shared' } },
			{ method: 'namespaces.create', input: { id: 'apps-prod', env: 'prod', exclusiveAppId: null, target } },
			{ method: 'namespaces.reconcile', input: { namespaceId: 'apps-prod' } },
		])
	})

	test('maps source connection procedures without browser-side credential fields', async () => {
		const calls: RpcCall[] = []
		const client = createControlClient(recordingFetch(calls, { provider: 'zerops', kind: 'github-app', state: 'anonymous' }))
		await client.sourceConnection.status()
		await client.sourceConnection.start({
			organization: 'acme',
			appName: 'acme-fabrika',
			visibility: 'private',
			repositories: [{ owner: 'acme', name: 'api' }],
		})
		await client.sourceConnection.adoptExisting()
		await client.sourceConnection.verifyInstallation({ connectionId: 'connection-1' })
		await client.sourceConnection.repair({ connectionId: 'connection-1' })
		expect(calls).toEqual([
			{ method: 'sourceConnection.status', input: null },
			{
				method: 'sourceConnection.start',
				input: {
					organization: 'acme',
					appName: 'acme-fabrika',
					visibility: 'private',
					repositories: [{ owner: 'acme', name: 'api' }],
				},
			},
			{ method: 'sourceConnection.adoptExisting', input: null },
			{ method: 'sourceConnection.verifyInstallation', input: { connectionId: 'connection-1' } },
			{ method: 'sourceConnection.repair', input: { connectionId: 'connection-1' } },
		])
		expect(JSON.stringify(calls)).not.toContain('privateKey')
		expect(JSON.stringify(calls)).not.toContain('webhookSecret')
	})

	test('maps run, deploy, and registration procedures without changing cursor inputs', async () => {
		const calls: RpcCall[] = []
		const client = createControlClient(recordingFetch(calls))
		const envelope = { provider: 'zerops', version: 2, payload: {} }

		await client.runs.list({ appId: 'billing', env: 'prod', before: 'cursor-1', limit: 50 })
		await client.runs.get({ runId: 'run-2' })
		await client.runs.log({ runId: 'run-2' })
		await client.runs.tail({ runId: 'run-2', after: 17 })
		await client.runs.cancel({ runId: 'run-2' })
		await client.deploy({ appId: 'billing', env: 'prod', ref: 'refs/tags/v1' })
		await client.register({
			id: 'billing',
			repoUrl: 'https://github.com/acme/billing',
			env: 'prod',
			namespaceId: 'apps-prod',
			target: envelope,
			artifact: envelope,
		})

		expect(calls).toEqual([
			{ method: 'runs.list', input: { appId: 'billing', env: 'prod', before: 'cursor-1', limit: 50 } },
			{ method: 'runs.get', input: { runId: 'run-2' } },
			{ method: 'runs.log', input: { runId: 'run-2' } },
			{ method: 'runs.tail', input: { runId: 'run-2', after: 17 } },
			{ method: 'runs.cancel', input: { runId: 'run-2' } },
			{ method: 'deploy', input: { appId: 'billing', env: 'prod', ref: 'refs/tags/v1' } },
			{
				method: 'register',
				input: {
					id: 'billing',
					repoUrl: 'https://github.com/acme/billing',
					env: 'prod',
					namespaceId: 'apps-prod',
					target: envelope,
					artifact: envelope,
				},
			},
		])
	})

	test('keeps secret values in the write input and never expects them in the response', async () => {
		const calls: RpcCall[] = []
		const client = createControlClient(recordingFetch(calls, { ok: true, valueRef: 'vault:stored' }))

		const result = await client.vault.set({ appId: 'billing', name: 'TOKEN', env: 'prod', value: 'write-only' })

		expect(calls).toEqual([{
			method: 'vault.set',
			input: { appId: 'billing', name: 'TOKEN', env: 'prod', value: 'write-only' },
		}])
		expect(result).toEqual({ ok: true, valueRef: 'vault:stored' })
		expect(result).not.toHaveProperty('value')

		await client.vault.rotate({ appId: 'billing', name: 'TOKEN', env: 'prod', value: 'replacement' })
		expect(calls[1]).toEqual({
			method: 'vault.rotate',
			input: { appId: 'billing', name: 'TOKEN', env: 'prod', value: 'replacement' },
		})
	})

	test('redirects once in a browser and surfaces a repeated unauthorized response', async () => {
		const browser = stubBrowser('https://console.example/runs/run-1')
		try {
			const client = createControlClient(async () =>
				Response.json(
					{ error: { type: 'auth', message: 'login required', loginUrl: 'https://iam.example/login?flow=console' } },
					{ status: 401 },
				)
			)
			void client.apps.list()
			const redirected = new URL(await browser.assigned)
			expect(redirected.origin + redirected.pathname).toBe('https://iam.example/login')
			expect(redirected.searchParams.get('flow')).toBe('console')
			expect(redirected.searchParams.get('redirect')).toBe('https://console.example/runs/run-1')

			const error = await client.apps.list().catch((cause: unknown) => cause)
			expect(error).toBeInstanceOf(ApiError)
			expect(browser.assignments).toHaveLength(1)
		} finally {
			browser.restore()
		}
	})

	test("the proxy's own 401 envelope, byte for byte, bounces the console to IAM", async () => {
		// An expired session on an RPC POST is refused by the PROXY, not by control — the console never
		// reaches its upstream. `packages/proxy/src/service.ts` (`loginRequired`) writes exactly this,
		// and `packages/proxy/src/authorize.ts` (`loginUrl`) builds exactly that URL. Both are copied
		// here verbatim: if either changes shape, this fails and the console stops signing users in.
		const loginUrl = `https://iam.fabrika.localhost/auth/login?app=vozka&redirect=${encodeURIComponent('https://console.fabrika.localhost/api/rpc')}`
		const proxyBody = JSON.stringify({ error: { type: 'auth', message: 'Authentication required', loginUrl } })

		const browser = stubBrowser('https://console.fabrika.localhost/apps/billing')
		try {
			const client = createControlClient(async () =>
				new Response(proxyBody, {
					status: 401,
					headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
				})
			)
			void client.apps.list()
			const redirected = new URL(await browser.assigned)

			expect(redirected.origin + redirected.pathname).toBe('https://iam.fabrika.localhost/auth/login')
			// ADR-0021 needs `app=`; the client only rewrites `redirect=`, to the page the operator is on
			// rather than the RPC endpoint the miss happened at.
			expect(redirected.searchParams.get('app')).toBe('vozka')
			expect(redirected.searchParams.get('redirect')).toBe('https://console.fabrika.localhost/apps/billing')
		} finally {
			browser.restore()
		}
	})

	test('surfaces auth envelopes with status and login URL', async () => {
		const client = createControlClient(async () =>
			Response.json(
				{ error: { type: 'auth', message: 'login required', loginUrl: 'https://iam.example/login' } },
				{ status: 401 },
			)
		)

		const error = await client.apps.list().catch((cause: unknown) => cause)

		expect(error).toBeInstanceOf(ApiError)
		if (!(error instanceof ApiError)) throw new Error('expected ApiError')
		expect(error.httpStatus).toBe(401)
		expect(error.loginUrl).toBe('https://iam.example/login')
	})

	test('normalizes network failures', async () => {
		const client = createControlClient(async () => {
			throw new Error('credential-bearing URL must not escape')
		})

		const error = await client.apps.list().catch((cause: unknown) => cause)

		expect(error).toBeInstanceOf(ApiError)
		if (!(error instanceof ApiError)) throw new Error('expected ApiError')
		expect(error.type).toBe('transport')
		expect(error.httpStatus).toBe(0)
		expect(error.message).toBe('Network request failed')
	})
})

interface StubbedBrowser {
	/** Every URL `window.location.assign` was called with, in order. */
	readonly assignments: string[]
	/** Resolves with the FIRST assignment — the bounce is fire-and-forget, so the test must await it. */
	readonly assigned: Promise<string>
	restore(): void
}

/** The three globals `bounceOnAuth` needs: `window`, `location.assign`, and `sessionStorage`. */
function stubBrowser(href: string): StubbedBrowser {
	const descriptors = new Map<string, PropertyDescriptor | undefined>()
	for (const key of ['window', 'location', 'sessionStorage']) {
		descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
	}
	const stored = new Map<string, string>()
	const assignments: string[] = []
	let resolveAssignment: (url: string) => void = () => undefined
	const assigned = new Promise<string>((resolve) => {
		resolveAssignment = resolve
	})

	Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis })
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: {
			href,
			assign(url: string) {
				assignments.push(url)
				resolveAssignment(url)
			},
		},
	})
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: {
			getItem(key: string) {
				return stored.get(key) ?? null
			},
			setItem(key: string, value: string) {
				stored.set(key, value)
			},
			removeItem(key: string) {
				stored.delete(key)
			},
		},
	})

	return {
		assignments,
		assigned,
		restore() {
			for (const [key, descriptor] of descriptors) {
				restoreProperty(key, descriptor)
			}
		},
	}
}

function restoreProperty(key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor === undefined) {
		Reflect.deleteProperty(globalThis, key)
		return
	}
	Object.defineProperty(globalThis, key, descriptor)
}
