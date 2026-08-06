// Composing the platform's three apps with whatever else the installation's one proxy already fronts.
//
// ── Why this is a MERGE and not a write ───────────────────────────────────────────────────────────
//
// On the `light` tier an application shares the platform's project and therefore the platform proxy's
// single `FABRIKA_PROXY_MANIFEST_JSON`. The live document on `fabrika-test` carries a fourth app —
// `notes` → `notesapi:3000` on listener 8084 — beside the three platform ones. `platformProxyManifest`
// deliberately emits only the platform apps (it is generated from the platform's own gate modules and
// knows nothing about applications), so writing it alone would DELETE every application entry and take
// the deployed applications offline at the next proxy build.
//
// So: read the live value, compose, write. That composition is this command's job and nothing else's.
//
// ── What happens to an entry the platform does not know about ─────────────────────────────────────
//
// Carried through byte-for-byte, in its live order, after the platform apps — with ONE exception. A
// host belongs to exactly one app (`parseProxyManifest` refuses two apps claiming one, and rightly:
// route order would otherwise decide which app answers). The platform's three listeners are addresses
// the platform OWNS, so a live entry standing on one of them is superseded rather than carried, and
// the deploy says so out loud.
//
// That exception is not hypothetical: WU1 corrected IAM's app id from `iam-local` to `iam`, so the
// live document's `iam-local` claims the platform's own IAM host under a name the platform no longer
// uses. Carrying it would produce a manifest `parseProxyManifest` rejects, which the proxy build then
// fails on — a fail-closed outcome, but a needlessly confusing one.
//
// Superseding is itself CLOSED: the dropped host stops resolving to anything, it does not fall through
// to some other app. A genuinely misplaced application therefore goes dark and is reported, instead of
// quietly being served by the console.

import { parseProxyManifest, parseProxyManifestJson, type ProxyManifest } from '@fabrika/proxy-contract'

/** The composed document plus what happened to every live entry that was not the platform's. */
export interface MergedProxyManifest {
	readonly manifest: ProxyManifest
	/** App ids carried through from the live manifest, in their live order. */
	readonly carried: readonly string[]
	/** Live entries the platform's own listeners displaced, with the host that collided. */
	readonly superseded: readonly { readonly id: string; readonly host: string }[]
}

/**
 * Compose the platform's apps with the application entries already in a live manifest.
 *
 * `live` is `null` when the proxy carries no manifest yet (a first deploy) — the result is then the
 * platform document alone. An UNPARSEABLE live value is a different thing entirely and throws: it may
 * be a manifest this build is too old to read, and silently replacing it would drop applications this
 * code cannot see. Refusing is what keeps "must not take a deployed app offline" true in the one case
 * where the deploy genuinely cannot tell.
 */
export const mergePlatformProxyManifest = (platform: ProxyManifest, live: ProxyManifest | null): MergedProxyManifest => {
	const platformIds = new Set(platform.apps.map((app) => app.id))
	const platformHosts = new Set(platform.apps.flatMap((app) => app.hosts))
	const carried: string[] = []
	const superseded: { id: string; host: string }[] = []
	const apps = [...platform.apps]
	for (const app of live?.apps ?? []) {
		if (platformIds.has(app.id)) {
			continue
		}
		const collision = app.hosts.find((host) => platformHosts.has(host))
		if (collision !== undefined) {
			superseded.push({ id: app.id, host: collision })
			continue
		}
		carried.push(app.id)
		apps.push(app)
	}
	// Back through the proxy's own parser, so a duplicate host between two APPLICATION entries — which
	// this function cannot fix — is refused here rather than at the proxy's next build.
	const manifest = parseProxyManifest({ apps })
	if (manifest === null) {
		throw new Error('the composed proxy manifest is not one the proxy would accept — two application entries claim one host')
	}
	return { manifest, carried, superseded }
}

/**
 * The live manifest a proxy service currently carries.
 *
 * Absent means "no manifest yet". Present-but-unparseable throws: see `mergePlatformProxyManifest`.
 */
export const readLiveProxyManifest = (value: string | undefined): ProxyManifest | null => {
	if (value === undefined || value.trim() === '') {
		return null
	}
	const manifest = parseProxyManifestJson(value)
	if (manifest === null) {
		throw new Error(
			`the proxy's current FABRIKA_PROXY_MANIFEST_JSON cannot be parsed by this build — refusing to replace a document whose `
				+ 'application entries cannot be read',
		)
	}
	return manifest
}
