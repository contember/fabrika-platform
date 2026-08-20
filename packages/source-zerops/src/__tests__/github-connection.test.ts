import type { GitHubAppIdentity, GitHubAppInstallation } from '@fabrika/github-app'
import {
	buildZeropsSourceCredentialBundle,
	buildZeropsSourceCredentialBundleV2,
	serializeZeropsSourceCredentialBundle,
	serializeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundleV2,
	zeropsSourceCredentialEnvV2,
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
		getWebhookConfig: async () => ({ url: 'https://control.example.test/webhooks/github', contentType: 'json', insecureSsl: '0' }),
		updateWebhookConfig: async (input) => ({ url: input.url, contentType: 'json', insecureSsl: '0' }),
		resolveOrganizationInstallation: async () => installation(41),
		resolveRepositoryInstallation: async () => installation(42),
		resolveOrganizationInstallationId: async () => 41,
		resolveInstallationId: async () => 42,
		mintRepositoryToken: async () => ({ token: 'token', expiresAt: Date.now() + 60_000 }),
	}
}

const installation = (id: number, accountLogin = 'contember'): GitHubAppInstallation => ({
	id,
	accountLogin,
	accountType: 'Organization',
	repositorySelection: 'selected',
})

function bundle(appId = '123', privateKeyPem = PEM): string {
	return serializeZeropsSourceCredentialBundle(buildZeropsSourceCredentialBundle({ githubAppId: appId, privateKeyPem }))
}

function bundleV2(connectionId: string, appId = '123', privateKeyPem = PEM): string {
	return serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
		connectionId,
		githubAppId: appId,
		privateKeyPem,
	}))
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

	test('loads keyed v2 slots without replacing or exposing the legacy default', async () => {
		const first = bundleV2('connection-1', '124')
		const second = bundleV2('connection-2', '125')
		const connection = await GitHubConnection.create({
			credentialBundle: bundle('123'),
			credentialSlotsV2: [
				{ name: await zeropsSourceCredentialEnvV2('connection-1'), credentialBundle: first },
				{ name: await zeropsSourceCredentialEnvV2('connection-2'), credentialBundle: second },
			],
			createClient: async (input) => client(identity(Number(input.appId))),
		})
		expect(connection.snapshot()?.appId).toBe('123')
		expect(connection.snapshotV2('connection-1')?.appId).toBe('124')
		expect(connection.snapshotV2('connection-2')?.appId).toBe('125')
		expect(connection.snapshotV2('missing')).toBeUndefined()
	})

	test('rejects mismatched and duplicate v2 slots without leaking their bundle', async () => {
		const secret = bundleV2('connection-1')
		for (
			const slots of [
				[{ name: await zeropsSourceCredentialEnvV2('connection-2'), credentialBundle: secret }],
				[
					{ name: await zeropsSourceCredentialEnvV2('connection-1'), credentialBundle: secret },
					{ name: await zeropsSourceCredentialEnvV2('connection-1'), credentialBundle: secret },
				],
			]
		) {
			const raised = await GitHubConnection.create({ credentialSlotsV2: slots, createClient: async () => client() }).then(
				() => undefined,
				(error: unknown) => error,
			)
			expect(raised).toBeInstanceOf(Error)
			expect(raised instanceof Error ? raised.message : secret).toBe('GitHub App configuration is invalid')
			expect(raised instanceof Error ? raised.message : '').not.toContain(secret)
		}
	})
})

describe('source GitHub connection activation', () => {
	test('activates independent v2 connections atomically while leaving the v1 default untouched', async () => {
		const release = Promise.withResolvers<void>()
		let verifications = 0
		const connection = await GitHubConnection.create({
			credentialBundle: bundle(),
			createClient: async (input) => ({
				...client(identity(Number(input.appId))),
				getAuthenticatedApp: async () => {
					verifications++
					await release.promise
					return identity(Number(input.appId))
				},
			}),
		})
		const first = bundleV2('connection-1', '124')
		const second = bundleV2('connection-2', '125')
		const activations = [
			connection.activateV2('connection-1', first, await sha256ZeropsSourceCredentialBundleV2(first), new AbortController().signal),
			connection.activateV2('connection-2', second, await sha256ZeropsSourceCredentialBundleV2(second), new AbortController().signal),
		]
		while (verifications < 2) await Bun.sleep(1)
		release.resolve()
		await expect(Promise.all(activations)).resolves.toHaveLength(2)
		expect(connection.snapshot()?.appId).toBe('123')
		expect(connection.snapshotV2('connection-1')?.appId).toBe('124')
		expect(connection.snapshotV2('connection-2')?.appId).toBe('125')
	})

	test('binds v2 activation and status to the exact connection id and redacts credentials', async () => {
		const connection = await GitHubConnection.create({ createClient: async () => client() })
		const value = bundleV2('connection-1')
		const digest = await sha256ZeropsSourceCredentialBundleV2(value)
		await expect(
			connection.activateV2('connection-2', value, digest, new AbortController().signal),
		).rejects.toMatchObject({ code: 'credentials_invalid', status: 400 })
		const activated = await connection.activateV2('connection-1', value, digest, new AbortController().signal)
		expect(JSON.stringify(activated)).not.toContain('PRIVATE KEY')
		expect(await connection.statusV2('connection-1', new AbortController().signal)).toMatchObject({
			protocolVersion: 2,
			state: 'active',
			connectionId: 'connection-1',
			credentialSha256: digest,
		})
		expect(await connection.statusV2('connection-2', new AbortController().signal)).toEqual({
			protocolVersion: 2,
			connectionId: 'connection-2',
			state: 'anonymous',
		})
	})
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
		const second = await connection.status('connection-1', new AbortController().signal)
		expect(first.state).toBe('active')
		expect(second.state).toBe('active')
		expect(calls).toBe(1)
		expect(JSON.stringify([first, second])).not.toContain('PRIVATE KEY')
	})

	test('binds only one connection id when concurrent status calls verify one boot snapshot', async () => {
		const release = Promise.withResolvers<void>()
		let calls = 0
		const connection = await GitHubConnection.create({
			credentialBundle: bundle(),
			createClient: async () => ({
				...client(),
				getAuthenticatedApp: async () => {
					calls++
					await release.promise
					return identity()
				},
			}),
		})
		const first = connection.status('connection-1', new AbortController().signal)
		const second = connection.status('connection-2', new AbortController().signal)
		while (calls < 2) await Bun.sleep(1)
		release.resolve()
		const results = await Promise.allSettled([first, second])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
		expect(results.find((result) => result.status === 'rejected')).toMatchObject({
			status: 'rejected',
			reason: { code: 'credentials_conflict' },
		})
	})

	test('configures a structurally verified webhook and verifies installations on the bound active snapshot', async () => {
		const secrets: string[] = []
		const connection = await GitHubConnection.create({
			createClient: async () => ({
				...client(),
				updateWebhookConfig: async (input) => {
					secrets.push(input.secret)
					return { url: input.url, contentType: 'json', insecureSsl: '0' }
				},
			}),
		})
		const value = bundle()
		const digest = await sha256ZeropsSourceCredentialBundle(value)
		await connection.activate('connection-1', value, digest, new AbortController().signal)
		const webhook = await connection.configureWebhook(
			'connection-1',
			digest,
			'https://control.example.test/webhooks/github',
			'must-not-leak',
			new AbortController().signal,
		)
		expect(JSON.stringify(webhook)).not.toContain('must-not-leak')
		expect(secrets).toEqual(['must-not-leak'])
		expect(
			await connection.verifyInstallations(
				'connection-1',
				digest,
				{ kind: 'repositories', repositories: [{ owner: 'contember', name: 'fabrika-platform' }] },
				new AbortController().signal,
			),
		).toMatchObject({
			installation: { status: 'installed', installationId: 42, accountLogin: 'contember', repositorySelection: 'selected' },
		})
	})

	test('rebinds a restarted container so verification and webhook configuration survive a redeploy', async () => {
		// A container that booted from `GITHUB_APP_CREDENTIALS` has the key and NOTHING else: no
		// connection id, no App identity. It must still serve, because the service runs more than one
		// container and every platform deploy replaces them — the console's `status` call can bind one
		// while the operator's next click lands on another.
		const value = bundle()
		const digest = await sha256ZeropsSourceCredentialBundle(value)
		const secrets: string[] = []
		const restarted = await GitHubConnection.create({
			credentialBundle: value,
			createClient: async () => ({
				...client(),
				updateWebhookConfig: async (input) => {
					secrets.push(input.secret)
					return { url: input.url, contentType: 'json', insecureSsl: '0' }
				},
			}),
		})
		expect(
			await restarted.verifyInstallations(
				'connection-1',
				digest,
				{ kind: 'organization', organization: 'contember' },
				new AbortController().signal,
			),
		).toMatchObject({ installation: { status: 'installed', accountLogin: 'contember' } })
		expect(
			await restarted.configureWebhook(
				'connection-1',
				digest,
				'https://control.example.test/webhooks/github',
				'must-not-leak',
				new AbortController().signal,
			),
		).toBeDefined()
		expect(secrets).toEqual(['must-not-leak'])
		// The binding is to ONE connection: a second id may not borrow the credential it did not activate.
		await expect(
			restarted.verifyInstallations('connection-2', digest, { kind: 'organization', organization: 'contember' }, new AbortController().signal),
		).rejects.toMatchObject({ code: 'credentials_conflict' })
	})

	test('rejects repository grants that resolve to different installations or accounts', async () => {
		let call = 0
		const connection = await GitHubConnection.create({
			createClient: async () => ({
				...client(),
				resolveRepositoryInstallation: async () => call++ === 0 ? installation(42) : installation(43, 'attacker'),
			}),
		})
		const value = bundle()
		const digest = await sha256ZeropsSourceCredentialBundle(value)
		await connection.activate('connection-1', value, digest, new AbortController().signal)
		await expect(connection.verifyInstallations(
			'connection-1',
			digest,
			{
				kind: 'repositories',
				repositories: [{ owner: 'contember', name: 'one' }, { owner: 'contember', name: 'two' }],
			},
			new AbortController().signal,
		)).rejects.toMatchObject({ code: 'credentials_invalid', status: 422 })
	})

	test('rejects inactive or mismatched connection administration without calling GitHub', async () => {
		let calls = 0
		const connection = await GitHubConnection.create({
			createClient: async () => ({
				...client(),
				updateWebhookConfig: async () => {
					calls++
					return { url: 'https://control.example.test/webhooks/github', contentType: 'json', insecureSsl: '0' }
				},
			}),
		})
		await expect(connection.verifyInstallations(
			'connection-1',
			'a'.repeat(64),
			{ kind: 'organization', organization: 'contember' },
			new AbortController().signal,
		)).rejects.toMatchObject({ code: 'credentials_conflict' })
		expect(calls).toBe(0)
	})

	test('preserves cancellation during webhook mutation without replacing the active snapshot', async () => {
		const started = Promise.withResolvers<void>()
		const connection = await GitHubConnection.create({
			createClient: async () => ({
				...client(),
				updateWebhookConfig: async () => {
					started.resolve()
					return new Promise(() => {})
				},
			}),
		})
		const value = bundle()
		const digest = await sha256ZeropsSourceCredentialBundle(value)
		await connection.activate('connection-1', value, digest, new AbortController().signal)
		const before = connection.snapshot()
		const controller = new AbortController()
		const operation = connection.configureWebhook(
			'connection-1',
			digest,
			'https://control.example.test/webhooks/github',
			'must-not-leak',
			controller.signal,
		)
		await started.promise
		controller.abort('private reason')
		await expect(operation).rejects.toMatchObject({ code: 'cancelled', stage: 'credentials' })
		expect(connection.snapshot()).toBe(before)
	})
})
