/**
 * The 0.9.0 prereleases on npm whose object runs in the Durable Object with the ops channel but without the maintenance
 * barrier, the alarm or the segment cap. A platform upgrade must keep deploying each of them as it ran (ADR-0062).
 */
export const PUBLISHED_PRERELEASES: readonly string[] = [
	'0.9.0-dev.0',
	'0.9.0-dev.1',
	'0.9.0-dev.2',
	'0.9.0-dev.3',
	'0.9.0-dev.4',
	'0.9.0-cloudflare.1',
	'0.9.0-cloudflare.2',
]
