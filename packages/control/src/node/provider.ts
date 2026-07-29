import { deploy } from '@fabrika/engine'
import type { ControlProvider } from '@fabrika/provider-contract'
import { createZeropsControlProvider } from '@fabrika/provider-zerops'
import type { Env } from '../env'
import { db } from '../services'
import { syncZeropsProxy } from '../zerops-proxy'

const required = (source: Record<string, string | undefined>, name: string): string => {
	const value = source[name]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is required by the Zerops provider`)
	}
	return value
}

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
		...(env.PROPUSTKA_URL === undefined ? {} : { propustkaUrl: env.PROPUSTKA_URL }),
		...(env.PROPUSTKA_PROVISIONING_KEY === undefined
			? {}
			: { adminKey: env.PROPUSTKA_PROVISIONING_KEY }),
		execute: async (provider, run) => {
			const result = await deploy(provider, run)
			return { state: result.status === 'succeeded' ? 'succeeded' : 'failed' }
		},
		beforeDeploy: async (input) => {
			await syncZeropsProxy({
				db: db(env),
				api: input.api,
				projectId: input.target.projectId,
				signal: input.signal,
				...(source['ZEROPS_PROXY_SERVICE_NAME'] === undefined
					? {}
					: { proxyServiceName: source['ZEROPS_PROXY_SERVICE_NAME'] }),
			})
		},
	})
}
