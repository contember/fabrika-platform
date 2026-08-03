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
// `FABRIKA_ZEROPS_*` is the canonical name under ADR-0018, with the old name kept as a deprecated legacy
// alias: the Cloudflare composition and the local stack read the same code and are not subject to the
// platform's reservation, so an existing installation keeps booting while it renames.

import { deploy } from '@fabrika/engine'
import { environmentAliases } from '@fabrika/platform'
import type { ControlProvider } from '@fabrika/provider-contract'
import { createZeropsControlProvider } from '@fabrika/provider-zerops'
import type { Env } from '../env'
import { repositories } from '../services'
import { syncZeropsProxy } from './zerops-proxy'

/** Canonical-first read of one renamed variable, warning once when the legacy name is what answered. */
const alias = (
	source: Record<string, string | undefined>,
	canonical: string,
	legacy: string,
): string | undefined => environmentAliases.read(source, { canonical, legacy })

const requiredAlias = (source: Record<string, string | undefined>, canonical: string, legacy: string): string => {
	const value = alias(source, canonical, legacy)
	if (value === undefined || value.trim() === '') {
		throw new Error(`${canonical} is required by the Zerops provider`)
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
	clientId: requiredAlias(source, 'FABRIKA_ZEROPS_CLIENT_ID', 'ZEROPS_CLIENT_ID'),
	proxyBuildFromGit: requiredAlias(source, 'FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT', 'ZEROPS_PROXY_BUILD_FROM_GIT'),
	iamUrl: requiredAlias(source, 'FABRIKA_ZEROPS_PROXY_IAM_URL', 'ZEROPS_PROXY_IAM_URL'),
	iamKey: requiredAlias(source, 'FABRIKA_ZEROPS_PROXY_IAM_KEY', 'ZEROPS_PROXY_IAM_KEY'),
})

/** Compose the only provider available in the process installation. */
export function zeropsControlProvider(
	env: Env,
	source: Record<string, string | undefined>,
): ControlProvider {
	return createZeropsControlProvider({
		accessToken: requiredAlias(source, 'FABRIKA_ZEROPS_ACCESS_TOKEN', 'ZEROPS_ACCESS_TOKEN'),
		...((): { apiBaseUrl?: string } => {
			const apiBaseUrl = alias(source, 'FABRIKA_ZEROPS_API_BASE_URL', 'ZEROPS_API_BASE_URL')
			return apiBaseUrl === undefined ? {} : { apiBaseUrl }
		})(),
		...(env.FABRIKA_IAM_URL === undefined ? {} : { propustkaUrl: env.FABRIKA_IAM_URL }),
		...(env.FABRIKA_IAM_PROVISIONING_KEY === undefined
			? {}
			: { adminKey: env.FABRIKA_IAM_PROVISIONING_KEY }),
		namespaces: zeropsNamespaceProcessConfig(source),
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
				signal: input.signal,
			})
		},
	})
}
