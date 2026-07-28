import type { AnyAppConfig, AppTarget } from './types'

/**
 * Resolve an app config to its discriminated deploy target — the ONE place the two authoring forms are
 * normalized, so nothing downstream branches on config SHAPE.
 *
 * A Cloudflare app declares a bare `resources` (the historical surface); that IS the `cloudflare` arm, so
 * it is lifted into one here rather than every consumer knowing the shorthand. A Zerops app declares
 * `target` explicitly, because there is no oblaka `Worker` for the shorthand to carry.
 */
export const appTarget = (config: AnyAppConfig): AppTarget => {
	if (config.target === undefined) {
		return { platform: 'cloudflare', resources: config.resources }
	}
	return config.target
}

/** The platform an app config targets — the discriminant that selects its `DeployDriver`. */
export const appPlatform = (config: AnyAppConfig): AppTarget['platform'] => appTarget(config).platform
