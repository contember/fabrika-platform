import type { GitHubAppIdentity, GitHubInstallationToken, GitHubRepositoryTokenRequest } from '@fabrika/github-app'
import {
	buildZeropsSourceCredentialActivateResponse,
	buildZeropsSourceCredentialBundle,
	buildZeropsSourceCredentialStatusResponse,
	decodeZeropsSourceCredentialBundle,
	serializeZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundle,
	type ZeropsSourceCredentialActivateResponseV1,
	type ZeropsSourceCredentialStatusResponseV1,
	type ZeropsSourceGitHubAppIdentityV1,
} from '@fabrika/provider-zerops'
import { cancelled, SourceFailure, throwIfAborted } from './failure'

export interface SourceGitHubClient {
	getAuthenticatedApp(signal?: AbortSignal): Promise<GitHubAppIdentity>
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
}

interface ActiveSnapshot extends SourceGitHubSnapshot {
	readonly githubApp?: ZeropsSourceGitHubAppIdentityV1
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
		if (current === before || current === undefined || current.githubApp === undefined) {
			this.active = { client, appId: bundle.githubAppId, credentialSha256: actualDigest, githubApp }
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
		let githubApp = snapshot.githubApp
		if (githubApp === undefined) {
			try {
				githubApp = verifiedIdentity(await abortable(snapshot.client.getAuthenticatedApp(signal), signal), snapshot.appId)
				throwIfAborted(signal, 'credentials')
			} catch (error) {
				throw credentialFailure(error, signal)
			}
			if (this.active === snapshot) this.active = { ...snapshot, githubApp }
		}
		return buildZeropsSourceCredentialStatusResponse({
			connectionId,
			state: 'active',
			credentialVersion: 1,
			credentialSha256: snapshot.credentialSha256,
			githubApp,
		})
	}
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
