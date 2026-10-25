// The runtime adapters of a contract application: a Worker that boots with its first request's environment, the
// Bun asset server, and the issuer's key set for a process without an IAM binding.

import { diskAssets, issuerJwks, serveContract } from '@fabrika/app/bun'
import { defineContract } from '@fabrika/app/contract'
import { PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { implement } from '../implement/implement'
import { notesApp } from './fixtures/implement/app'
import {
	endpointHeaderFor,
	frameworkEnvFor,
	grant,
	keepingProcessEnvironment,
	ORIGIN,
	PROXY_SECRET,
	serveStandInIam,
	token,
} from './fixtures/implement/harness'

const FRAMEWORK_ENV = frameworkEnvFor(notesApp(new Map()))
const _endpointOf = (method: string, path: string): string => endpointHeaderFor(notesApp(new Map()), method, path) ?? ''

const _exec = { waitUntil() {}, passThroughOnException() {} }

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
/** A contract that creates scopes, so it needs IAM's membership operations to boot. */
const startingApp = implement(starting, {
	database: null,
	deps: () => null,
	handlers: () => ({ api: { start: ({ ctx }) => ({ workspace: ctx.created.value }) } }),
})

describe('serveContract', () => {
	test('a contract that asks IAM does not boot without the membership transport, and the refusal names it', async () => {
		await keepingProcessEnvironment(async () => {
			const env = { ...frameworkEnvFor(startingApp), FABRIKA_PROXY_SECRET: PROXY_SECRET, PORT: '0' }
			const served = serveContract(() => Promise.resolve({ default: startingApp }), env)
			await expect(served).rejects.toThrow('FABRIKA_IAM_RPC_URL and FABRIKA_IAM_RPC_KEY on Bun')
		})
	})

	test('asks IAM through its membership transport, with the environment key, for its own application', async () => {
		const key = `px_${'m'.repeat(27)}`
		const asked: { path: string; bearer: string | null; body: unknown }[] = []
		const iam = serveStandInIam(startingApp, async (request) => {
			asked.push({ path: new URL(request.url).pathname, bearer: request.headers.get('authorization'), body: await request.json() })
			return Response.json({ ok: true, scope: { type: 'workspace', value: 'w9' }, role: 'owner' })
		})
		try {
			await keepingProcessEnvironment(async () => {
				const env = {
					...frameworkEnvFor(startingApp),
					FABRIKA_IAM_ISSUER: iam.origin,
					FABRIKA_IAM_RPC_URL: iam.origin,
					FABRIKA_IAM_RPC_KEY: key,
					FABRIKA_PROXY_SECRET: PROXY_SECRET,
					PORT: '0',
				}
				const server = await serveContract(() => Promise.resolve({ default: startingApp }), env)
				try {
					const response = await fetch(`http://localhost:${server.port}/api/start`, {
						method: 'POST',
						headers: {
							[PROXY_SECRET_HEADER]: PROXY_SECRET,
							'X-Fabrika-Token': await token('user', [grant('workspaces.create')], undefined, iam.origin),
							'X-Fabrika-Endpoint': endpointHeaderFor(startingApp, 'POST', '/api/start') ?? '',
							'X-Fabrika-Delegation': 'grant-1',
							'Content-Type': 'application/json',
							'Sec-Fetch-Site': 'same-origin',
						},
						body: '{}',
					})
					expect(await response.json()).toEqual({ result: { workspace: 'w9' } })
				} finally {
					await server.stop()
				}
			})
		} finally {
			await iam.stop()
		}
		expect(asked).toEqual([{
			path: '/membership/createScope',
			bearer: `Bearer ${key}`,
			body: expect.objectContaining({ app: 'notes@prod', delegation: 'grant-1', dimension: 'workspace' }),
		}])
	})

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
		const outside = new Request(`${ORIGIN}/..%2Fsecret.txt`, { headers: { Accept: 'text/html' } })
		expect(await (await assets.serve({ prefix: '/', dir: 'dist/app' }, outside)).text()).toBe('<main>app</main>')
		expect((await assets.serve({ prefix: '/', dir: 'dist/app' }, new Request(`${ORIGIN}/..%2Fsecret.txt`))).status).toBe(404)
	})

	test('a missing asset is 404, not the index; a navigation to a dotted route is the page', async () => {
		const missing = await assets.serve(mount, new Request(`${ORIGIN}/assets/old.js`))
		expect([missing.status, await missing.text()]).toEqual([404, 'Not found'])
		const page = await assets.serve(mount, new Request(`${ORIGIN}/releases/v1.2`, { headers: { Accept: 'text/html' } }))
		expect(await page.text()).toBe('<main>app</main>')
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
