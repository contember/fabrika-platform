import { ZEROPS_SHARED_POSTGRES_CONNECTION_STRING } from './namespace'
export { zeropsSharedServiceHostname, zeropsSharedServicePrefix } from './service-names'
import { APP_PROVIDER, isProviderAuthoredApp, type ProviderAuthoredApp } from '@fabrika/provider-contract'
import type { ZeropsAppConfig, ZeropsSharedPostgresBinding } from './types'

/** Declare consumption of the namespace-owned `postgres` service without resolving its credential. */
export const useSharedPostgres = (): ZeropsSharedPostgresBinding => ({
	resourceKey: 'service:postgres',
	hostname: 'postgres',
	connectionString: ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
})

/** Provider-specific authoring identity with complete Zerops contextual typing. */
export type ZeropsAuthoredAppConfig = ZeropsAppConfig & ProviderAuthoredApp<'zerops'>

export const defineApp = (config: ZeropsAppConfig): ZeropsAuthoredAppConfig => {
	if (config.id.trim() === '') {
		throw new Error('defineApp: `id` is required and must be a non-empty string')
	}
	return { ...config, [APP_PROVIDER]: 'zerops' }
}

const property = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined

export const isZeropsAppConfig = (value: unknown): value is ZeropsAuthoredAppConfig => {
	const id = property(value, 'id')
	const target = property(value, 'target')
	return isProviderAuthoredApp(value, 'zerops')
		&& typeof id === 'string'
		&& id.trim() !== ''
		&& property(target, 'platform') === 'zerops'
		&& typeof property(target, 'services') === 'function'
}
