// Composing the platform's three apps with whatever else the installation's one proxy already fronts.
//
// ── Why this is a MERGE and not a write ───────────────────────────────────────────────────────────
//
// On the `light` tier an application can share the platform's project and therefore the platform proxy.
// Its entry is held by the operator in the proxy's `FABRIKA_PROXY_MANIFEST_JSON` variable — on `fabrika-test`
// a fourth app, `notes` → `notesapi:3000` on listener 8084, beside the three platform ones. The variable is
// no longer the carrier: the manifest travels as the data file of the proxy's build archive (ADR-0045), and
// nothing in fabrika writes the variable any more; releases before that wrote the whole composed document
// into it, which is why it may still hold platform entries. `platformProxyManifest` deliberately emits only
// the platform apps (it is generated from the platform's own service contracts and knows nothing about
// applications), so building it alone would DELETE every application entry and take the deployed
// applications offline.
//
// So: read the variable, compose, and ship the result in the archive. That composition is this command's
// job and nothing else's.
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

import { FABRIKA_PROXY_MANIFEST_JSON, findDuplicateProxyHost, parseProxyManifestJson, type ProxyManifest } from '@fabrika/proxy-core/manifest'
import type { ZeropsServiceEnv } from '../index'

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
	// Both inputs are already parsed manifests, so a duplicate host is the one invariant composing can break.
	// A duplicate host between two APPLICATION entries — which this function cannot fix — is refused
	// here rather than at the proxy's next build.
	if (findDuplicateProxyHost(apps) !== null) {
		throw new Error('the composed proxy manifest is not one the proxy would accept — two application entries claim one host')
	}
	return { manifest: { apps }, carried, superseded }
}

/**
 * The application entries the operator holds in the platform proxy's variable, as a manifest.
 *
 * Absent means "none". Present-but-unparseable throws: see `mergePlatformProxyManifest`. So
 * does a SENSITIVE record, which an older release wrote: Zerops will not hand its value back.
 */
export const readLiveProxyManifest = (record: ZeropsServiceEnv | undefined): ProxyManifest | null => {
	if (record === undefined) {
		return null
	}
	if (record.sensitive) {
		throw new Error(
			`the proxy's ${FABRIKA_PROXY_MANIFEST_JSON} is stored as a SENSITIVE variable, which Zerops returns as \`REDACTED\`, so the `
				+ 'application entries it may carry cannot be read and are not replaced. A release before this one wrote it that way. '
				+ 'Re-save it in the Zerops GUI as a non-sensitive variable with the same value, then run this again',
		)
	}
	const value = record.content
	if (value.trim() === '') {
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
