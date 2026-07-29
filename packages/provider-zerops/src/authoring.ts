import type { ZeropsAppConfig } from './types'

/** Provider-specific authoring identity with complete Zerops contextual typing. */
export const defineApp = (config: ZeropsAppConfig): ZeropsAppConfig => {
	if (config.id.trim() === '') {
		throw new Error('defineApp: `id` is required and must be a non-empty string')
	}
	return config
}
