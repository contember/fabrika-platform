import type { AppConfigBase } from '@fabrika/provider-contract'
import type { Worker } from 'oblaka-iac'

/** Inputs used to materialize one environment's Cloudflare resource graph. */
export interface ResourceContext {
	readonly env: string
	readonly domain?: string
}

/** A Cloudflare app config loaded from `fabrika.config.ts` inside the runner checkout. */
export interface CloudflareAppConfig extends AppConfigBase {
	readonly resources: (ctx: ResourceContext) => Worker
}

/** Preserve literal inference while validating the provider's required app id. */
export function defineApp(config: CloudflareAppConfig): CloudflareAppConfig {
	if (typeof config.id !== 'string' || config.id.trim() === '') {
		throw new Error('defineApp: `id` is required and must be a non-empty string')
	}
	return config
}

/** Narrow an imported module default without trusting code from the checkout. */
export const isCloudflareAppConfig = (value: unknown): value is CloudflareAppConfig =>
	typeof value === 'object'
	&& value !== null
	&& 'id' in value
	&& typeof value.id === 'string'
	&& value.id.trim() !== ''
	&& 'resources' in value
	&& typeof value.resources === 'function'
