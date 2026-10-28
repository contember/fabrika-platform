/**
 * The 0.9.0 prereleases on npm that the release floors (`releaseFrom`) read as older than `0.9.0-dev.5`: their object
 * runs in the Durable Object with the ops channel but, to the platform, without the maintenance barrier, the alarm or
 * the segment cap. `cloudflare.3` carries those features, and every channel release sorts below the floor
 * ([backlog 240](../../../../docs/backlog/240-channel-prereleases-sort-below-the-release-floors.md)), so its
 * applications run as the older ones do. A platform upgrade must keep deploying each of them as it ran (ADR-0062).
 */
export const PUBLISHED_PRERELEASES: readonly string[] = [
	'0.9.0-dev.0',
	'0.9.0-dev.1',
	'0.9.0-dev.2',
	'0.9.0-dev.3',
	'0.9.0-dev.4',
	'0.9.0-cloudflare.1',
	'0.9.0-cloudflare.2',
	'0.9.0-cloudflare.3',
]
