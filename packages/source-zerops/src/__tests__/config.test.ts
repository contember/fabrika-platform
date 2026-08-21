import {
	buildZeropsSourceCredentialBundleV2,
	buildZeropsSourceUploadRequest,
	serializeZeropsSourceCredentialBundleV2,
	zeropsSourceCredentialEnvV2,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { createSourceRuntime } from '../config'

const rpcKey = 'source-rpc-key-that-is-at-least-32-characters'

describe('source runtime configuration', () => {
	test('boots the anonymous public source path without GitHub App credentials', async () => {
		const runtime = await createSourceRuntime({
			env: { FABRIKA_SOURCE_RPC_KEY: rpcKey, PORT: '3000' },
		})
		expect(runtime.port).toBe(3000)
		expect(runtime.githubEnabled).toBe(false)
	})

	test('ignores an unkeyed or split GitHub App environment value entirely', async () => {
		const privateKey = await privateKeyPem()
		const runtime = await createSourceRuntime({
			env: {
				FABRIKA_SOURCE_RPC_KEY: rpcKey,
				GITHUB_APP_CREDENTIALS: `{"version":1,"githubAppId":"123","privateKeyPem":${JSON.stringify(privateKey)}}`,
				GITHUB_APP_ID: '123',
				GITHUB_APP_PRIVATE_KEY: privateKey,
			},
		})
		expect(runtime.githubEnabled).toBe(false)
	})

	test('discovers every keyed v2 credential slot and reports GitHub mode from them alone', async () => {
		const privateKey = await privateKeyPem()
		const env: Record<string, string> = { FABRIKA_SOURCE_RPC_KEY: rpcKey }
		for (
			const entry of [
				{ connectionId: 'connection-1', appId: '123' },
				{ connectionId: 'connection-2', appId: '124' },
				{ connectionId: 'connection-3', appId: '125' },
			]
		) {
			const { connectionId, appId } = entry
			env[await zeropsSourceCredentialEnvV2(connectionId)] = serializeZeropsSourceCredentialBundleV2(
				buildZeropsSourceCredentialBundleV2({ connectionId, githubAppId: appId, privateKeyPem: privateKey }),
			)
		}
		const runtime = await createSourceRuntime({ env })
		expect(runtime.githubEnabled).toBe(true)
	})

	test('blocks boot on an invalid keyed slot without echoing credential material', async () => {
		const secret = 'must-not-leak'
		const name = await zeropsSourceCredentialEnvV2('connection-1')
		const raised = await createSourceRuntime({
			env: { FABRIKA_SOURCE_RPC_KEY: rpcKey, [name]: secret },
		}).then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(raised).toBeInstanceOf(Error)
		expect(raised instanceof Error ? raised.message : secret).toBe('GitHub App configuration is invalid')
		expect(raised instanceof Error ? raised.message : '').not.toContain(secret)
	})

	test('ignores arbitrary API-host environment input and sends the App JWT only to api.github.com', async () => {
		const requests: string[] = []
		const connectionId = 'connection-1'
		const runtime = await createSourceRuntime({
			env: {
				FABRIKA_SOURCE_RPC_KEY: rpcKey,
				[await zeropsSourceCredentialEnvV2(connectionId)]: serializeZeropsSourceCredentialBundleV2(
					buildZeropsSourceCredentialBundleV2({ connectionId, githubAppId: '123', privateKeyPem: await privateKeyPem() }),
				),
				GITHUB_API_BASE_URL: 'https://attacker.test/api/v3',
			},
			githubFetch: (input, init) => {
				requests.push(input instanceof Request ? input.url : input.toString())
				expect(new Headers(init?.headers).get('authorization')).toStartWith('Bearer ')
				return Promise.resolve(Response.json({ token: 'ghs_must-not-leak', expires_at: '2099-01-01T00:00:00Z' }))
			},
			metadataFetch: async () => new Response(null, { status: 500 }),
		})
		const response = await runtime.service.fetch(
			new Request('http://source.test/v2/source/resolve', {
				method: 'POST',
				headers: { authorization: `Bearer ${rpcKey}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					protocolVersion: 2,
					runId: 'run-1',
					repository: { owner: 'contember', name: 'fabrika-platform' },
					requestedRef: 'refs/heads/main',
					privateBinding: { connectionId, installationId: 42 },
					descriptorSha256: 'b'.repeat(64),
				}),
			}),
		)

		expect(response.status).toBe(502)
		expect(requests).toEqual(['https://api.github.com/app/installations/42/access_tokens'])
		expect(requests.join('\n')).not.toContain('attacker.test')
	})

	test('sends the assembled runtime to the fixed GitHub tarball origin', async () => {
		const requests: string[] = []
		const runtime = await createSourceRuntime({
			env: { FABRIKA_SOURCE_RPC_KEY: rpcKey, GITHUB_API_BASE_URL: 'https://attacker.test/api/v3' },
			metadataFetch: async (input) =>
				input.toString().includes('/commits/')
					? Response.json({ sha: 'a'.repeat(40) })
					: new Response('zerops:\n  - setup: app\n'),
			downloadFetch: async (input) => {
				requests.push(input)
				return new Response(null, { status: 500 })
			},
		})
		const response = await runtime.service.fetch(
			new Request('http://source.test/v1/source/upload', {
				method: 'POST',
				headers: { authorization: `Bearer ${rpcKey}`, 'content-type': 'application/json' },
				body: JSON.stringify(buildZeropsSourceUploadRequest({
					runId: 'run-1',
					appVersionId: 'version-1',
					repository: { owner: 'contember', name: 'fabrika-platform' },
					commitSha: 'a'.repeat(40),
					uploadUrl: 'https://proxy.app-prg1.zerops.io/api/rest/object-storage/upload?signature=private',
					descriptor: { path: 'zerops.yaml', sha256: 'b'.repeat(64) },
					signal: new AbortController().signal,
				})),
			}),
		)

		expect(response.status).toBe(502)
		expect(requests).toEqual(['https://api.github.com/repos/contember/fabrika-platform/tarball/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'])
		expect(requests.join('\n')).not.toContain('attacker.test')
	})

	test('fails boot on malformed DER without echoing key material', async () => {
		const secret = 'must-not-leak'
		const connectionId = 'connection-1'
		let message = ''
		try {
			await createSourceRuntime({
				env: {
					FABRIKA_SOURCE_RPC_KEY: rpcKey,
					[await zeropsSourceCredentialEnvV2(connectionId)]: JSON.stringify({
						version: 2,
						connectionId,
						githubAppId: '123',
						privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${btoa(secret)}\n-----END PRIVATE KEY-----\n`,
					}),
				},
			})
		} catch (error) {
			message = error instanceof Error ? error.message : String(error)
		}
		expect(message).toBe('GitHub App configuration is invalid')
		expect(message).not.toContain(secret)
	})

	test.each([
		{},
		{ FABRIKA_SOURCE_RPC_KEY: 'short' },
		{ FABRIKA_SOURCE_RPC_KEY: rpcKey, PORT: '0' },
		{ FABRIKA_SOURCE_RPC_KEY: rpcKey, PORT: '65536' },
	])('rejects invalid required runtime configuration', async (env) => {
		await expect(createSourceRuntime({ env })).rejects.toThrow()
	})
})

async function privateKeyPem(): Promise<string> {
	const pair = await crypto.subtle.generateKey(
		{
			name: 'RSASSA-PKCS1-v1_5',
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: 'SHA-256',
		},
		true,
		['sign', 'verify'],
	)
	const der = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
	const body = Buffer.from(der)
		.toString('base64')
		.match(/.{1,64}/g)
		?.join('\n')
	if (body === undefined) throw new Error('test key export failed')
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`
}
