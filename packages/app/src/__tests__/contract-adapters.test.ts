// The runtime adapters of a contract application: a Worker that boots with its first request's environment, the
// Bun asset server, and the issuer's key set for a process without an IAM binding.

import { diskAssets, issuerJwks, serveContract } from '@fabrika/app/bun'
import { createContractWorker } from '@fabrika/app/cloudflare'
import { defineContract } from '@fabrika/app/contract'
import { implement } from '@fabrika/app/implement'
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { notesApp } from './fixtures/implement/app'
import {
	endpointHeaderFor,
	frameworkEnvFor,
	grant,
	keepingProcessEnvironment,
	keySource,
	ORIGIN,
	PROXY_SECRET,
	token,
} from './fixtures/implement/harness'

const FRAMEWORK_ENV = frameworkEnvFor(notesApp(new Map()))
const endpointOf = (method: string, path: string): string => endpointHeaderFor(notesApp(new Map()), method, path) ?? ''

const exec = { waitUntil() {}, passThroughOnException() {} }

describe('createContractWorker', () => {
	const worker = createContractWorker(() => Promise.resolve({ default: notesApp(new Map()) }))
	const assets = { fetch: (request: Request) => Promise.resolve(new Response(`asset ${new URL(request.url).pathname}`)) }

	test('boots with the environment of the first request and serves through the IAM binding', async () => {
		const env = { ...FRAMEWORK_ENV, IAM: keySource, ASSETS: assets }
		const request = new Request(`${ORIGIN}/api/me`, {
			method: 'POST',
			headers: {
				'X-Fabrika-Token': await token('user', [grant('notes.read')]),
				'X-Fabrika-Endpoint': endpointOf('POST', '/api/me'),
				'Content-Type': 'application/json',
				'Sec-Fetch-Site': 'same-origin',
			},
			body: '{}',
		})
		const response = await keepingProcessEnvironment(() => worker.fetch(request, env, exec))
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ result: { id: 'user-1', label: 'user@notes.test' } })
		const pageRequest = new Request(`${ORIGIN}/`, {
			headers: { 'X-Fabrika-Token': await token('user', [grant('notes.read')]), 'X-Fabrika-Endpoint': endpointOf('GET', '/') },
		})
		const page = await keepingProcessEnvironment(() => worker.fetch(pageRequest, env, exec))
		expect(await page.text()).toBe('asset /')
	})

	test('refuses to serve without the IAM binding', async () => {
		const refused = keepingProcessEnvironment(() => worker.fetch(new Request(`${ORIGIN}/healthz`), { ...FRAMEWORK_ENV, ASSETS: assets }, exec))
		await expect(refused).rejects.toThrow('the IAM binding is missing')
	})
})

describe('createContractWorker: IAM membership on the IAM binding', () => {
	const starting = defineContract({
		app: 'notes',
		dimensions: { workspace: { creator: 'owner' } },
		actions: { 'notes.read': 'Read', 'workspaces.create': 'Start' },
		roles: { owner: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
	}, (c) => ({
		api: c.rpc('/api', { callers: ['human'] }, {
			start: c.mutation({ output: z.strictObject({ workspace: z.string() }), access: { action: 'workspaces.create', creates: 'workspace' } }),
		}),
	}))
	const app = implement(starting, {
		database: null,
		deps: () => null,
		handlers: () => ({ api: { start: ({ ctx }) => ({ workspace: ctx.created.value }) } }),
	})
	const worker = createContractWorker(() => Promise.resolve({ default: app }))
	const header = endpointHeaderFor(app, 'POST', '/api/start') ?? ''
	const unused = () => Promise.reject(new Error('not called'))
	const binding = (createScope: (input: unknown) => Promise<unknown>) => ({
		...keySource,
		createScope,
		requestDelegation: unused,
		assignMember: unused,
		revokeMember: unused,
		listMembers: unused,
		issueLink: unused,
		revokeLink: unused,
	})
	const start = async () =>
		new Request(`${ORIGIN}/api/start`, {
			method: 'POST',
			headers: {
				'X-Fabrika-Token': await token('user', [grant('workspaces.create')]),
				'X-Fabrika-Endpoint': header,
				'X-Fabrika-Delegation': 'grant-1',
				'Content-Type': 'application/json',
				'Sec-Fetch-Site': 'same-origin',
			},
			body: '{}',
		})

	test('asks IAM through the binding and decodes its answer', async () => {
		const asked: unknown[] = []
		const createScope = (input: unknown) => {
			asked.push(input)
			return Promise.resolve({ ok: true, scope: { type: 'workspace', value: 'w9' }, role: 'owner' })
		}
		const env = { ...frameworkEnvFor(app), IAM: binding(createScope) }
		const response = await keepingProcessEnvironment(async () => worker.fetch(await start(), env, exec))
		expect(await response.json()).toEqual({ result: { workspace: 'w9' } })
		expect(asked).toEqual([expect.objectContaining({ delegation: 'grant-1', dimension: 'workspace', app: 'notes@prod' })])
	})

	test('an answer that breaks the contract is IAM unavailable, a 503', async () => {
		const env = { ...frameworkEnvFor(app), IAM: binding(() => Promise.resolve({ ok: true, scope: 'w9' })) }
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await keepingProcessEnvironment(async () => worker.fetch(await start(), env, exec))
			expect(response.status).toBe(503)
		} finally {
			log.mockRestore()
		}
	})

	test('a binding without the membership operations does not boot a contract that needs them', async () => {
		const env = { ...frameworkEnvFor(app), IAM: keySource }
		const refused = keepingProcessEnvironment(async () => worker.fetch(await start(), env, exec))
		await expect(refused).rejects.toThrow('the runtime adapter supplies no IAM membership transport')
	})
})

describe('serveContract', () => {
	test('imports the application only after the framework variables left the process', async () => {
		await keepingProcessEnvironment(async () => {
			const port = process.env['PORT']
			Object.assign(process.env, { ...FRAMEWORK_ENV, FABRIKA_PROXY_SECRET: PROXY_SECRET, FABRIKA_TEST_SECRET: 'database-password', PORT: '0' })
			let loaded: readonly string[] = []
			const server = await serveContract(async () => {
				const module = await import('./fixtures/implement/snapshot-app')
				loaded = module.snapshotKeys
				return module
			}, process.env)
			try {
				expect(loaded.filter((name) => name.startsWith('FABRIKA_'))).toEqual([])
				expect(loaded).toContain('PORT')
				expect((await fetch(`http://localhost:${server.port}/healthz`)).status).toBe(200)
			} finally {
				await server.stop()
				if (port === undefined) {
					delete process.env['PORT']
				} else {
					process.env['PORT'] = port
				}
			}
		})
	})
})

describe('serveContract on Zerops', () => {
	test('does not start without the proxy secret: a namespace is one private network', async () => {
		await keepingProcessEnvironment(async () => {
			const served = serveContract(() => Promise.resolve({ default: notesApp(new Map()) }), { ...FRAMEWORK_ENV, PORT: '0' })
			await expect(served).rejects.toThrow('FABRIKA_PROXY_SECRET is not set')
		})
	})
})

describe('diskAssets', () => {
	const root = mkdtempSync(join(tmpdir(), 'fabrika-spa-'))
	mkdirSync(join(root, 'dist', 'app', 'assets'), { recursive: true })
	writeFileSync(join(root, 'dist', 'app', 'index.html'), '<main>app</main>')
	writeFileSync(join(root, 'dist', 'app', 'assets', 'main.js'), 'console.info(1)')
	writeFileSync(join(root, 'secret.txt'), 'not served')
	afterAll(() => rmSync(root, { recursive: true, force: true }))
	const assets = diskAssets(root)
	const mount = { prefix: '/', dir: 'dist/app' }

	test('serves a built file, and index.html for a route of the SPA', async () => {
		expect(await (await assets.serve(mount, new Request(`${ORIGIN}/assets/main.js`))).text()).toBe('console.info(1)')
		expect(await (await assets.serve(mount, new Request(`${ORIGIN}/notes/42`))).text()).toBe('<main>app</main>')
		expect(await (await assets.serve(mount, new Request(`${ORIGIN}/`))).text()).toBe('<main>app</main>')
	})

	test('never serves a file outside the build directory', async () => {
		expect(await (await assets.serve({ prefix: '/', dir: 'dist/app' }, new Request(`${ORIGIN}/..%2Fsecret.txt`))).text()).toBe('<main>app</main>')
	})
})

describe('issuerJwks', () => {
	const jwks = { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1' }] }
	const issuer = Bun.serve({
		port: 0,
		fetch: (request) => new URL(request.url).pathname === '/.well-known/jwks.json' ? Response.json(jwks) : new Response(null, { status: 404 }),
	})
	const impostor = Bun.serve({ port: 0, fetch: () => Response.json({ keys: 'none' }) })
	afterAll(() => {
		issuer.stop(true)
		impostor.stop(true)
	})

	test('reads the issuer’s published key set', async () => {
		expect(await issuerJwks(`http://localhost:${issuer.port}`).getJwks()).toEqual(jwks)
	})

	test('fails without an issuer, and on an answer that is no key set', async () => {
		await expect(issuerJwks(undefined).getJwks()).rejects.toThrow('FABRIKA_IAM_ISSUER is not set')
		await expect(issuerJwks(`http://localhost:${impostor.port}`).getJwks()).rejects.toThrow('no usable key set')
	})
})
