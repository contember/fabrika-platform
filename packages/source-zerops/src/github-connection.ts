import type {
	GitHubAppIdentity,
	GitHubAppInstallation,
	GitHubAppWebhookConfig,
	GitHubAppWebhookUpdate,
	GitHubInstallationToken,
	GitHubRepositoryTokenRequest,
} from '@fabrika/github-app'
import {
	buildZeropsSourceCredentialActivateResponse,
	buildZeropsSourceCredentialBundle,
	buildZeropsSourceCredentialStatusResponse,
	buildZeropsSourceInstallationsVerifyResponse,
	buildZeropsSourceWebhookConfigureResponse,
	decodeZeropsSourceCredentialBundle,
	serializeZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundle,
	type ZeropsSourceCredentialActivateResponseV1,
	type ZeropsSourceCredentialStatusResponseV1,
	type ZeropsSourceGitHubAppIdentityV1,
	type ZeropsSourceInstallationScopeV1,
	type ZeropsSourceInstallationsVerifyResponseV1,
	type ZeropsSourceWebhookConfigureResponseV1,
} from '@fabrika/provider-zerops'
import { cancelled, SourceFailure, throwIfAborted } from './failure'

export interface SourceGitHubClient {
	getAuthenticatedApp(signal?: AbortSignal): Promise<GitHubAppIdentity>
	getWebhookConfig?(signal?: AbortSignal): Promise<GitHubAppWebhookConfig>
	updateWebhookConfig?(input: GitHubAppWebhookUpdate): Promise<GitHubAppWebhookConfig>
	resolveOrganizationInstallation?(organization: string, signal?: AbortSignal): Promise<GitHubAppInstallation | null>
	resolveRepositoryInstallation?(owner: string, repository: string, signal?: AbortSignal): Promise<GitHubAppInstallation | null>
	resolveOrganizationInstallationId?(organization: string, signal?: AbortSignal): Promise<number | null>
	resolveInstallationId(owner: string, repository: string, signal?: AbortSignal): Promise<number | null>
	mintRepositoryToken(input: GitHubRepositoryTokenRequest): Promise<GitHubInstallationToken>
}

export interface SourceGitHubSnapshot {
	readonly client: SourceGitHubClient
	readonly appId: string
	readonly credentialSha256: string
}

export interface GitHubConnectionOptions {
	readonly credentialBundle?: string
	readonly legacyAppId?: string
	readonly legacyPrivateKeyPem?: string
	readonly createClient: (input: { readonly appId: string; readonly privateKeyPem: string }) => Promise<SourceGitHubClient>
}

export interface SourceGitHubConnection {
	snapshot(): SourceGitHubSnapshot | undefined
	activate(
		connectionId: string,
		credentialBundle: string,
		credentialSha256: string,
		signal: AbortSignal,
	): Promise<ZeropsSourceCredentialActivateResponseV1>
	status(connectionId: string, signal: AbortSignal): Promise<ZeropsSourceCredentialStatusResponseV1>
	configureWebhook?(
		connectionId: string,
		credentialSha256: string,
		url: string,
		secret: string,
		signal: AbortSignal,
	): Promise<ZeropsSourceWebhookConfigureResponseV1>
	verifyInstallations?(
		connectionId: string,
		credentialSha256: string,
		scope: ZeropsSourceInstallationScopeV1,
		signal: AbortSignal,
	): Promise<ZeropsSourceInstallationsVerifyResponseV1>
}

interface ActiveSnapshot extends SourceGitHubSnapshot {
	readonly githubApp?: ZeropsSourceGitHubAppIdentityV1
	readonly connectionId?: string
}

/** Owns the one atomic GitHub client used by every source operation. */
export class GitHubConnection implements SourceGitHubConnection {
	private active: ActiveSnapshot | undefined

	private constructor(
		private readonly createClient: GitHubConnectionOptions['createClient'],
		initial: ActiveSnapshot | undefined,
	) {
		this.active = initial
	}

	static async create(options: GitHubConnectionOptions): Promise<GitHubConnection> {
		const legacyComplete = options.legacyAppId !== undefined && options.legacyPrivateKeyPem !== undefined
		const legacyPartial = (options.legacyAppId === undefined) !== (options.legacyPrivateKeyPem === undefined)
		if (legacyPartial) throw new Error('GitHub App configuration is incomplete')

		let credentialBundle = options.credentialBundle
		if (legacyComplete) {
			let legacyBundle: string
			try {
				legacyBundle = serializeZeropsSourceCredentialBundle(buildZeropsSourceCredentialBundle({
					githubAppId: options.legacyAppId,
					privateKeyPem: options.legacyPrivateKeyPem,
				}))
			} catch {
				throw new Error('GitHub App configuration is invalid')
			}
			if (credentialBundle === undefined) credentialBundle = legacyBundle
			else if (credentialBundle !== legacyBundle) throw new Error('GitHub App configuration conflicts')
		}
		if (credentialBundle === undefined) return new GitHubConnection(options.createClient, undefined)

		let bundle: ReturnType<typeof decodeZeropsSourceCredentialBundle>
		let client: SourceGitHubClient
		let credentialSha256: string
		try {
			bundle = decodeZeropsSourceCredentialBundle(credentialBundle)
			credentialSha256 = await sha256ZeropsSourceCredentialBundle(credentialBundle)
			client = await options.createClient({ appId: bundle.githubAppId, privateKeyPem: bundle.privateKeyPem })
		} catch {
			throw new Error('GitHub App configuration is invalid')
		}
		return new GitHubConnection(options.createClient, { client, appId: bundle.githubAppId, credentialSha256 })
	}

	snapshot(): SourceGitHubSnapshot | undefined {
		return this.active
	}

	async activate(
		connectionId: string,
		credentialBundle: string,
		credentialSha256: string,
		signal: AbortSignal,
	): Promise<ZeropsSourceCredentialActivateResponseV1> {
		throwIfAborted(signal, 'credentials')
		let bundle: ReturnType<typeof decodeZeropsSourceCredentialBundle>
		let actualDigest: string
		try {
			bundle = decodeZeropsSourceCredentialBundle(credentialBundle)
			actualDigest = await sha256ZeropsSourceCredentialBundle(credentialBundle)
		} catch {
			throw new SourceFailure('credentials_invalid', 'credentials', false, 400)
		}
		if (actualDigest !== credentialSha256) throw new SourceFailure('credentials_invalid', 'credentials', false, 400)
		const before = this.active
		if (before !== undefined && before.credentialSha256 !== actualDigest) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}

		let client: SourceGitHubClient
		let githubApp: ZeropsSourceGitHubAppIdentityV1
		try {
			client = await abortable(this.createClient({ appId: bundle.githubAppId, privateKeyPem: bundle.privateKeyPem }), signal)
			throwIfAborted(signal, 'credentials')
			githubApp = verifiedIdentity(await abortable(client.getAuthenticatedApp(signal), signal), bundle.githubAppId)
			throwIfAborted(signal, 'credentials')
		} catch (error) {
			throw credentialFailure(error, signal)
		}

		const current = this.active
		if (current !== undefined && current.credentialSha256 !== actualDigest) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}
		if (current?.connectionId !== undefined && current.connectionId !== connectionId) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}
		if (current === before || current === undefined || current.githubApp === undefined || current.connectionId === undefined) {
			this.active = { client, appId: bundle.githubAppId, credentialSha256: actualDigest, githubApp, connectionId }
		}
		return buildZeropsSourceCredentialActivateResponse({
			connectionId,
			credentialVersion: 1,
			credentialSha256: actualDigest,
			githubApp: this.active?.githubApp ?? githubApp,
		})
	}

	async status(connectionId: string, signal: AbortSignal): Promise<ZeropsSourceCredentialStatusResponseV1> {
		throwIfAborted(signal, 'credentials')
		const snapshot = this.active
		if (snapshot === undefined) return buildZeropsSourceCredentialStatusResponse({ connectionId, state: 'anonymous' })
		if (snapshot.connectionId !== undefined && snapshot.connectionId !== connectionId) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}
		let githubApp = snapshot.githubApp
		if (githubApp === undefined) {
			try {
				githubApp = verifiedIdentity(await abortable(snapshot.client.getAuthenticatedApp(signal), signal), snapshot.appId)
				throwIfAborted(signal, 'credentials')
			} catch (error) {
				throw credentialFailure(error, signal)
			}
			const current = this.active
			if (current === snapshot) {
				this.active = { ...snapshot, githubApp, connectionId }
			} else if (
				current === undefined || current.connectionId !== connectionId || current.credentialSha256 !== snapshot.credentialSha256
			) {
				throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
			} else {
				githubApp = current.githubApp ?? githubApp
			}
		}
		const current = this.active
		if (current === undefined || current.connectionId !== connectionId) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}
		return buildZeropsSourceCredentialStatusResponse({
			connectionId,
			state: 'active',
			credentialVersion: 1,
			credentialSha256: current.credentialSha256,
			githubApp,
		})
	}

	async configureWebhook(
		connectionId: string,
		credentialSha256: string,
		url: string,
		secret: string,
		signal: AbortSignal,
	): Promise<ZeropsSourceWebhookConfigureResponseV1> {
		const snapshot = this.requireActive(connectionId, credentialSha256)
		try {
			const update = snapshot.client.updateWebhookConfig
			const read = snapshot.client.getWebhookConfig
			if (update === undefined || read === undefined) throw new SourceFailure('credentials_invalid', 'credentials', false, 503)
			const updated = await abortable(update.call(snapshot.client, { url, secret, signal }), signal)
			const verified = await abortable(read.call(snapshot.client, signal), signal)
			if (
				updated.url !== url || updated.contentType !== 'json' || updated.insecureSsl !== '0'
				|| verified.url !== url || verified.contentType !== 'json' || verified.insecureSsl !== '0'
			) throw new SourceFailure('credentials_invalid', 'credentials', false, 422)
			return buildZeropsSourceWebhookConfigureResponse({
				connectionId,
				credentialSha256,
				webhook: { url, contentType: 'json', insecureSsl: '0' },
			})
		} catch (error) {
			throw credentialFailure(error, signal)
		}
	}

	async verifyInstallations(
		connectionId: string,
		credentialSha256: string,
		scope: ZeropsSourceInstallationScopeV1,
		signal: AbortSignal,
	): Promise<ZeropsSourceInstallationsVerifyResponseV1> {
		const snapshot = this.requireActive(connectionId, credentialSha256)
		try {
			const installation = scope.kind === 'organization'
				? await resolveOrganizationInstallation(snapshot.client, scope.organization, signal)
				: await resolveRepositoryInstallations(snapshot.client, scope.repositories, signal)
			return buildZeropsSourceInstallationsVerifyResponse({
				connectionId,
				credentialSha256,
				installation: installation === null
					? { status: 'missing' }
					: {
						status: 'installed',
						installationId: installation.id,
						accountLogin: installation.accountLogin,
						repositorySelection: installation.repositorySelection,
					},
			})
		} catch (error) {
			throw credentialFailure(error, signal)
		}
	}

	private requireActive(connectionId: string, credentialSha256: string): ActiveSnapshot {
		const snapshot = this.active
		if (
			snapshot === undefined || snapshot.githubApp === undefined || snapshot.connectionId !== connectionId
			|| snapshot.credentialSha256 !== credentialSha256
		) throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		return snapshot
	}
}

async function resolveOrganizationInstallation(
	client: SourceGitHubClient,
	organization: string,
	signal: AbortSignal,
): Promise<GitHubAppInstallation | null> {
	const resolve = client.resolveOrganizationInstallation
	if (resolve === undefined) throw new SourceFailure('credentials_invalid', 'credentials', false, 503)
	return await abortable(resolve.call(client, organization, signal), signal)
}

async function resolveRepositoryInstallations(
	client: SourceGitHubClient,
	repositories: readonly { readonly owner: string; readonly name: string }[],
	signal: AbortSignal,
): Promise<GitHubAppInstallation | null> {
	const resolve = client.resolveRepositoryInstallation
	if (resolve === undefined) throw new SourceFailure('credentials_invalid', 'credentials', false, 503)
	let verified: GitHubAppInstallation | undefined
	for (const repository of repositories) {
		const installation = await abortable(resolve.call(client, repository.owner, repository.name, signal), signal)
		if (installation === null) return null
		if (
			verified !== undefined
			&& (verified.id !== installation.id || verified.accountLogin.toLowerCase() !== installation.accountLogin.toLowerCase()
				|| verified.repositorySelection !== installation.repositorySelection)
		) throw new SourceFailure('credentials_invalid', 'credentials', false, 422)
		verified = installation
	}
	return verified ?? null
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new DOMException('The credential operation was aborted', 'AbortError'))
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (result: { readonly value: T } | { readonly error: unknown }): void => {
			if (settled) return
			settled = true
			signal.removeEventListener('abort', abort)
			if ('value' in result) resolve(result.value)
			else reject(result.error)
		}
		const abort = (): void => finish({ error: new DOMException('The credential operation was aborted', 'AbortError') })
		signal.addEventListener('abort', abort, { once: true })
		if (signal.aborted) abort()
		operation.then(
			(value) => finish({ value }),
			(error: unknown) => finish({ error }),
		)
	})
}

function verifiedIdentity(identity: GitHubAppIdentity, expectedAppId?: string): ZeropsSourceGitHubAppIdentityV1 {
	if (
		(expectedAppId !== undefined && String(identity.id) !== expectedAppId)
		|| identity.owner.type !== 'Organization'
		|| identity.events.length !== 1
		|| identity.events[0] !== 'push'
	) {
		throw new SourceFailure('credentials_invalid', 'credentials', false, 422)
	}
	return {
		id: identity.id,
		slug: identity.slug,
		htmlUrl: identity.htmlUrl,
		public: identity.public,
		owner: { login: identity.owner.login, type: 'Organization' },
		permissions: { contents: 'read' },
		events: ['push'],
	}
}

function credentialFailure(error: unknown, signal: AbortSignal): SourceFailure {
	if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelled('credentials')
	if (error instanceof SourceFailure) return error
	if (error instanceof Error && error.name === 'TimeoutError') return new SourceFailure('internal', 'credentials', true, 504)
	return new SourceFailure('credentials_invalid', 'credentials', false, 422)
}
