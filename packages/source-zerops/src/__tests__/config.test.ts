import {
	buildZeropsSourceCredentialBundle,
	buildZeropsSourceResolveInstallationRequest,
	serializeZeropsSourceCredentialBundle,
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

	test.each([
		{ FABRIKA_SOURCE_RPC_KEY: rpcKey, GITHUB_APP_ID: '123' },
		{ FABRIKA_SOURCE_RPC_KEY: rpcKey, GITHUB_APP_PRIVATE_KEY: 'private-key' },
	])('rejects a partial GitHub App configuration', async (env) => {
		await expect(createSourceRuntime({ env })).rejects.toThrow(
			'GitHub App configuration is incomplete',
		)
	})

	test('imports a complete RSA key before reporting GitHub mode enabled', async () => {
		const runtime = await createSourceRuntime({
			env: {
				FABRIKA_SOURCE_RPC_KEY: rpcKey,
				GITHUB_APP_ID: '123',
				GITHUB_APP_PRIVATE_KEY: await privateKeyPem(),
			},
		})
		expect(runtime.githubEnabled).toBe(true)
	})

	test('boots the canonical atomic credential bundle and accepts matching legacy compatibility fields', async () => {
		const privateKey = await privateKeyPem()
		const credentials = serializeZeropsSourceCredentialBundle(buildZeropsSourceCredentialBundle({
			githubAppId: '123',
			privateKeyPem: privateKey,
		}))
		for (
			const env of [
				{ FABRIKA_SOURCE_RPC_KEY: rpcKey, GITHUB_APP_CREDENTIALS: credentials },
				{
					FABRIKA_SOURCE_RPC_KEY: rpcKey,
					GITHUB_APP_CREDENTIALS: credentials,
					GITHUB_APP_ID: '123',
					GITHUB_APP_PRIVATE_KEY: privateKey,
				},
			]
		) {
			const runtime = await createSourceRuntime({ env })
			expect(runtime.githubEnabled).toBe(true)
		}
	})

	test('rejects atomic and legacy credentials that disagree', async () => {
		const privateKey = await privateKeyPem()
		const credentials = serializeZeropsSourceCredentialBundle(buildZeropsSourceCredentialBundle({
			githubAppId: '123',
			privateKeyPem: privateKey,
		}))
		await expect(createSourceRuntime({
			env: {
				FABRIKA_SOURCE_RPC_KEY: rpcKey,
				GITHUB_APP_CREDENTIALS: credentials,
				GITHUB_APP_ID: '124',
				GITHUB_APP_PRIVATE_KEY: privateKey,
			},
		})).rejects.toThrow('configuration conflicts')
	})

	test('ignores arbitrary API-host environment input and sends the App JWT only to api.github.com', async () => {
		const requests: string[] = []
		const runtime = await createSourceRuntime({
			env: {
				FABRIKA_SOURCE_RPC_KEY: rpcKey,
				GITHUB_APP_ID: '123',
				GITHUB_APP_PRIVATE_KEY: await privateKeyPem(),
				GITHUB_API_BASE_URL: 'https://attacker.test/api/v3',
			},
			githubFetch: (input, init) => {
				requests.push(input instanceof Request ? input.url : input.toString())
				expect(new Headers(init?.headers).get('authorization')).toStartWith('Bearer ')
				return Promise.resolve(Response.json({
					id: 42,
					app_id: 123,
					target_type: 'Organization',
					account: { login: 'contember', type: 'Organization' },
				}))
			},
		})
		const response = await runtime.service.fetch(
			new Request('http://source.test/v1/installations/resolve', {
				method: 'POST',
				headers: { authorization: `Bearer ${rpcKey}`, 'content-type': 'application/json' },
				body: JSON.stringify(buildZeropsSourceResolveInstallationRequest('github.com/contember/fabrika-platform')),
			}),
		)

		expect(response.status).toBe(200)
		expect(requests).toEqual(['https://api.github.com/repos/contember/fabrika-platform/installation'])
		expect(requests.join('\n')).not.toContain('attacker.test')
	})

	test('fails boot on malformed DER without echoing key material', async () => {
		const secret = 'must-not-leak'
		let message = ''
		try {
			await createSourceRuntime({
				env: {
					FABRIKA_SOURCE_RPC_KEY: rpcKey,
					GITHUB_APP_ID: '123',
					GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${btoa(secret)}\n-----END PRIVATE KEY-----`,
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
