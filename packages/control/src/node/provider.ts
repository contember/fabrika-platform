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
// `FABRIKA_ZEROPS_*` is the only name these carry (ADR-0018, ADR-0024). The Cloudflare composition and
// the local stack read the same code and are not subject to the platform's reservation, so one name
// works everywhere.

import { deploy } from '@fabrika/engine'
import type { ControlProvider } from '@fabrika/provider-contract'
import {
	createZeropsApi,
	createZeropsControlProvider,
	createZeropsSourceConnectionAdmin,
	type SourceConnectionAdmin,
	SourceConnectionAdminError,
	type SourceConnectionZeropsApi,
	type ZeropsSourceClient,
	type ZeropsSourceCredentialManager,
} from '@fabrika/provider-zerops'
import type { Env } from '../env'
import { repositories } from '../services'
import { HttpZeropsSourceClient } from './source-client'
import { syncZeropsProxy } from './zerops-proxy'

const required = (source: Record<string, string | undefined>, name: string): string => {
	const value = source[name]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is required by the Zerops provider`)
	}
	return value
}

export interface ZeropsNamespaceProcessConfig {
	readonly clientId: string
	readonly proxyBuildFromGit: string
	readonly iamUrl: string
	readonly iamKey: string
}

/** Read the installation-specific namespace inputs without hiding any behind provider defaults. */
export const zeropsNamespaceProcessConfig = (
	source: Record<string, string | undefined>,
): ZeropsNamespaceProcessConfig => ({
	clientId: required(source, 'FABRIKA_ZEROPS_CLIENT_ID'),
	proxyBuildFromGit: required(source, 'FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT'),
	iamUrl: required(source, 'FABRIKA_ZEROPS_PROXY_IAM_URL'),
	iamKey: required(source, 'FABRIKA_ZEROPS_PROXY_IAM_KEY'),
})

/** Construct and validate the one source transport shared by Zerops provider and onboarding. */
export function zeropsSourceClient(source: Record<string, string | undefined>): HttpZeropsSourceClient {
	return new HttpZeropsSourceClient({
		origin: required(source, 'FABRIKA_ZEROPS_SOURCE_URL'),
		rpcKey: required(source, 'FABRIKA_ZEROPS_SOURCE_RPC_KEY'),
	})
}

/** Compose the privileged installation connection seam without exposing it to provider-neutral core. */
export function zeropsSourceConnectionAdmin(
	source: Record<string, string | undefined>,
	sourceClient: ZeropsSourceCredentialManager = zeropsSourceClient(source),
	api: SourceConnectionZeropsApi = createZeropsApi({
		token: required(source, 'FABRIKA_ZEROPS_ACCESS_TOKEN'),
		...((): { baseUrl?: string } => {
			const baseUrl = source['FABRIKA_ZEROPS_API_BASE_URL']
			return baseUrl === undefined ? {} : { baseUrl }
		})(),
	}),
): SourceConnectionAdmin {
	const projectId = source['FABRIKA_ZEROPS_PROJECT_ID']?.trim()
	if (projectId === undefined || projectId === '') {
		return {
			inspect: () => Promise.resolve({ state: 'unavailable' }),
			adoptExisting: () => Promise.reject(new SourceConnectionAdminError('invalid_configuration')),
			activate: () => Promise.reject(new SourceConnectionAdminError('invalid_configuration')),
			activateV2: () => Promise.reject(new SourceConnectionAdminError('invalid_configuration')),
			status: () => Promise.resolve({ state: 'unavailable' }),
			statusV2: () => Promise.resolve({ state: 'unavailable' }),
			configureWebhook: () => Promise.reject(new SourceConnectionAdminError('invalid_configuration')),
			verifyInstallations: () => Promise.reject(new SourceConnectionAdminError('invalid_configuration')),
		}
	}
	return createZeropsSourceConnectionAdmin({
		api,
		source: sourceClient,
		projectId,
	})
}

/** Compose the only provider available in the process installation. */
export function zeropsControlProvider(
	env: Env,
	source: Record<string, string | undefined>,
	sourceClient: ZeropsSourceClient = zeropsSourceClient(source),
): ControlProvider {
	const namespaces = zeropsNamespaceProcessConfig(source)
	return createZeropsControlProvider({
		accessToken: required(source, 'FABRIKA_ZEROPS_ACCESS_TOKEN'),
		source: sourceClient,
		...((): { apiBaseUrl?: string } => {
			const apiBaseUrl = source['FABRIKA_ZEROPS_API_BASE_URL']
			return apiBaseUrl === undefined ? {} : { apiBaseUrl }
		})(),
		...(env.FABRIKA_IAM_ISSUER === undefined ? {} : { propustkaUrl: env.FABRIKA_IAM_ISSUER }),
		...(env.FABRIKA_IAM_PROVISIONING_KEY === undefined
			? {}
			: { adminKey: env.FABRIKA_IAM_PROVISIONING_KEY }),
		namespaces,
		execute: async (provider, run) => {
			const result = await deploy(provider, run)
			return { state: result.status === 'succeeded' ? 'succeeded' : 'failed' }
		},
		beforeDeploy: async (input) => {
			await syncZeropsProxy({
				db: repositories(env).registry,
				api: input.api,
				namespaceId: input.namespaceId,
				proxyServiceId: input.target.proxyServiceId,
				proxyBuildFromGit: input.target.proxyBuildFromGit,
				iamUrl: namespaces.iamUrl,
				iamKey: namespaces.iamKey,
				signal: input.signal,
			})
		},
	})
}
