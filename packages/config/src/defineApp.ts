import type { AppConfigBase } from '@fabrika/provider-contract'

/**
 * Provider-neutral identity helper. Provider packages may layer a narrower authoring function over
 * it while preserving their complete inferred config type.
 */
export const defineApp = <TConfig extends AppConfigBase>(config: TConfig): TConfig => {
	if (typeof config.id !== 'string' || config.id.trim() === '') {
		throw new Error('defineApp: `id` is required and must be a non-empty string')
	}
	return config
}
