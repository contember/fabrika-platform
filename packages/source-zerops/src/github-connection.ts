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
	buildZeropsSourceCredentialActivateResponseV2,
	buildZeropsSourceCredentialBundle,
	buildZeropsSourceCredentialStatusResponse,
	buildZeropsSourceCredentialStatusResponseV2,
	buildZeropsSourceInstallationsVerifyResponse,
	buildZeropsSourceWebhookConfigureResponse,
	decodeZeropsSourceCredentialBundle,
	decodeZeropsSourceCredentialBundleV2,
	serializeZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundle,
	sha256ZeropsSourceCredentialBundleV2,
	type ZeropsSourceCredentialActivateResponseV1,
	type ZeropsSourceCredentialActivateResponseV2,
	zeropsSourceCredentialEnvV2,
	type ZeropsSourceCredentialStatusResponseV1,
	type ZeropsSourceCredentialStatusResponseV2,
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
	readonly credentialSlotsV2?: readonly { readonly name: string; readonly credentialBundle: string }[]
	readonly legacyAppId?: string
	readonly legacyPrivateKeyPem?: string
	readonly createClient: (input: { readonly appId: string; readonly privateKeyPem: string }) => Promise<SourceGitHubClient>
}

export interface SourceGitHubConnection {
	snapshot(): SourceGitHubSnapshot | undefined
	snapshotV2?(connectionId: string): SourceGitHubSnapshot | undefined
	activate(
		connectionId: string,
		credentialBundle: string,
		credentialSha256: string,
		signal: AbortSignal,
	): Promise<ZeropsSourceCredentialActivateResponseV1>
	status(connectionId: string, signal: AbortSignal): Promise<ZeropsSourceCredentialStatusResponseV1>
	activateV2?(
		connectionId: string,
		credentialBundle: string,
		credentialSha256: string,
		signal: AbortSignal,
	): Promise<ZeropsSourceCredentialActivateResponseV2>
	statusV2?(connectionId: string, signal: AbortSignal): Promise<ZeropsSourceCredentialStatusResponseV2>
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

/** A snapshot whose identity binding is known, which is the only kind an operation may act through. */
interface BoundSnapshot extends ActiveSnapshot {
	readonly githubApp: ZeropsSourceGitHubAppIdentityV1
	readonly connectionId: string
}

interface KeyedSnapshot extends SourceGitHubSnapshot {
	readonly connectionId: string
	readonly githubApp?: ZeropsSourceGitHubAppIdentityV1
}

/** Owns one legacy snapshot and an atomically replaced keyed snapshot map. */
export class GitHubConnection implements SourceGitHubConnection {
	private active: ActiveSnapshot | undefined
	private keyed: ReadonlyMap<string, KeyedSnapshot>

	private constructor(
		private readonly createClient: GitHubConnectionOptions['createClient'],
		initial: ActiveSnapshot | undefined,
		keyed: ReadonlyMap<string, KeyedSnapshot>,
	) {
		this.active = initial
		this.keyed = new Map(keyed)
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
		let initial: ActiveSnapshot | undefined
		if (credentialBundle !== undefined) {
			try {
				const bundle = decodeZeropsSourceCredentialBundle(credentialBundle)
				const credentialSha256 = await sha256ZeropsSourceCredentialBundle(credentialBundle)
				const client = await options.createClient({ appId: bundle.githubAppId, privateKeyPem: bundle.privateKeyPem })
				initial = { client, appId: bundle.githubAppId, credentialSha256 }
			} catch {
				throw new Error('GitHub App configuration is invalid')
			}
		}

		const keyed = new Map<string, KeyedSnapshot>()
		for (const slot of options.credentialSlotsV2 ?? []) {
			try {
				const bundle = decodeZeropsSourceCredentialBundleV2(slot.credentialBundle)
				if (slot.name !== await zeropsSourceCredentialEnvV2(bundle.connectionId) || keyed.has(bundle.connectionId)) {
					throw new Error('invalid keyed credential slot')
				}
				const credentialSha256 = await sha256ZeropsSourceCredentialBundleV2(slot.credentialBundle)
				const client = await options.createClient({ appId: bundle.githubAppId, privateKeyPem: bundle.privateKeyPem })
				keyed.set(bundle.connectionId, {
					client,
					appId: bundle.githubAppId,
					credentialSha256,
					connectionId: bundle.connectionId,
				})
			} catch {
				throw new Error('GitHub App configuration is invalid')
			}
		}
		return new GitHubConnection(options.createClient, initial, keyed)
	}

	snapshot(): SourceGitHubSnapshot | undefined {
		return this.active
	}

	snapshotV2(connectionId: string): SourceGitHubSnapshot | undefined {
		return this.keyed.get(connectionId)
	}

	hasAnySnapshot(): boolean {
		return this.active !== undefined || this.keyed.size > 0
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
		if (this.active === undefined) return buildZeropsSourceCredentialStatusResponse({ connectionId, state: 'anonymous' })
		const bound = await this.bindActive(connectionId, undefined, signal)
		return buildZeropsSourceCredentialStatusResponse({
			connectionId,
			state: 'active',
			credentialVersion: 1,
			credentialSha256: bound.credentialSha256,
			githubApp: bound.githubApp,
		})
	}

	async activateV2(
		connectionId: string,
		credentialBundle: string,
		credentialSha256: string,
		signal: AbortSignal,
	): Promise<ZeropsSourceCredentialActivateResponseV2> {
		throwIfAborted(signal, 'credentials')
		let bundle: ReturnType<typeof decodeZeropsSourceCredentialBundleV2>
		let actualDigest: string
		try {
			bundle = decodeZeropsSourceCredentialBundleV2(credentialBundle)
			actualDigest = await sha256ZeropsSourceCredentialBundleV2(credentialBundle)
		} catch {
			throw new SourceFailure('credentials_invalid', 'credentials', false, 400)
		}
		if (bundle.connectionId !== connectionId || actualDigest !== credentialSha256) {
			throw new SourceFailure('credentials_invalid', 'credentials', false, 400)
		}
		const before = this.keyed.get(connectionId)
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

		const current = this.keyed.get(connectionId)
		if (current !== undefined && current.credentialSha256 !== actualDigest) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}
		if (current === before || current === undefined || current.githubApp === undefined) {
			const updated = new Map(this.keyed)
			updated.set(connectionId, { client, appId: bundle.githubAppId, credentialSha256: actualDigest, githubApp, connectionId })
			this.keyed = updated
		}
		return buildZeropsSourceCredentialActivateResponseV2({
			connectionId,
			credentialVersion: 2,
			credentialSha256: actualDigest,
			githubApp: this.keyed.get(connectionId)?.githubApp ?? githubApp,
		})
	}

	async statusV2(connectionId: string, signal: AbortSignal): Promise<ZeropsSourceCredentialStatusResponseV2> {
		throwIfAborted(signal, 'credentials')
		const snapshot = this.keyed.get(connectionId)
		if (snapshot === undefined) return buildZeropsSourceCredentialStatusResponseV2({ connectionId, state: 'anonymous' })
		let githubApp = snapshot.githubApp
		if (githubApp === undefined) {
			try {
				githubApp = verifiedIdentity(await abortable(snapshot.client.getAuthenticatedApp(signal), signal), snapshot.appId)
				throwIfAborted(signal, 'credentials')
			} catch (error) {
				throw credentialFailure(error, signal)
			}
			const current = this.keyed.get(connectionId)
			if (current === snapshot) {
				const updated = new Map(this.keyed)
				updated.set(connectionId, { ...snapshot, githubApp })
				this.keyed = updated
			} else if (current === undefined || current.credentialSha256 !== snapshot.credentialSha256) {
				throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
			} else {
				githubApp = current.githubApp ?? githubApp
			}
		}
		const current = this.keyed.get(connectionId)
		if (current === undefined || current.githubApp === undefined) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}
		return buildZeropsSourceCredentialStatusResponseV2({
			connectionId,
			state: 'active',
			credentialVersion: 2,
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
		const snapshot = await this.bindActive(connectionId, credentialSha256, signal)
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
		const snapshot = await this.bindActive(connectionId, credentialSha256, signal)
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

	/**
	 * Return the snapshot an operation may act through, REBINDING the legacy one when this container
	 * has never seen an activation.
	 *
	 * The legacy bundle in `GITHUB_APP_CREDENTIALS` carries an App id and a private key and nothing
	 * else — no `connectionId`, no App identity. Those are set only by `activate`, in memory. So every
	 * operation must be able to recover them, not just `status`, and two things guarantee the need:
	 * this service runs MORE THAN ONE CONTAINER, so a caller's `status` can bind container A while its
	 * next request lands on B, and a platform deploy restarts all of them. When only `status` could
	 * rebind, `verifyInstallations` and `configureWebhook` answered `credentials_conflict` at random,
	 * which reached the console as a bare 502.
	 *
	 * `credentialSha256` is omitted by `status`, which authenticates the caller but carries no digest.
	 * A CONFLICTING binding is still refused: a snapshot already bound to another connection, or one
	 * whose digest does not match, is never rebound to the caller's.
	 */
	private async bindActive(
		connectionId: string,
		credentialSha256: string | undefined,
		signal: AbortSignal,
	): Promise<BoundSnapshot> {
		const keyed = this.keyed.get(connectionId)
		if (keyed !== undefined) {
			if (credentialSha256 !== undefined && keyed.credentialSha256 !== credentialSha256) {
				throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
			}
			// A keyed slot NEVER falls back to the legacy one: the legacy slot holds a different App, so
			// binding through it would answer for the wrong connection instead of failing.
			return keyed.githubApp === undefined ? await this.bindKeyed(keyed, signal) : { ...keyed, githubApp: keyed.githubApp }
		}
		const snapshot = this.active
		if (
			snapshot === undefined || (credentialSha256 !== undefined && snapshot.credentialSha256 !== credentialSha256)
			|| (snapshot.connectionId !== undefined && snapshot.connectionId !== connectionId)
		) throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		if (snapshot.githubApp !== undefined && snapshot.connectionId !== undefined) {
			return { ...snapshot, githubApp: snapshot.githubApp, connectionId: snapshot.connectionId }
		}
		let githubApp: ZeropsSourceGitHubAppIdentityV1
		try {
			githubApp = snapshot.githubApp
				?? verifiedIdentity(await abortable(snapshot.client.getAuthenticatedApp(signal), signal), snapshot.appId)
			throwIfAborted(signal, 'credentials')
		} catch (error) {
			throw credentialFailure(error, signal)
		}
		const bound: BoundSnapshot = { ...snapshot, githubApp, connectionId }
		// Only publish the binding if nothing replaced the snapshot while GitHub was answering; a
		// concurrent activation owns `this.active` and its binding is the newer fact.
		if (this.active === snapshot) {
			this.active = bound
			return bound
		}
		const current = this.active
		if (current === undefined || current.connectionId !== connectionId || current.credentialSha256 !== snapshot.credentialSha256) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}
		return { ...current, githubApp: current.githubApp ?? githubApp, connectionId }
	}

	/** A keyed slot restored from the environment carries no identity yet; bind it through its own client. */
	private async bindKeyed(slot: KeyedSnapshot, signal: AbortSignal): Promise<BoundSnapshot> {
		let githubApp: ZeropsSourceGitHubAppIdentityV1
		try {
			githubApp = verifiedIdentity(await abortable(slot.client.getAuthenticatedApp(signal), signal), slot.appId)
			throwIfAborted(signal, 'credentials')
		} catch (error) {
			throw credentialFailure(error, signal)
		}
		const current = this.keyed.get(slot.connectionId)
		// A concurrent activation owns the slot while GitHub was answering, and its binding is the newer fact.
		if (current === undefined || current.credentialSha256 !== slot.credentialSha256) {
			throw new SourceFailure('credentials_conflict', 'credentials', false, 409)
		}
		if (current.githubApp !== undefined) return { ...current, githubApp: current.githubApp }
		const bound: KeyedSnapshot = { ...current, githubApp }
		const updated = new Map(this.keyed)
		updated.set(slot.connectionId, bound)
		this.keyed = updated
		return { ...bound, githubApp }
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
