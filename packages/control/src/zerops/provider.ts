// ── Why these variables are named `FABRIKA_ZEROPS_*` ───────────────────────────────────────────────
//
// They used to be `ZEROPS_*`, which reads better and is unusable. Zerops RESERVES that prefix for its
// own generated variables and refuses to store any custom one:
//
//   400 userDataZeropsPrefixForbidden
//   Custom env variables with 'ZEROPS_' prefix are forbidden.
//
// So the control plane could not be configured on the one platform whose name those variables carried —
// the env API rejects the write, and there is no other channel for a per-installation secret (ADR-0004
// forbids project-level env, and a committed `zerops.yaml` must not carry values). Verified live.
//
// `FABRIKA_ZEROPS_*` is the only name these carry (ADR-0024, ADR-0024). The Cloudflare composition and
// the local stack read the same code and are not subject to the platform's reservation, so one name
// works everywhere.

import type { GitHubAppFetch } from '@fabrika/github-app'
import type { ControlProvider } from '@fabrika/provider-contract'
import {
	createZeropsControlProvider,
	decodeZeropsNamespaceProxySource,
	isZeropsUploadDestination,
	ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES,
	type ZeropsNamespaceProxySource,
	type ZeropsSourcePort,
	ZeropsSourceRateLimitedError,
} from '@fabrika/provider-zerops'
import type { Env } from '../env'
import { gitHubAppClientFactory, vaultGitHubCredentials } from '../github/connections/credentials'
import { createGitHubSource, type GitHubMetadataFetch, type SourceDownloadFetch, SourceRateLimited, type SourceUploadFetch } from '../github/source'
import type { CommitSource } from '../github/source/commit-files'
import { OLDER_PROXY_READERS } from './older-proxies'

const required = (source: Record<string, string | undefined>, name: string): string => {
	const value = source[name]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is required by the Zerops provider`)
	}
	return value
}

export interface ZeropsNamespaceProcessConfig {
	readonly clientId: string
	readonly proxySource: ZeropsNamespaceProxySource
	readonly iamUrl: string
	readonly iamKey: string
}

/** Read the installation-specific namespace inputs without hiding any behind provider defaults. */
export const zeropsNamespaceProcessConfig = (
	source: Record<string, string | undefined>,
): ZeropsNamespaceProcessConfig => ({
	clientId: required(source, 'FABRIKA_ZEROPS_CLIENT_ID'),
	proxySource: readProxySource(required(source, 'FABRIKA_ZEROPS_PROXY_SOURCE_JSON')),
	iamUrl: required(source, 'FABRIKA_ZEROPS_PROXY_IAM_URL'),
	iamKey: required(source, 'FABRIKA_ZEROPS_PROXY_IAM_KEY'),
})

function readProxySource(raw: string): ZeropsNamespaceProxySource {
	try {
		const value: unknown = JSON.parse(raw)
		return decodeZeropsNamespaceProxySource(value)
	} catch {
		throw new Error(
			'FABRIKA_ZEROPS_PROXY_SOURCE_JSON must contain a valid immutable proxy source; upgrade the installation configuration before starting Control',
		)
	}
}

/** Transport seams only the local stack and tests inject; the GitHub and Zerops origins stay fixed (ADR-0029). */
export interface GitHubSourceSeams {
	readonly metadataFetch?: GitHubMetadataFetch
	readonly downloadFetch?: SourceDownloadFetch
	readonly uploadFetch?: SourceUploadFetch
	readonly githubAppFetch?: GitHubAppFetch
}

/**
 * Control's in-process source: keys from the vault, the repository-root `zerops.yaml` as the descriptor. The provider's
 * port and a run's snapshot read share one archive reader. A rate limit leaves the port as the provider's own error,
 * which keeps a namespace mutation retryable.
 */
export function zeropsGitHubSources(env: Env, seams: GitHubSourceSeams = {}): { readonly port: ZeropsSourcePort; readonly commits: CommitSource } {
	const source = createGitHubSource({
		credentials: vaultGitHubCredentials(env, { createClient: gitHubAppClientFactory(seams.githubAppFetch) }),
		descriptor: { path: 'zerops.yaml', maxBytes: ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES },
		isUploadDestination: isZeropsUploadDestination,
		...(seams.metadataFetch === undefined ? {} : { metadataFetch: seams.metadataFetch }),
		...(seams.downloadFetch === undefined ? {} : { downloadFetch: seams.downloadFetch }),
		...(seams.uploadFetch === undefined ? {} : { uploadFetch: seams.uploadFetch }),
	})
	return {
		port: {
			resolve: (input) => providerRateLimit(() => source.resolve(input)),
			upload: (input) => providerRateLimit(() => source.upload(input)),
		},
		commits: source.commits,
	}
}

async function providerRateLimit<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation()
	} catch (error) {
		if (error instanceof SourceRateLimited) throw new ZeropsSourceRateLimitedError(error.message)
		throw error
	}
}

/** Compose the only provider available in the process installation. */
export function zeropsControlProvider(
	env: Env,
	source: Record<string, string | undefined>,
	sourcePort: ZeropsSourcePort,
): ControlProvider {
	const namespaces = zeropsNamespaceProcessConfig(source)
	return createZeropsControlProvider({
		accessToken: required(source, 'FABRIKA_ZEROPS_ACCESS_TOKEN'),
		source: sourcePort,
		...((): { apiBaseUrl?: string } => {
			const apiBaseUrl = source['FABRIKA_ZEROPS_API_BASE_URL']
			return apiBaseUrl === undefined ? {} : { apiBaseUrl }
		})(),
		...(env.FABRIKA_IAM_ISSUER === undefined ? {} : { propustkaUrl: env.FABRIKA_IAM_ISSUER }),
		...(env.FABRIKA_IAM_PROVISIONING_KEY === undefined
			? {}
			: { adminKey: env.FABRIKA_IAM_PROVISIONING_KEY }),
		namespaces: { ...namespaces, olderProxies: OLDER_PROXY_READERS },
	})
}
