import {
	GitHubAppClient,
	type GitHubAppFetch,
	type GitHubAppIdentity,
	type GitHubAppInstallation,
	type GitHubAppWebhookConfig,
	type GitHubAppWebhookUpdate,
	type GitHubInstallationToken,
	type GitHubRepositoryTokenRequest,
} from '@fabrika/github-app'
import { z } from 'zod'
import type { Env } from '../../env'
import { vault as openVault } from '../../services'
import type { Vault } from '../../vault'
import { cancelled, SourceFailure } from '../source/failure'
import type { SourcePrivateBinding, SourceRepository } from '../source/types'
import { githubAppCredentialSecretLabel } from './secrets'

const MAX_APP_CREDENTIAL_BYTES = 72 * 1024
const MAX_PRIVATE_KEY_LENGTH = 64 * 1024

/** A connection's GitHub App id and private key, held only in Control's vault (ADR-0029). */
export interface GitHubAppCredential {
	readonly appId: string
	readonly privateKeyPem: string
}

const appCredentialSchema = z.object({
	appId: z.string().regex(/^[1-9][0-9]{0,31}$/),
	privateKeyPem: z.string().min(1).max(MAX_PRIVATE_KEY_LENGTH),
}).strict()

/** Canonical JSON: fixed key order, so the stored value has exactly one spelling. */
export function encodeGitHubAppCredential(credential: GitHubAppCredential): string {
	const parsed = appCredentialSchema.safeParse(credential)
	if (!parsed.success) throw new Error('GitHub App credential is invalid')
	const encoded = JSON.stringify({ appId: parsed.data.appId, privateKeyPem: parsed.data.privateKeyPem })
	if (new TextEncoder().encode(encoded).byteLength > MAX_APP_CREDENTIAL_BYTES) throw new Error('GitHub App credential is invalid')
	return encoded
}

/** Never echoes the value: a parse diagnostic would carry key material. */
export function decodeGitHubAppCredential(value: string): GitHubAppCredential {
	if (new TextEncoder().encode(value).byteLength > MAX_APP_CREDENTIAL_BYTES) throw new Error('GitHub App credential is invalid')
	let json: unknown
	try {
		json = JSON.parse(value)
	} catch {
		throw new Error('GitHub App credential is invalid')
	}
	const parsed = appCredentialSchema.safeParse(json)
	if (!parsed.success) throw new Error('GitHub App credential is invalid')
	return parsed.data
}

/** Decrypt one connection's App credential under the exact purpose it was sealed with. */
export async function readGitHubAppCredential(vault: Vault, credentialRef: string, connectionId: string): Promise<GitHubAppCredential> {
	const value = await vault.getSecretForPurpose(credentialRef, { scope: 'platform', label: githubAppCredentialSecretLabel(connectionId) })
	return decodeGitHubAppCredential(value)
}

/** The part of the GitHub App client that source handling uses. */
export interface SourceGitHubClient {
	getAuthenticatedApp(signal?: AbortSignal): Promise<GitHubAppIdentity>
	getWebhookConfig(signal?: AbortSignal): Promise<GitHubAppWebhookConfig>
	updateWebhookConfig(input: GitHubAppWebhookUpdate): Promise<GitHubAppWebhookConfig>
	resolveOrganizationInstallation(organization: string, signal?: AbortSignal): Promise<GitHubAppInstallation | null>
	resolveRepositoryInstallation(owner: string, repository: string, signal?: AbortSignal): Promise<GitHubAppInstallation | null>
	mintRepositoryToken(input: GitHubRepositoryTokenRequest): Promise<GitHubInstallationToken>
}

export type SourceGitHubClientFactory = (credential: GitHubAppCredential) => Promise<SourceGitHubClient>

/** Production always talks to `api.github.com`; only the transport is injectable. */
export function gitHubAppClientFactory(fetch?: GitHubAppFetch): SourceGitHubClientFactory {
	return (credential) =>
		GitHubAppClient.create({
			appId: credential.appId,
			privateKeyPem: credential.privateKeyPem,
			...(fetch === undefined ? {} : { fetch }),
		})
}

export interface GitHubSourceCredentialRequest extends SourcePrivateBinding {
	readonly repository: SourceRepository
	readonly signal: AbortSignal
}

/** Mints a repository-scoped installation token for exactly one bound connection. */
export interface GitHubSourceCredentials {
	repositoryToken(input: GitHubSourceCredentialRequest): Promise<string>
}

export interface VaultGitHubCredentialsOptions {
	readonly createClient?: SourceGitHubClientFactory
}

/** Reads the vault on every operation; there is no in-memory key cache to go stale or leak. */
export function vaultGitHubCredentials(env: Env, options: VaultGitHubCredentialsOptions = {}): GitHubSourceCredentials {
	const createClient = options.createClient ?? gitHubAppClientFactory()
	return {
		async repositoryToken(input) {
			const connection = await env.REPOSITORIES.githubConnections.getConnectionByBinding(input.connectionId, input.installationId)
			// The binding names one connection; a mismatch never falls back to another (ADR-0029).
			if (connection === null || connection.installationAccountLogin.toLowerCase() !== input.repository.owner.toLowerCase()) {
				throw new SourceFailure('installation_not_found', 'credentials')
			}
			let client: SourceGitHubClient
			try {
				const credential = await readGitHubAppCredential(await openVault(env), connection.appCredentialRef, connection.connectionId)
				if (credential.appId !== connection.appId) throw new Error('GitHub App credential does not match its connection')
				client = await createClient(credential)
			} catch {
				throw new SourceFailure('credentials_invalid', 'credentials')
			}
			try {
				const token = await client.mintRepositoryToken({
					installationId: connection.installationId,
					owner: input.repository.owner,
					repository: input.repository.name,
					signal: input.signal,
				})
				return token.token
			} catch (error) {
				if (input.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw cancelled('credentials')
				throw new SourceFailure('internal', 'credentials')
			}
		},
	}
}
