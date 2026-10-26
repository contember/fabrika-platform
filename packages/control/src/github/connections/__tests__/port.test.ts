import { type GitHubAppIdentity, type GitHubAppInstallation, type GitHubAppWebhookConfig, GitHubRateLimitError } from '@fabrika/github-app'
import { describe, expect, test } from 'bun:test'
import { createHarness } from '../../../__tests__/helpers/harness'
import { Vault } from '../../../vault'
import { encodeGitHubAppCredential, type GitHubAppCredential, type SourceGitHubClient } from '../credentials'
import { createSourceConnections, type SourceConnectionPort } from '../port'
import { githubAppCredentialSecretLabel } from '../secrets'

const PEM = '-----BEGIN PRIVATE KEY-----\nMAMCAQE=\n-----END PRIVATE KEY-----\n'
const WEBHOOK_URL = 'https://control.example.test/webhooks/github/connection-1'

function testKey(): string {
	let binary = ''
	for (let index = 0; index < 32; index++) binary += String.fromCharCode(index + 1)
	return btoa(binary)
}

const identity = (overrides: Partial<GitHubAppIdentity> = {}): GitHubAppIdentity => ({
	id: 123,
	slug: 'fabrika-test',
	htmlUrl: 'https://github.com/apps/fabrika-test',
	public: false,
	owner: { login: 'contember', type: 'Organization' },
	permissions: { contents: 'read' },
	events: ['push'],
	...overrides,
})

const installation = (id: number, accountLogin = 'contember'): GitHubAppInstallation => ({
	id,
	accountLogin,
	accountType: 'Organization',
	repositorySelection: 'selected',
})

function client(overrides: Partial<SourceGitHubClient> = {}): SourceGitHubClient {
	let configured = 'https://control.example.test/webhooks/github'
	return {
		getAuthenticatedApp: async () => identity(),
		getWebhookConfig: async () => ({ url: configured, contentType: 'json', insecureSsl: '0' }),
		updateWebhookConfig: async (input) => {
			configured = input.url
			return { url: input.url, contentType: 'json', insecureSsl: '0' }
		},
		resolveOrganizationInstallation: async () => installation(41),
		resolveRepositoryInstallation: async () => installation(42),
		mintRepositoryToken: async () => ({ token: 'ghs_unused', expiresAt: Date.now() + 60_000 }),
		...overrides,
	}
}

/** One vault-held credential per connection, and a port whose client factory records what it was handed. */
async function fixture(github: SourceGitHubClient = client()) {
	const harness = createHarness()
	const vault = await Vault.create(harness.d1, testKey())
	const credentials: GitHubAppCredential[] = []
	const port = createSourceConnections({
		provider: 'zerops',
		vault: () => Promise.resolve(vault),
		createClient: async (credential) => {
			credentials.push(credential)
			return github
		},
	})
	const store = async (connectionId: string, appId = '123'): Promise<string> =>
		await vault.putSecret('platform', githubAppCredentialSecretLabel(connectionId), encodeGitHubAppCredential({ appId, privateKeyPem: PEM }))
	return { port, vault, credentials, store, credentialRef: await store('connection-1') }
}

function signal(): AbortSignal {
	return new AbortController().signal
}

describe('GitHub App administration over vault-held keys', () => {
	test('verifies the App the stored key authenticates as', async () => {
		const f = await fixture()
		expect(await f.port.verifyApp({ credentialRef: f.credentialRef, connectionId: 'connection-1', signal: signal() })).toEqual({
			id: 123,
			slug: 'fabrika-test',
			htmlUrl: 'https://github.com/apps/fabrika-test',
			public: false,
			owner: { login: 'contember', type: 'Organization' },
			permissions: { contents: 'read' },
			events: ['push'],
		})
		expect(f.credentials).toEqual([{ appId: '123', privateKeyPem: PEM }])
	})

	test.each([
		{ name: 'another App id', app: identity({ id: 456 }) },
		{ name: 'extra events', app: identity({ events: ['push', 'pull_request'] }) },
	])('refuses $name', async ({ app }) => {
		const f = await fixture(client({ getAuthenticatedApp: async () => app }))
		await expect(f.port.verifyApp({ credentialRef: f.credentialRef, connectionId: 'connection-1', signal: signal() })).rejects.toMatchObject({
			code: 'credentials_invalid',
			stage: 'credentials',
		})
	})

	test('names an App GitHub made on a personal account, so the console says what to fix', async () => {
		const f = await fixture(client({ getAuthenticatedApp: async () => identity({ owner: { login: 'someone', type: 'User' } }) }))
		await expect(f.port.verifyApp({ credentialRef: f.credentialRef, connectionId: 'connection-1', signal: signal() })).rejects.toMatchObject({
			code: 'app_owner_not_organization',
			stage: 'credentials',
		})
	})

	test("reads GitHub's rate limit as no verdict on the credentials", async () => {
		const f = await fixture(client({ getAuthenticatedApp: () => Promise.reject(new GitHubRateLimitError(403)) }))
		await expect(f.port.verifyApp({ credentialRef: f.credentialRef, connectionId: 'connection-1', signal: signal() })).rejects.toMatchObject({
			code: 'rate_limited',
			stage: 'credentials',
		})
	})

	test('reads a key only under the purpose of the connection it was sealed for', async () => {
		const f = await fixture()
		const other = await f.store('connection-2', '456')
		await expect(f.port.verifyApp({ credentialRef: other, connectionId: 'connection-1', signal: signal() })).rejects.toMatchObject({
			code: 'credentials_invalid',
		})
		await expect(f.port.verifyApp({ credentialRef: 'vault:missing', connectionId: 'connection-1', signal: signal() })).rejects.toMatchObject({
			code: 'credentials_invalid',
		})
		expect(f.credentials).toEqual([])
	})

	test('applies the webhook and proves it by readback', async () => {
		const secrets: string[] = []
		const github = client()
		const f = await fixture({
			...github,
			updateWebhookConfig: async (input) => {
				secrets.push(input.secret)
				return await github.updateWebhookConfig(input)
			},
		})
		await f.port.configureWebhook({
			credentialRef: f.credentialRef,
			connectionId: 'connection-1',
			url: WEBHOOK_URL,
			secret: 'hook-secret',
			signal: signal(),
		})
		expect(secrets).toEqual(['hook-secret'])
	})

	test.each<{ name: string; config: GitHubAppWebhookConfig }>([
		{ name: 'a different URL', config: { url: 'https://evil.example/webhooks/github', contentType: 'json', insecureSsl: '0' } },
		{ name: 'form encoding', config: { url: WEBHOOK_URL, contentType: 'form', insecureSsl: '0' } },
		{ name: 'disabled TLS verification', config: { url: WEBHOOK_URL, contentType: 'json', insecureSsl: '1' } },
	])('refuses a webhook readback with $name', async ({ config }) => {
		const f = await fixture(client({ getWebhookConfig: async () => config }))
		await expect(
			f.port.configureWebhook({
				credentialRef: f.credentialRef,
				connectionId: 'connection-1',
				url: WEBHOOK_URL,
				secret: 'hook-secret',
				signal: signal(),
			}),
		).rejects.toMatchObject({ code: 'credentials_invalid' })
	})

	test('preserves cancellation during a webhook mutation that ignores its signal', async () => {
		const started = Promise.withResolvers<void>()
		const f = await fixture(client({
			updateWebhookConfig: () => {
				started.resolve()
				return new Promise(() => {})
			},
		}))
		const controller = new AbortController()
		const operation = f.port.configureWebhook({
			credentialRef: f.credentialRef,
			connectionId: 'connection-1',
			url: WEBHOOK_URL,
			secret: 'hook-secret',
			signal: controller.signal,
		})
		await started.promise
		controller.abort('private reason')
		await expect(operation).rejects.toMatchObject({ code: 'cancelled', stage: 'credentials' })
	})

	test('verifies an organization installation and every requested repository grant', async () => {
		const f = await fixture()
		const verify = (port: SourceConnectionPort, scope: Parameters<SourceConnectionPort['verifyInstallations']>[0]['scope']) =>
			port.verifyInstallations({ credentialRef: f.credentialRef, connectionId: 'connection-1', scope, signal: signal() })
		expect(await verify(f.port, { kind: 'organization', organization: 'contember' })).toEqual({
			status: 'installed',
			installationId: 41,
			accountLogin: 'contember',
			repositorySelection: 'selected',
		})
		expect(await verify(f.port, { kind: 'repositories', repositories: [{ owner: 'contember', name: 'one' }, { owner: 'contember', name: 'two' }] }))
			.toMatchObject({ status: 'installed', installationId: 42 })

		let call = 0
		const split = await fixture(client({ resolveRepositoryInstallation: async () => call++ === 0 ? installation(42) : installation(43, 'attacker') }))
		await expect(split.port.verifyInstallations({
			credentialRef: split.credentialRef,
			connectionId: 'connection-1',
			scope: { kind: 'repositories', repositories: [{ owner: 'contember', name: 'one' }, { owner: 'contember', name: 'two' }] },
			signal: signal(),
		})).rejects.toMatchObject({ code: 'credentials_invalid' })

		const missing = await fixture(client({ resolveOrganizationInstallation: async () => null }))
		expect(
			await missing.port.verifyInstallations({
				credentialRef: missing.credentialRef,
				connectionId: 'connection-1',
				scope: { kind: 'organization', organization: 'contember' },
				signal: signal(),
			}),
		).toEqual({ status: 'missing' })
	})
})
