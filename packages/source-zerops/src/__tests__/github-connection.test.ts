import type { GitHubAppIdentity, GitHubAppInstallation } from '@fabrika/github-app'
import {
	buildZeropsSourceCredentialBundleV2,
	serializeZeropsSourceCredentialBundleV2,
	sha256ZeropsSourceCredentialBundleV2,
	zeropsSourceCredentialEnvV2,
} from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { GitHubConnection, type SourceGitHubClient } from '../github-connection'

const PEM = `-----BEGIN PRIVATE KEY-----
MAMCAQE=
-----END PRIVATE KEY-----
`
const CONNECTION_1 = 'connection-1'
const CONNECTION_2 = 'connection-2'

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
	let configured = 'https://control.example.test/webhooks/github'
	return {
		getAuthenticatedApp: async () => app,
		getWebhookConfig: async () => ({ url: configured, contentType: 'json', insecureSsl: '0' }),
		updateWebhookConfig: async (input) => {
			configured = input.url
			return { url: input.url, contentType: 'json', insecureSsl: '0' }
		},
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

function bundleV2(connectionId: string, appId = '123', privateKeyPem = PEM): string {
	return serializeZeropsSourceCredentialBundleV2(buildZeropsSourceCredentialBundleV2({
		connectionId,
		githubAppId: appId,
		privateKeyPem,
	}))
}

async function slot(connectionId: string, appId = '123'): Promise<{ readonly name: string; readonly credentialBundle: string }> {
	return { name: await zeropsSourceCredentialEnvV2(connectionId), credentialBundle: bundleV2(connectionId, appId) }
}

describe('source GitHub connection startup', () => {
	test('starts anonymous without any credential slot', async () => {
		let creates = 0
		const connection = await GitHubConnection.create({
			createClient: async () => {
				creates++
				return client()
			},
		})
		expect(connection.snapshotV2(CONNECTION_1)).toBeUndefined()
		expect(connection.hasAnySnapshot()).toBe(false)
		expect(await connection.statusV2(CONNECTION_1, new AbortController().signal)).toEqual({
			protocolVersion: 2,
			connectionId: CONNECTION_1,
			state: 'anonymous',
		})
		expect(creates).toBe(0)
	})

	test('loads keyed v2 slots locally without an online identity call', async () => {
		let identityCalls = 0
		const connection = await GitHubConnection.create({
			credentialSlotsV2: [await slot(CONNECTION_1, '124'), await slot(CONNECTION_2, '125')],
			createClient: async (input) => ({
				...client(identity(Number(input.appId))),
				getAuthenticatedApp: async () => {
					identityCalls++
					return identity(Number(input.appId))
				},
			}),
		})
		expect(connection.snapshotV2(CONNECTION_1)?.appId).toBe('124')
		expect(connection.snapshotV2(CONNECTION_2)?.appId).toBe('125')
		expect(connection.snapshotV2('missing')).toBeUndefined()
		expect(identityCalls).toBe(0)
	})

	test('rejects mismatched and duplicate v2 slots without leaking their bundle', async () => {
		const secret = bundleV2(CONNECTION_1)
		for (
			const slots of [
				[{ name: await zeropsSourceCredentialEnvV2(CONNECTION_2), credentialBundle: secret }],
				[
					{ name: await zeropsSourceCredentialEnvV2(CONNECTION_1), credentialBundle: secret },
					{ name: await zeropsSourceCredentialEnvV2(CONNECTION_1), credentialBundle: secret },
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
	test('activates independent v2 connections atomically', async () => {
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
		const first = bundleV2(CONNECTION_1, '124')
		const second = bundleV2(CONNECTION_2, '125')
		const activations = [
			connection.activateV2(CONNECTION_1, first, await sha256ZeropsSourceCredentialBundleV2(first), new AbortController().signal),
			connection.activateV2(CONNECTION_2, second, await sha256ZeropsSourceCredentialBundleV2(second), new AbortController().signal),
		]
		while (verifications < 2) await Bun.sleep(1)
		release.resolve()
		await expect(Promise.all(activations)).resolves.toHaveLength(2)
		expect(connection.snapshotV2(CONNECTION_1)?.appId).toBe('124')
		expect(connection.snapshotV2(CONNECTION_2)?.appId).toBe('125')
	})

	test('binds v2 activation and status to the exact connection id and redacts credentials', async () => {
		const connection = await GitHubConnection.create({ createClient: async () => client() })
		const value = bundleV2(CONNECTION_1)
		const digest = await sha256ZeropsSourceCredentialBundleV2(value)
		await expect(
			connection.activateV2(CONNECTION_2, value, digest, new AbortController().signal),
		).rejects.toMatchObject({ code: 'credentials_invalid', status: 400 })
		const activated = await connection.activateV2(CONNECTION_1, value, digest, new AbortController().signal)
		expect(JSON.stringify(activated)).not.toContain('PRIVATE KEY')
		expect(await connection.statusV2(CONNECTION_1, new AbortController().signal)).toMatchObject({
			protocolVersion: 2,
			state: 'active',
			connectionId: CONNECTION_1,
			credentialSha256: digest,
		})
		expect(await connection.statusV2(CONNECTION_2, new AbortController().signal)).toEqual({
			protocolVersion: 2,
			connectionId: CONNECTION_2,
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
		const value = bundleV2(CONNECTION_1)
		const digest = await sha256ZeropsSourceCredentialBundleV2(value)
		const response = await connection.activateV2(CONNECTION_1, value, digest, new AbortController().signal)
		expect(calls).toEqual(['create:123', 'verify'])
		expect(response).toEqual({
			protocolVersion: 2,
			connectionId: CONNECTION_1,
			credentialVersion: 2,
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
		expect(connection.snapshotV2(CONNECTION_1)?.credentialSha256).toBe(digest)
	})

	test('is idempotent for one digest and rejects replacement with another digest', async () => {
		const connection = await GitHubConnection.create({ createClient: async () => client() })
		const first = bundleV2(CONNECTION_1)
		const firstDigest = await sha256ZeropsSourceCredentialBundleV2(first)
		await connection.activateV2(CONNECTION_1, first, firstDigest, new AbortController().signal)
		await expect(connection.activateV2(CONNECTION_1, first, firstDigest, new AbortController().signal)).resolves.toMatchObject({
			credentialSha256: firstDigest,
		})
		const second = bundleV2(CONNECTION_1, '124')
		const secondDigest = await sha256ZeropsSourceCredentialBundleV2(second)
		await expect(connection.activateV2(CONNECTION_1, second, secondDigest, new AbortController().signal)).rejects.toMatchObject({
			code: 'credentials_conflict',
			status: 409,
		})
		expect(connection.snapshotV2(CONNECTION_1)?.credentialSha256).toBe(firstDigest)
	})

	test('rejects a wrong digest or identity without adding a snapshot', async () => {
		const connection = await GitHubConnection.create({ createClient: async () => client(identity(999)) })
		const value = bundleV2(CONNECTION_1)
		await expect(connection.activateV2(CONNECTION_1, value, 'a'.repeat(64), new AbortController().signal)).rejects.toMatchObject({
			code: 'credentials_invalid',
		})
		expect(connection.snapshotV2(CONNECTION_1)).toBeUndefined()
		await expect(
			connection.activateV2(CONNECTION_1, value, await sha256ZeropsSourceCredentialBundleV2(value), new AbortController().signal),
		).rejects.toMatchObject({ code: 'credentials_invalid' })
		expect(connection.snapshotV2(CONNECTION_1)).toBeUndefined()
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
		const value = bundleV2(CONNECTION_1)
		const controller = new AbortController()
		const activation = connection.activateV2(CONNECTION_1, value, await sha256ZeropsSourceCredentialBundleV2(value), controller.signal)
		await started.promise
		controller.abort()
		await expect(activation).rejects.toMatchObject({ code: 'cancelled', stage: 'credentials' })
		expect(connection.snapshotV2(CONNECTION_1)).toBeUndefined()
	})

	test('lets only one of two different concurrent activations of one connection win', async () => {
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
		const first = bundleV2(CONNECTION_1, '123')
		const second = bundleV2(CONNECTION_1, '124')
		const firstActivation = connection.activateV2(
			CONNECTION_1,
			first,
			await sha256ZeropsSourceCredentialBundleV2(first),
			new AbortController().signal,
		)
		const secondActivation = connection.activateV2(
			CONNECTION_1,
			second,
			await sha256ZeropsSourceCredentialBundleV2(second),
			new AbortController().signal,
		)
		while (verifications < 2) await Bun.sleep(1)
		release.resolve()
		const results = await Promise.allSettled([firstActivation, secondActivation])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
	})

	test('lazily verifies a boot slot and caches only its redacted identity', async () => {
		let calls = 0
		const connection = await GitHubConnection.create({
			credentialSlotsV2: [await slot(CONNECTION_1)],
			createClient: async () => ({
				...client(),
				getAuthenticatedApp: async () => {
					calls++
					return identity()
				},
			}),
		})
		const first = await connection.statusV2(CONNECTION_1, new AbortController().signal)
		const second = await connection.statusV2(CONNECTION_1, new AbortController().signal)
		expect(first.state).toBe('active')
		expect(second.state).toBe('active')
		expect(calls).toBe(1)
		expect(JSON.stringify([first, second])).not.toContain('PRIVATE KEY')
	})

	test('publishes one identity when concurrent status calls verify the same boot slot', async () => {
		const release = Promise.withResolvers<void>()
		let calls = 0
		const connection = await GitHubConnection.create({
			credentialSlotsV2: [await slot(CONNECTION_1)],
			createClient: async () => ({
				...client(),
				getAuthenticatedApp: async () => {
					calls++
					await release.promise
					return identity()
				},
			}),
		})
		const first = connection.statusV2(CONNECTION_1, new AbortController().signal)
		const second = connection.statusV2(CONNECTION_1, new AbortController().signal)
		while (calls < 2) await Bun.sleep(1)
		release.resolve()
		const results = await Promise.all([first, second])
		expect(results.map((result) => result.state)).toEqual(['active', 'active'])
		expect(connection.snapshotV2(CONNECTION_1)?.appId).toBe('123')
	})

	test('configures a structurally verified webhook and verifies installations on the bound slot', async () => {
		const secrets: string[] = []
		const connection = await GitHubConnection.create({
			createClient: async () => {
				let configured = 'https://control.example.test/webhooks/github'
				return {
					...client(),
					getWebhookConfig: async () => ({ url: configured, contentType: 'json', insecureSsl: '0' }),
					updateWebhookConfig: async (input) => {
						secrets.push(input.secret)
						configured = input.url
						return { url: input.url, contentType: 'json', insecureSsl: '0' }
					},
				}
			},
		})
		const value = bundleV2(CONNECTION_1)
		const digest = await sha256ZeropsSourceCredentialBundleV2(value)
		await connection.activateV2(CONNECTION_1, value, digest, new AbortController().signal)
		const webhook = await connection.configureWebhook(
			CONNECTION_1,
			digest,
			'https://control.example.test/webhooks/github/connection-1',
			'must-not-leak',
			new AbortController().signal,
		)
		expect(JSON.stringify(webhook)).not.toContain('must-not-leak')
		expect(secrets).toEqual(['must-not-leak'])
		expect(
			await connection.verifyInstallations(
				CONNECTION_1,
				digest,
				{ kind: 'repositories', repositories: [{ owner: 'contember', name: 'fabrika-platform' }] },
				new AbortController().signal,
			),
		).toMatchObject({
			installation: { status: 'installed', installationId: 42, accountLogin: 'contember', repositorySelection: 'selected' },
		})
	})

	test('rebinds a restarted container so verification and webhook configuration survive a redeploy', async () => {
		// A slot restored from the environment carries the key and NOTHING else — no App identity. It
		// must still serve, because the service runs more than one container and every platform deploy
		// replaces them: the console's `statusV2` can bind one while the operator's next click lands on
		// another.
		const value = bundleV2(CONNECTION_1)
		const digest = await sha256ZeropsSourceCredentialBundleV2(value)
		const secrets: string[] = []
		const restarted = await GitHubConnection.create({
			credentialSlotsV2: [{ name: await zeropsSourceCredentialEnvV2(CONNECTION_1), credentialBundle: value }],
			createClient: async () => {
				let configured = 'https://control.example.test/webhooks/github'
				return {
					...client(),
					getWebhookConfig: async () => ({ url: configured, contentType: 'json', insecureSsl: '0' }),
					updateWebhookConfig: async (input) => {
						secrets.push(input.secret)
						configured = input.url
						return { url: input.url, contentType: 'json', insecureSsl: '0' }
					},
				}
			},
		})
		expect(
			await restarted.verifyInstallations(
				CONNECTION_1,
				digest,
				{ kind: 'organization', organization: 'contember' },
				new AbortController().signal,
			),
		).toMatchObject({ installation: { status: 'installed', accountLogin: 'contember' } })
		expect(
			await restarted.configureWebhook(
				CONNECTION_1,
				digest,
				'https://control.example.test/webhooks/github/connection-1',
				'must-not-leak',
				new AbortController().signal,
			),
		).toBeDefined()
		expect(secrets).toEqual(['must-not-leak'])
		// The binding is to ONE connection: a second id may not borrow a credential it does not own.
		await expect(
			restarted.verifyInstallations(CONNECTION_2, digest, { kind: 'organization', organization: 'contember' }, new AbortController().signal),
		).rejects.toMatchObject({ code: 'credentials_conflict' })
		// Nor may the right connection act through a digest that is not its slot's.
		await expect(
			restarted.configureWebhook(
				CONNECTION_1,
				'f'.repeat(64),
				'https://control.example.test/webhooks/github/connection-1',
				'must-not-leak',
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: 'credentials_conflict' })
	})

	test('selects the exact keyed App when several slots share the container', async () => {
		// The normal live shape: one container holds every connected organization's slot. A keyed
		// operation must answer through its OWN App, never a neighbouring one.
		const keyed = bundleV2(CONNECTION_2, '456')
		const keyedDigest = await sha256ZeropsSourceCredentialBundleV2(keyed)
		const restarted = await GitHubConnection.create({
			credentialSlotsV2: [
				await slot(CONNECTION_1, '123'),
				{ name: await zeropsSourceCredentialEnvV2(CONNECTION_2), credentialBundle: keyed },
			],
			createClient: async (input) => client(identity(Number(input.appId))),
		})
		expect(await restarted.statusV2(CONNECTION_2, new AbortController().signal)).toMatchObject({ githubApp: { id: 456 } })
		expect(await restarted.statusV2(CONNECTION_1, new AbortController().signal)).toMatchObject({ githubApp: { id: 123 } })
		await expect(
			restarted.configureWebhook(
				CONNECTION_2,
				await sha256ZeropsSourceCredentialBundleV2(bundleV2(CONNECTION_1, '123')),
				'https://control.example.test/webhooks/github/connection-2',
				'must-not-leak',
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: 'credentials_conflict' })
		expect(await restarted.statusV2(CONNECTION_2, new AbortController().signal)).toMatchObject({ credentialSha256: keyedDigest })
	})

	test('rejects repository grants that resolve to different installations or accounts', async () => {
		let call = 0
		const connection = await GitHubConnection.create({
			createClient: async () => ({
				...client(),
				resolveRepositoryInstallation: async () => call++ === 0 ? installation(42) : installation(43, 'attacker'),
			}),
		})
		const value = bundleV2(CONNECTION_1)
		const digest = await sha256ZeropsSourceCredentialBundleV2(value)
		await connection.activateV2(CONNECTION_1, value, digest, new AbortController().signal)
		await expect(connection.verifyInstallations(
			CONNECTION_1,
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
			CONNECTION_1,
			'a'.repeat(64),
			{ kind: 'organization', organization: 'contember' },
			new AbortController().signal,
		)).rejects.toMatchObject({ code: 'credentials_conflict' })
		expect(calls).toBe(0)
	})

	test('preserves cancellation during webhook mutation without replacing the bound slot', async () => {
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
		const value = bundleV2(CONNECTION_1)
		const digest = await sha256ZeropsSourceCredentialBundleV2(value)
		await connection.activateV2(CONNECTION_1, value, digest, new AbortController().signal)
		const before = connection.snapshotV2(CONNECTION_1)
		const controller = new AbortController()
		const operation = connection.configureWebhook(
			CONNECTION_1,
			digest,
			'https://control.example.test/webhooks/github/connection-1',
			'must-not-leak',
			controller.signal,
		)
		await started.promise
		controller.abort('private reason')
		await expect(operation).rejects.toMatchObject({ code: 'cancelled', stage: 'credentials' })
		expect(connection.snapshotV2(CONNECTION_1)).toBe(before)
	})
})
