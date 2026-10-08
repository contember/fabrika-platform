// The runtime adapters of a contract application: a Worker that boots with its first request's environment, the
// Bun asset server, and the issuer's key set for a process without an IAM binding.

import { diskAssets, issuerJwks } from '@fabrika/app/bun'
import { createContractWorker } from '@fabrika/app/cloudflare'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notesApp } from './fixtures/implement/app'
import { FRAMEWORK_ENV, grant, keySource, ORIGIN, token } from './fixtures/implement/harness'

const exec = { waitUntil() {}, passThroughOnException() {} }

describe('createContractWorker', () => {
	const worker = createContractWorker(notesApp(new Map()))
	const assets = { fetch: (request: Request) => Promise.resolve(new Response(`asset ${new URL(request.url).pathname}`)) }

	test('boots with the environment of the first request and serves through the IAM binding', async () => {
		const env = { ...FRAMEWORK_ENV, IAM: keySource, ASSETS: assets }
		const request = new Request(`${ORIGIN}/api/me`, {
			method: 'POST',
			headers: { 'X-Fabrika-Token': await token('user', [grant('notes.read')]), 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
			body: '{}',
		})
		const response = await worker.fetch(request, env, exec)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ result: { id: 'user-1', label: 'user@notes.test' } })
		const page = await worker.fetch(
			new Request(`${ORIGIN}/`, { headers: { 'X-Fabrika-Token': await token('user', [grant('notes.read')]) } }),
			env,
			exec,
		)
		expect(await page.text()).toBe('asset /')
	})

	test('refuses to serve without the IAM binding', async () => {
		expect(() => worker.fetch(new Request(`${ORIGIN}/healthz`), { ...FRAMEWORK_ENV, ASSETS: assets }, exec)).toThrow('the IAM binding is missing')
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
