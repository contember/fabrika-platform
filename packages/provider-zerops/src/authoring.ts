import { ZEROPS_SHARED_POSTGRES_CONNECTION_STRING } from './namespace'
export { zeropsSharedServiceHostname, zeropsSharedServicePrefix } from './service-names'
import type { ZeropsAppConfig, ZeropsSharedPostgresBinding } from './types'

/** Declare consumption of the namespace-owned `postgres` service without resolving its credential. */
export const useSharedPostgres = (): ZeropsSharedPostgresBinding => ({
	resourceKey: 'service:postgres',
	hostname: 'postgres',
	connectionString: ZEROPS_SHARED_POSTGRES_CONNECTION_STRING,
})

/** Provider-specific authoring identity with complete Zerops contextual typing. */
export const defineApp = (config: ZeropsAppConfig): ZeropsAppConfig => {
	if (config.id.trim() === '') {
		throw new Error('defineApp: `id` is required and must be a non-empty string')
	}
	return config
}
