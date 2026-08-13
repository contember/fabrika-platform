import type { GitHubAppIdentity } from '@fabrika/github-app'
import {
	buildZeropsSourceCredentialBundle,
	serializeZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundle,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { GitHubConnection, type SourceGitHubClient } from '../github-connection'

const PEM = `-----BEGIN PRIVATE KEY-----
MAMCAQE=
-----END PRIVATE KEY-----
`

const identity = (id = 123): GitHubAppIdentity => ({
	id,
	slug: 'fabrika-test',
	htmlUrl: 'https://github.com/apps/fabrika-test',
	public: false,
	owner: { login: 'contember', type: 'Organization' },
	permissions: { contents: 'read' },
	events: ['push'],
})

function client(app = identity()): SourceGitHubClient {
	return {
		getAuthenticatedApp: async () => app,
		resolveInstallationId: async () => 42,
		mintRepositoryToken: async () => ({ token: 'token', expiresAt: Date.now() + 60_000 }),
	}
}

function bundle(appId = '123', privateKeyPem = PEM): string {
	return serializeZeropsSourceCredentialBundle(buildZeropsSourceCredentialBundle({ githubAppId: appId, privateKeyPem }))
}

describe('source GitHub connection startup', () => {
	test('starts anonymous without atomic or legacy credentials', async () => {
		let creates = 0
		const connection = await GitHubConnection.create({
			createClient: async () => {
				creates++
				return client()
			},
		})
		expect(connection.snapshot()).toBeUndefined()
		expect(await connection.status('connection-1', new AbortController().signal)).toEqual({
			protocolVersion: 1,
			connectionId: 'connection-1',
			state: 'anonymous',
		})
		expect(creates).toBe(0)
	})

	test('locally imports canonical and legacy credentials without an online identity call', async () => {
		for (
			const options of [
				{ credentialBundle: bundle() },
				{ legacyAppId: '123', legacyPrivateKeyPem: PEM },
				{ credentialBundle: bundle(), legacyAppId: '123', legacyPrivateKeyPem: PEM },
			]
		) {
			let identityCalls = 0
			const connection = await GitHubConnection.create({
				...options,
				createClient: async () => ({
					...client(),
					getAuthenticatedApp: async () => {
						identityCalls++
						return identity()
					},
				}),
			})
			expect(connection.snapshot()?.appId).toBe('123')
			expect(identityCalls).toBe(0)
		}
	})

	test.each([
		{ legacyAppId: '123' },
		{ legacyPrivateKeyPem: PEM },
		{ credentialBundle: bundle('123'), legacyAppId: '124', legacyPrivateKeyPem: PEM },
	])('rejects partial or conflicting startup state without leaking credentials %#', async (options) => {
		const raised = await GitHubConnection.create({ ...options, createClient: async () => client() }).then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(raised).toBeInstanceOf(Error)
		expect(raised instanceof Error ? raised.message : PEM).not.toContain(PEM)
	})
})

describe('source GitHub connection activation', () => {
	test('imports and verifies before one atomic swap, then returns only bound identity and digest', async () => {
		const calls: string[] = []
		const connection = await GitHubConnection.create({
			createClient: async (input) => {
				calls.push(`create:${input.appId}`)
				return {
					...client(),
					getAuthenticatedApp: async () => {
						calls.push('verify')
						return identity()
					},
				}
			},
		})
		const value = bundle()
		const digest = await sha256ZeropsSourceCredentialBundle(value)
		const response = await connection.activate('connection-1', value, digest, new AbortController().signal)
		expect(calls).toEqual(['create:123', 'verify'])
		expect(response).toEqual({
			protocolVersion: 1,
			connectionId: 'connection-1',
			credentialVersion: 1,
			credentialSha256: digest,
			githubApp: {
				id: 123,
				slug: 'fabrika-test',
				htmlUrl: 'https://github.com/apps/fabrika-test',
				public: false,
				owner: { login: 'contember', type: 'Organization' },
				permissions: { contents: 'read' },
				events: ['push'],
			},
		})
		expect(JSON.stringify(response)).not.toContain('PRIVATE KEY')
		expect(connection.snapshot()?.credentialSha256).toBe(digest)
	})

	test('is idempotent for one digest and rejects replacement with another digest', async () => {
		const connection = await GitHubConnection.create({ createClient: async () => client() })
		const first = bundle()
		const firstDigest = await sha256ZeropsSourceCredentialBundle(first)
		await connection.activate('connection-1', first, firstDigest, new AbortController().signal)
		await expect(connection.activate('connection-1', first, firstDigest, new AbortController().signal)).resolves.toMatchObject({
			credentialSha256: firstDigest,
		})
		const second = bundle('124')
		const secondDigest = await sha256ZeropsSourceCredentialBundle(second)
		await expect(connection.activate('connection-1', second, secondDigest, new AbortController().signal)).rejects.toMatchObject({
			code: 'credentials_conflict',
			status: 409,
		})
		expect(connection.snapshot()?.credentialSha256).toBe(firstDigest)
	})

	test('rejects a wrong digest or identity without changing the active snapshot', async () => {
		const connection = await GitHubConnection.create({ createClient: async () => client(identity(999)) })
		const value = bundle()
		await expect(connection.activate('connection-1', value, 'a'.repeat(64), new AbortController().signal)).rejects.toMatchObject({
			code: 'credentials_invalid',
		})
		expect(connection.snapshot()).toBeUndefined()
		await expect(
			connection.activate('connection-1', value, await sha256ZeropsSourceCredentialBundle(value), new AbortController().signal),
		).rejects.toMatchObject({ code: 'credentials_invalid' })
		expect(connection.snapshot()).toBeUndefined()
	})

	test('preserves caller cancellation and does not swap an in-flight candidate', async () => {
		const started = Promise.withResolvers<void>()
		const connection = await GitHubConnection.create({
			createClient: async () => ({
				...client(),
				getAuthenticatedApp: async (signal) => {
					started.resolve()
					await new Promise<void>((_resolve, reject) => {
						const abort = (): void => reject(new DOMException('secret reason', 'AbortError'))
						if (signal?.aborted === true) abort()
						else signal?.addEventListener('abort', abort, { once: true })
					})
					return identity()
				},
			}),
		})
		const value = bundle()
		const controller = new AbortController()
		const activation = connection.activate('connection-1', value, await sha256ZeropsSourceCredentialBundle(value), controller.signal)
		await started.promise
		controller.abort()
		await expect(activation).rejects.toMatchObject({ code: 'cancelled', stage: 'credentials' })
		expect(connection.snapshot()).toBeUndefined()
	})

	test('lets only one of two different concurrent activations win', async () => {
		const release = Promise.withResolvers<void>()
		let verifications = 0
		const connection = await GitHubConnection.create({
			createClient: async (input) => ({
				...client(identity(Number(input.appId))),
				getAuthenticatedApp: async () => {
					verifications++
					await release.promise
					return identity(Number(input.appId))
				},
			}),
		})
		const first = bundle('123')
		const second = bundle('124')
		const firstActivation = connection.activate('connection-1', first, await sha256ZeropsSourceCredentialBundle(first), new AbortController().signal)
		const secondActivation = connection.activate('connection-2', second, await sha256ZeropsSourceCredentialBundle(second), new AbortController().signal)
		while (verifications < 2) await Bun.sleep(1)
		release.resolve()
		const results = await Promise.allSettled([firstActivation, secondActivation])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
	})

	test('lazily verifies a boot client and caches only its redacted identity', async () => {
		let calls = 0
		const connection = await GitHubConnection.create({
			credentialBundle: bundle(),
			createClient: async () => ({
				...client(),
				getAuthenticatedApp: async () => {
					calls++
					return identity()
				},
			}),
		})
		const first = await connection.status('connection-1', new AbortController().signal)
		const second = await connection.status('connection-2', new AbortController().signal)
		expect(first.state).toBe('active')
		expect(second.state).toBe('active')
		expect(calls).toBe(1)
		expect(JSON.stringify([first, second])).not.toContain('PRIVATE KEY')
	})
})
