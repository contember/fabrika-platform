/**
 * A contract application behind the Cloudflare proxy Worker that `fabrika.config.ts` builds with the gates
 * `gatesFromContract` generates: each request goes through the proxy decision into `boot`'s real pipeline. The
 * proxy admits a credential kind by path; the framework then refuses the caller kind the endpoint does not take.
 */

import { compileContract, gatesFromContract } from '@fabrika/app/contract'
import type { MintFromKeyResult, MintTokenResult, PermissionEntry } from '@fabrika/auth-core'
import { silentLogger } from '@fabrika/proxy-core'
import { parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { Worker } from 'oblaka-iac'
import { notesApp } from '../../../app/src/__tests__/fixtures/implement/app'
import { contract } from '../../../app/src/__tests__/fixtures/implement/fabrika.contract'
import { APP_ID, bootApp, grant, ISSUER, keySource, token, type TokenKind } from '../../../app/src/__tests__/fixtures/implement/harness'
import { NOTE_TABLE } from '../../../app/src/__tests__/fixtures/implement/stores'
import { FakeIam } from '../../../proxy-core/src/__tests__/helpers'
import { createCloudflareProxyWorker } from '../proxy'
import { createCloudflareProxyHandler } from '../proxy-worker'

const HOST = 'notes.example.com'
const artifact = compileContract(contract, { notes: NOTE_TABLE })
const gates = gatesFromContract(artifact)

const proxyWorker = createCloudflareProxyWorker({
	name: 'notes-proxy',
	app: new Worker({
		dir: '.',
		name: 'notes-app',
		main: './src/index.ts',
		compatibility_flags: [],
		bindings: {},
		workers_dev: false,
		preview_urls: false,
		routes: [],
	}),
	appId: APP_ID,
	appHost: HOST,
	gates,
	iamUrl: ISSUER,
})

function bakedManifest(): string {
	const encoded = proxyWorker.options.vars?.['FABRIKA_PROXY_MANIFEST_JSON']
	if (typeof encoded !== 'string') {
		throw new Error('the proxy Worker carries no manifest')
	}
	return encoded
}

const inW1 = (action: string): PermissionEntry => grant(action, { type: 'workspace', value: 'w1' })

async function minted(kind: TokenKind, perms: PermissionEntry[]): Promise<{ ok: true; token: string; expiresAt: number }> {
	return { ok: true, token: await token(kind, perms), expiresAt: Math.floor(Date.now() / 1000) + 300 }
}

interface Caller {
	readonly session?: MintTokenResult
	readonly key?: MintFromKeyResult
}

async function proxyFor(caller: Caller) {
	const app = bootApp(notesApp(new Map()))
	const iam = new FakeIam({
		jwks: await keySource.getJwks(),
		...(caller.session === undefined ? {} : { mintToken: caller.session }),
		...(caller.key === undefined ? {} : { mintFromKey: caller.key }),
	})
	let reached = 0
	const handler = createCloudflareProxyHandler({
		IAM: iam,
		FABRIKA_IAM_ISSUER: ISSUER,
		FABRIKA_PROXY_MANIFEST_JSON: bakedManifest(),
		APP: {
			fetch: (request: Request) => {
				reached++
				return app.fetch(request)
			},
		},
	}, silentLogger)
	return { handler, reached: () => reached }
}

function post(path: string, body: unknown, headers: Record<string, string>): Request {
	return new Request(`https://${HOST}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

const SESSION = { Cookie: '__Host-px_session=session', 'Sec-Fetch-Site': 'same-origin' }

describe('a contract application behind its generated gates on Cloudflare', () => {
	test('the proxy Worker bakes the generated gates into its manifest verbatim', () => {
		expect(parseProxyManifestJson(bakedManifest())?.apps).toMatchObject([{ gates }])
	})

	test('an anonymous health check reaches the application without a token', async () => {
		const { handler } = await proxyFor({})
		const response = await handler(new Request(`https://${HOST}/healthz`))
		expect(response.status).toBe(200)
	})

	test('a signed-in person reaches a person procedure', async () => {
		const { handler } = await proxyFor({ session: await minted('user', [inW1('notes.read')]) })
		const response = await handler(post('/api/notes.list', {}, SESSION))
		expect(response.status).toBe(200)
		expect(await response.json<unknown>()).toEqual({ result: { items: [] } })
	})

	test('a machine key reaches the machine procedure', async () => {
		const { handler } = await proxyFor({ key: await minted('service', [inW1('notes.write')]) })
		const response = await handler(post('/machine/importNotes', { workspaceId: 'w1', titles: ['a'] }, { Authorization: 'Bearer px_key' }))
		expect(response.status).toBe(200)
		expect(await response.json<unknown>()).toEqual({ result: { imported: 1 } })
	})

	test('without a session a person procedure answers the login challenge and never reaches the application', async () => {
		const { handler, reached } = await proxyFor({})
		const response = await handler(post('/api/notes.list', {}, { 'Sec-Fetch-Mode': 'cors' }))
		expect(response.status).toBe(401)
		expect(reached()).toBe(0)
	})

	test('a session on the machine path falls through to the SPA gate, and the framework refuses the caller kind', async () => {
		const { handler, reached } = await proxyFor({ session: await minted('user', [inW1('notes.write')]) })
		const response = await handler(post('/machine/importNotes', { workspaceId: 'w1', titles: ['a'] }, SESSION))
		expect(reached()).toBe(1)
		expect(response.status).toBe(403)
	})
})
