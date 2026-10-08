/**
 * The Zerops deploy path of a contract application, in process: `fabrika.config.ts` hands its provider the gates
 * and the IAM schema the contract generates, the build compiles the Fabrika manifest, the namespace compiles its
 * proxy manifest from it, and the proxy's auth service decides each request that Caddy then forwards to `boot`.
 * The local composition runs this same chain with the real Caddy in front of it.
 */

import { compileContract, gatesFromContract, schemaFromContract } from '@fabrika/app/contract'
import { appSchemaSchema } from '@fabrika/auth'
import { type MintFromKeyResult, type MintTokenResult, type PermissionEntry, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { compileFabrikaManifest, defineApp, zeropsArtifactCodec, type ZeropsArtifactSourceDescriptor } from '@fabrika/provider-zerops'
import { createVerifyService } from '@fabrika/proxy-core'
import { parseProxyManifest } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { notesApp } from '../../../app/src/__tests__/fixtures/implement/app'
import { contract } from '../../../app/src/__tests__/fixtures/implement/fabrika.contract'
import { bootApp, grant, ISSUER, keySource, token, type TokenKind } from '../../../app/src/__tests__/fixtures/implement/harness'
import { NOTE_TABLE } from '../../../app/src/__tests__/fixtures/implement/stores'
import { compileNamespaceProxyManifest } from '../../../provider-zerops/src/namespace/manifest'
import { FakeIam, verifyRequest } from '../../../proxy-core/src/__tests__/helpers'

const HOST = 'notes.example.com'
const artifact = compileContract(contract, { notes: NOTE_TABLE })

const config = defineApp({
	id: 'notes',
	schema: schemaFromContract(artifact),
	target: {
		platform: 'zerops',
		services: () => [{ hostname: 'notesapi', type: 'alpine/bun@1.3', enableSubdomainAccess: false }],
		proxy: { upstream: 'notesapi:3000', gates: gatesFromContract(artifact) },
	},
})

const contents = 'zerops:\n  - setup: notesapi\n'
const SOURCE_DESCRIPTOR: ZeropsArtifactSourceDescriptor = {
	path: 'zerops.yaml',
	contents,
	sha256: new Bun.CryptoHasher('sha256').update(contents).digest('hex'),
}

const manifest = compileFabrikaManifest(config, 'prod', SOURCE_DESCRIPTOR)
const proxyManifest = compileNamespaceProxyManifest('apps-prod', [{
	appId: 'notes',
	env: 'prod',
	domain: HOST,
	artifact: { provider: 'zerops', version: zeropsArtifactCodec.version, payload: zeropsArtifactCodec.encode(manifest) },
}])

const inW1 = (action: string): PermissionEntry => grant(action, { type: 'workspace', value: 'w1' })

async function minted(kind: TokenKind, perms: PermissionEntry[]): Promise<{ ok: true; token: string; expiresAt: number }> {
	return { ok: true, token: await token(kind, perms), expiresAt: Math.floor(Date.now() / 1000) + 300 }
}

interface Caller {
	readonly session?: MintTokenResult
	readonly key?: MintFromKeyResult
}

interface ProxiedRequest {
	readonly method: 'GET' | 'POST'
	readonly path: string
	readonly headers?: Record<string, string>
	readonly body?: unknown
}

/** Caddy's fixed chain: `forward_auth` to the auth service, then the request to the upstream with the token it returned. */
async function throughTheProxy(caller: Caller, request: ProxiedRequest): Promise<{ status: number; reachedApp: boolean; body: string }> {
	const parsed = parseProxyManifest(proxyManifest)
	if (parsed === null) {
		throw new Error('the namespace proxy manifest does not parse')
	}
	const verify = createVerifyService({
		manifest: parsed,
		issuer: ISSUER,
		iam: new FakeIam({
			jwks: await keySource.getJwks(),
			...(caller.session === undefined ? {} : { mintToken: caller.session }),
			...(caller.key === undefined ? {} : { mintFromKey: caller.key }),
		}),
	})
	const headers = request.headers ?? {}
	const decision = await verify(verifyRequest({ app: 'notes@prod', host: HOST, method: request.method, path: request.path, headers }))
	// Like `forward_auth`, any 2xx forwards the request.
	if (!decision.ok) {
		return { status: decision.status, reachedApp: false, body: await decision.text() }
	}
	const forwarded = new Headers(headers)
	const minted = decision.headers.get(PROXY_TOKEN_HEADER)
	if (minted !== null) {
		forwarded.set(PROXY_TOKEN_HEADER, minted)
	}
	const body = request.body === undefined ? null : JSON.stringify(request.body)
	const response = await bootApp(notesApp(new Map())).fetch(
		new Request(`https://${HOST}${request.path}`, { method: request.method, headers: forwarded, body }),
	)
	return { status: response.status, reachedApp: true, body: await response.text() }
}

const SESSION = { Cookie: '__Host-px_session=session', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }
const KEY = { Authorization: 'Bearer px_key', 'Content-Type': 'application/json' }

describe('a contract application deploys to Zerops with its generated gates and schema', () => {
	test('the Fabrika manifest carries both, and the namespace proxy manifest the gates, verbatim', () => {
		expect(manifest.app.schema).toEqual(schemaFromContract(artifact))
		expect(manifest.target.proxy?.gates).toEqual(gatesFromContract(artifact))
		expect(proxyManifest.apps.map(({ id, gates }) => ({ id, gates }))).toEqual([{ id: 'notes@prod', gates: gatesFromContract(artifact) }])
	})

	test('the schema the deploy reconciles is a contract schema IAM accepts', () => {
		expect(appSchemaSchema.parse(manifest.app.schema)).toEqual({ ...schemaFromContract(artifact), contract: true })
	})

	test('an anonymous health check reaches the application', async () => {
		expect(await throughTheProxy({}, { method: 'GET', path: '/healthz' })).toMatchObject({ status: 200, reachedApp: true })
	})

	test('a signed-in person reaches a person procedure', async () => {
		const sent = await throughTheProxy({ session: await minted('user', [inW1('notes.read')]) }, {
			method: 'POST',
			path: '/api/notes.list',
			headers: SESSION,
			body: {},
		})
		expect(sent).toEqual({ status: 200, reachedApp: true, body: JSON.stringify({ result: { items: [] } }) })
	})

	test('a machine key reaches the machine procedure', async () => {
		const sent = await throughTheProxy({ key: await minted('service', [inW1('notes.write')]) }, {
			method: 'POST',
			path: '/machine/importNotes',
			headers: KEY,
			body: { workspaceId: 'w1', titles: ['a', 'b'] },
		})
		expect(sent).toEqual({ status: 200, reachedApp: true, body: JSON.stringify({ result: { imported: 2 } }) })
	})

	test('an invalid key on the machine path stops at the proxy', async () => {
		const sent = await throughTheProxy({}, { method: 'POST', path: '/machine/importNotes', headers: KEY, body: { workspaceId: 'w1', titles: [] } })
		expect(sent).toMatchObject({ status: 401, reachedApp: false })
	})

	test('a session on the machine path passes the coarse gate and the framework refuses the caller kind', async () => {
		const sent = await throughTheProxy({ session: await minted('user', [inW1('notes.write')]) }, {
			method: 'POST',
			path: '/machine/importNotes',
			headers: SESSION,
			body: { workspaceId: 'w1', titles: ['a'] },
		})
		expect(sent).toMatchObject({ status: 403, reachedApp: true })
	})
})
