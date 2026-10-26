import { configurationError, requestStatusError, responseError } from './errors'
import { createRepositoryClient } from './repository'
import type { GitHubRepositoryClient, GitHubRepositoryOpenRequest } from './repository-types'
import { pemToPkcs8, signAppJwt } from './signing'
import { createCancellation, GITHUB_ACCEPT, GITHUB_API_VERSION, GITHUB_USER_AGENT, readBoundedJson } from './transport'
import type {
	GitHubAppClientConfig,
	GitHubAppFetch,
	GitHubAppIdentity,
	GitHubAppInstallation,
	GitHubAppWebhookConfig,
	GitHubAppWebhookUpdate,
	GitHubInstallationToken,
	GitHubRepositoryTokenRequest,
} from './types'
import {
	decodeAppIdentity,
	decodeWebhookConfig,
	installationSchema,
	installationTokenSchema,
	isPositiveSafeInteger,
	normalizeApiBaseUrl,
	normalizeWebhookUrl,
	sameAppIdentity,
	validateRepositoryComponent,
	validateWebhookSecret,
} from './validation'

const DEFAULT_API_BASE_URL = 'https://api.github.com'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const APP_ID_PATTERN = /^[1-9][0-9]*$/
const NOT_FOUND = Symbol('not-found')

/** GitHub App machine identity. Webhook authentication belongs to the receiving service. */
export class GitHubAppClient {
	private constructor(
		private readonly appId: string,
		private readonly privateKey: CryptoKey,
		private readonly apiBaseUrl: string,
		private readonly fetchImplementation: GitHubAppFetch,
		private readonly clock: () => number,
		private readonly timeoutMs: number,
	) {}

	/** Validate all configuration and import the RSA key before a credential-owning service boots. */
	static async create(config: GitHubAppClientConfig): Promise<GitHubAppClient> {
		if (!APP_ID_PATTERN.test(config.appId) || config.appId.length > 32) {
			throw configurationError()
		}
		const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? DEFAULT_API_BASE_URL)
		const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
			throw configurationError()
		}
		let privateKey: CryptoKey
		try {
			privateKey = await crypto.subtle.importKey(
				'pkcs8',
				pemToPkcs8(config.privateKeyPem),
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
				false,
				['sign'],
			)
		} catch {
			throw configurationError()
		}
		// The global `fetch` is wrapped: a Worker refuses it with any other `this` ("Illegal invocation"), and the client calls
		// it as its own property, and hands it to the repository client.
		const fetchImplementation = config.fetch ?? ((input, init) => fetch(input, init))
		return new GitHubAppClient(config.appId, privateKey, apiBaseUrl, fetchImplementation, config.now ?? Date.now, timeoutMs)
	}

	/** Read and bind the public identity represented by this client's App credentials. */
	async getAuthenticatedApp(signal?: AbortSignal): Promise<GitHubAppIdentity> {
		const body = await this.requestJson('/app', {}, signal, false)
		if (body === NOT_FOUND) throw responseError()
		const identity = decodeAppIdentity(body)
		if (identity === null || String(identity.id) !== this.appId) throw responseError()
		const publicBody = await this.requestJson(`/apps/${identity.slug}`, {}, signal, true, false)
		if (publicBody === NOT_FOUND) return { ...identity, public: false }
		const publicIdentity = decodeAppIdentity(publicBody)
		if (publicIdentity === null || !sameAppIdentity(identity, publicIdentity)) throw responseError()
		return { ...identity, public: true }
	}

	/** Read the App webhook transport settings without exposing GitHub's masked secret field. */
	async getWebhookConfig(signal?: AbortSignal): Promise<GitHubAppWebhookConfig> {
		const body = await this.requestJson('/app/hook/config', {}, signal, false)
		if (body === NOT_FOUND) throw responseError()
		const config = decodeWebhookConfig(body)
		if (config === null) throw responseError()
		return config
	}

	/** Set the App webhook to JSON over verified TLS and bind GitHub's response to that request. */
	async updateWebhookConfig(input: GitHubAppWebhookUpdate): Promise<GitHubAppWebhookConfig> {
		const webhookUrl = normalizeWebhookUrl(input.url)
		validateWebhookSecret(input.secret)
		const body = await this.requestJson(
			'/app/hook/config',
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: webhookUrl, content_type: 'json', insecure_ssl: '0', secret: input.secret }),
			},
			input.signal,
			false,
		)
		if (body === NOT_FOUND) throw responseError()
		const config = decodeWebhookConfig(body)
		if (config === null || config.url !== webhookUrl || config.contentType !== 'json' || config.insecureSsl !== '0') {
			throw responseError()
		}
		return config
	}

	/** Resolve the App installation owned by one organization. A 404 is an expected miss. */
	async resolveOrganizationInstallationId(organization: string, signal?: AbortSignal): Promise<number | null> {
		return (await this.resolveOrganizationInstallation(organization, signal))?.id ?? null
	}

	/** Resolve and strictly bind the installation authority owned by one organization. */
	async resolveOrganizationInstallation(organization: string, signal?: AbortSignal): Promise<GitHubAppInstallation | null> {
		validateRepositoryComponent(organization)
		const body = await this.requestJson(`/orgs/${organization}/installation`, {}, signal, true)
		if (body === NOT_FOUND) return null
		return this.decodeInstallation(body, organization, 'Organization')
	}

	/** Resolve the App installation for one GitHub repository. A 404 is an expected miss. */
	async resolveInstallationId(owner: string, repository: string, signal?: AbortSignal): Promise<number | null> {
		return (await this.resolveRepositoryInstallation(owner, repository, signal))?.id ?? null
	}

	/** Resolve and strictly bind the installation authority that grants one repository. */
	async resolveRepositoryInstallation(owner: string, repository: string, signal?: AbortSignal): Promise<GitHubAppInstallation | null> {
		validateRepositoryComponent(owner)
		validateRepositoryComponent(repository)
		const body = await this.requestJson(`/repos/${owner}/${repository}/installation`, {}, signal, true)
		if (body === NOT_FOUND) {
			return null
		}
		return this.decodeInstallation(body, owner)
	}

	/** Mint a read-only token restricted to one repository in the selected installation. */
	async mintRepositoryToken(input: GitHubRepositoryTokenRequest): Promise<GitHubInstallationToken> {
		return this.mintToken(input, { contents: 'read' })
	}

	/**
	 * Mint a token restricted to one repository with `contents: write` and `pull_requests: write`,
	 * and return a client bound to it. The token never leaves the returned client.
	 */
	async openRepository(input: GitHubRepositoryOpenRequest): Promise<GitHubRepositoryClient> {
		const token = await this.mintToken(input, { contents: 'write', pull_requests: 'write' })
		return createRepositoryClient({
			owner: input.owner,
			repository: input.repository,
			token,
			now: () => this.now(),
			apiBaseUrl: this.apiBaseUrl,
			fetch: this.fetchImplementation,
			timeoutMs: this.timeoutMs,
		})
	}

	private async mintToken(
		input: GitHubRepositoryTokenRequest,
		permissions: Readonly<Record<string, 'read' | 'write'>>,
	): Promise<GitHubInstallationToken> {
		if (!isPositiveSafeInteger(input.installationId)) {
			throw configurationError()
		}
		validateRepositoryComponent(input.owner)
		validateRepositoryComponent(input.repository)
		const body = await this.requestJson(
			`/app/installations/${input.installationId}/access_tokens`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ repositories: [input.repository], permissions }),
			},
			input.signal,
			false,
		)
		if (body === NOT_FOUND) {
			throw responseError()
		}
		const result = installationTokenSchema.safeParse(body)
		if (!result.success) throw responseError()
		const { token, expires_at: expiresAt } = result.data
		if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
			throw responseError()
		}
		return { token, expiresAt }
	}

	private async requestJson(
		path: string,
		init: RequestInit,
		callerSignal: AbortSignal | undefined,
		allowNotFound: boolean,
		authenticate = true,
	): Promise<unknown | typeof NOT_FOUND> {
		const cancellation = createCancellation(callerSignal, this.timeoutMs)
		try {
			cancellation.throwIfCancelled()
			const headers = new Headers(init.headers)
			if (authenticate) {
				let jwt: string
				try {
					jwt = await signAppJwt(this.appId, this.privateKey, () => this.now())
				} catch (error) {
					cancellation.throwIfCancelled()
					throw error
				}
				cancellation.throwIfCancelled()
				headers.set('authorization', `Bearer ${jwt}`)
			}
			headers.set('accept', GITHUB_ACCEPT)
			headers.set('x-github-api-version', GITHUB_API_VERSION)
			headers.set('user-agent', GITHUB_USER_AGENT)
			let response: Response
			try {
				response = await this.fetchImplementation(`${this.apiBaseUrl}${path}`, {
					...init,
					headers,
					// Workers refuse `redirect: 'error'`; a redirect is a response that is not `ok` and fails below.
					redirect: 'manual',
					signal: cancellation.signal,
				})
			} catch {
				cancellation.throwIfCancelled()
				throw new Error('GitHub App request failed')
			}
			cancellation.throwIfCancelled()
			if (allowNotFound && response.status === 404) {
				return NOT_FOUND
			}
			if (!response.ok) {
				throw requestStatusError(response.status)
			}
			return await readBoundedJson(response, cancellation)
		} finally {
			cancellation.dispose()
		}
	}

	private decodeInstallation(body: unknown, accountLogin: string, requiredType?: 'Organization' | 'User'): GitHubAppInstallation {
		const result = installationSchema.safeParse(body)
		if (!result.success) throw responseError()
		const { id, app_id: appId, target_type: targetType, account: { login, type: accountType }, repository_selection: repositorySelection } = result.data
		if (
			String(appId) !== this.appId || accountType !== targetType
			|| (requiredType !== undefined && targetType !== requiredType)
			|| login.toLowerCase() !== accountLogin.toLowerCase()
		) {
			throw responseError()
		}
		return { id, accountLogin: login, accountType: targetType, repositorySelection }
	}

	private now(): number {
		let value: number
		try {
			value = this.clock()
		} catch {
			throw configurationError()
		}
		if (!Number.isFinite(value)) {
			throw configurationError()
		}
		return value
	}
}
