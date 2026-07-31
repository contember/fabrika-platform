import { deploy } from '@fabrika/engine'
import type { ControlProvider } from '@fabrika/provider-contract'
import { createZeropsControlProvider } from '@fabrika/provider-zerops'
import type { Env } from '../env'
import { repositories } from '../services'
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
	clientId: required(source, 'ZEROPS_CLIENT_ID'),
	proxyBuildFromGit: required(source, 'ZEROPS_PROXY_BUILD_FROM_GIT'),
	iamUrl: required(source, 'ZEROPS_PROXY_IAM_URL'),
	iamKey: required(source, 'ZEROPS_PROXY_IAM_KEY'),
})

/** Compose the only provider available in the process installation. */
export function zeropsControlProvider(
	env: Env,
	source: Record<string, string | undefined>,
): ControlProvider {
	return createZeropsControlProvider({
		accessToken: required(source, 'ZEROPS_ACCESS_TOKEN'),
		...(source['ZEROPS_API_BASE_URL'] === undefined
			? {}
			: { apiBaseUrl: source['ZEROPS_API_BASE_URL'] }),
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
