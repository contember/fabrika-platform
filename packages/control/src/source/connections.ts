import type { GitHubAppIdentity, GitHubAppInstallation } from '@fabrika/github-app'
import type { Vault } from '../vault'
import { readGitHubAppCredential, type SourceGitHubClient, type SourceGitHubClientFactory } from './credentials'
import { cancelled, SourceFailure, throwIfAborted } from './failure'

export interface SourceGitHubAppIdentity {
	readonly id: number
	readonly slug: string
	readonly htmlUrl: string
	readonly public: boolean
	readonly owner: { readonly login: string; readonly type: 'Organization' }
	readonly permissions: { readonly contents: 'read' }
	readonly events: readonly string[]
}

export type SourceInstallationScope =
	| { readonly kind: 'organization'; readonly organization: string }
	| { readonly kind: 'repositories'; readonly repositories: readonly { readonly owner: string; readonly name: string }[] }

export type SourceInstallationVerification =
	| { readonly status: 'missing' }
	| {
		readonly status: 'installed'
		readonly installationId: number
		readonly accountLogin: string
		readonly repositorySelection: 'all' | 'selected'
	}

/** One connection's vault-held App credential, named by its ref and the connection it was sealed for. */
export interface SourceConnectionCredential {
	readonly credentialRef: string
	readonly connectionId: string
	readonly signal: AbortSignal
}

export interface SourceWebhookConfigurationInput extends SourceConnectionCredential {
	readonly url: string
	readonly secret: string
}

export interface SourceInstallationVerificationInput extends SourceConnectionCredential {
	readonly scope: SourceInstallationScope
}

/** Privileged GitHub App administration for the authenticated setup and recovery workflows. */
export interface SourceConnectionPort {
	readonly provider: string
	verifyApp(input: SourceConnectionCredential): Promise<SourceGitHubAppIdentity>
	/** Applies the webhook and proves URL, JSON content type and TLS verification by readback; GitHub masks the secret. */
	configureWebhook(input: SourceWebhookConfigurationInput): Promise<void>
	verifyInstallations(input: SourceInstallationVerificationInput): Promise<SourceInstallationVerification>
}

export interface SourceConnectionsOptions {
	readonly provider: string
	readonly vault: () => Promise<Vault>
	readonly createClient: SourceGitHubClientFactory
}

export function createSourceConnections(options: SourceConnectionsOptions): SourceConnectionPort {
	const withClient = async <T>(input: SourceConnectionCredential, use: (client: SourceGitHubClient, appId: string) => Promise<T>): Promise<T> => {
		throwIfAborted(input.signal, 'credentials')
		let client: SourceGitHubClient
		let appId: string
		try {
			const credential = await readGitHubAppCredential(await options.vault(), input.credentialRef, input.connectionId)
			appId = credential.appId
			client = await options.createClient(credential)
		} catch {
			throw new SourceFailure('credentials_invalid', 'credentials')
		}
		try {
			return await use(client, appId)
		} catch (error) {
			throw credentialFailure(error, input.signal)
		}
	}
	return {
		provider: options.provider,
		verifyApp: (input) =>
			withClient(input, async (client, appId) => verifiedIdentity(await abortable(client.getAuthenticatedApp(input.signal), input.signal), appId)),
		configureWebhook: (input) =>
			withClient(input, async (client) => {
				const updated = await abortable(client.updateWebhookConfig({ url: input.url, secret: input.secret, signal: input.signal }), input.signal)
				const verified = await abortable(client.getWebhookConfig(input.signal), input.signal)
				if (
					updated.url !== input.url || updated.contentType !== 'json' || updated.insecureSsl !== '0'
					|| verified.url !== input.url || verified.contentType !== 'json' || verified.insecureSsl !== '0'
				) throw new SourceFailure('credentials_invalid', 'credentials')
			}),
		verifyInstallations: (input) =>
			withClient(input, async (client) => {
				const installation = input.scope.kind === 'organization'
					? await abortable(client.resolveOrganizationInstallation(input.scope.organization, input.signal), input.signal)
					: await resolveRepositoryInstallations(client, input.scope.repositories, input.signal)
				if (installation === null) return { status: 'missing' }
				return {
					status: 'installed',
					installationId: installation.id,
					accountLogin: installation.accountLogin,
					repositorySelection: installation.repositorySelection,
				}
			}),
	}
}

async function resolveRepositoryInstallations(
	client: SourceGitHubClient,
	repositories: readonly { readonly owner: string; readonly name: string }[],
	signal: AbortSignal,
): Promise<GitHubAppInstallation | null> {
	let verified: GitHubAppInstallation | undefined
	for (const repository of repositories) {
		const installation = await abortable(client.resolveRepositoryInstallation(repository.owner, repository.name, signal), signal)
		if (installation === null) return null
		if (
			verified !== undefined
			&& (verified.id !== installation.id || verified.accountLogin.toLowerCase() !== installation.accountLogin.toLowerCase()
				|| verified.repositorySelection !== installation.repositorySelection)
		) throw new SourceFailure('credentials_invalid', 'credentials')
		verified = installation
	}
	return verified ?? null
}

/** The App the vault key authenticates as must be the stored App, organization-owned, subscribed to `push` only. */
function verifiedIdentity(identity: GitHubAppIdentity, expectedAppId: string): SourceGitHubAppIdentity {
	if (
		String(identity.id) !== expectedAppId
		|| identity.owner.type !== 'Organization'
		|| identity.events.length !== 1
		|| identity.events[0] !== 'push'
	) {
		throw new SourceFailure('credentials_invalid', 'credentials')
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

/** Settle on cancellation even when a client ignores its signal; GitHub may still finish the call. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new DOMException('The GitHub App request was aborted', 'AbortError'))
	return new Promise((resolve, reject) => {
		const abort = (): void => reject(new DOMException('The GitHub App request was aborted', 'AbortError'))
		signal.addEventListener('abort', abort, { once: true })
		operation.then(
			(value) => {
				signal.removeEventListener('abort', abort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', abort)
				reject(error)
			},
		)
	})
}

function credentialFailure(error: unknown, signal: AbortSignal): SourceFailure {
	if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelled('credentials')
	if (error instanceof SourceFailure) return error
	if (error instanceof Error && error.name === 'TimeoutError') return new SourceFailure('internal', 'credentials')
	return new SourceFailure('credentials_invalid', 'credentials')
}
