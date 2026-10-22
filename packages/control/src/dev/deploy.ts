// What a deploy of a `dev` environment adds to an ordinary one (ADR-0062: protocol, changed additively): the framework
// release must ship the launcher, and the environment gets the `source` receiver's address and key.

import { platformTransportVariables } from '@fabrika/auth-core'
import { compareReleases, FRAMEWORK_PACKAGE, parseRelease, type Release } from '../approval/readers'

/** The first framework release whose `@fabrika/app/dev` holds the launcher a `dev` environment starts. */
export const DEV_LAUNCHER_SINCE: Release = { text: '0.9.0', major: 0, minor: 9, patch: 0 }

/**
 * Why the approved snapshot's framework release cannot run a `dev` environment, or null when it can. A snapshot without
 * a release was read before Control recorded one, so it is an older application.
 */
export function devLauncherRefusal(framework: string | undefined): string | null {
	const release = framework === undefined ? null : parseRelease(framework)
	if (release !== null && compareReleases(release, DEV_LAUNCHER_SINCE) >= 0) return null
	return `a dev environment starts the dev launcher of ${FRAMEWORK_PACKAGE} ${DEV_LAUNCHER_SINCE.text} or newer, and the application pins ${
		framework ?? 'an older release'
	}; raise the pin, or use the ordinary loop (deploy_stage)`
}

/**
 * Where the launcher reaches the receiver: Control's public origin, as the mail relay. Throws the refusal when Control
 * names none.
 */
export function platformSourceOrigin(controlOrigin: string | undefined): string {
	if (controlOrigin === undefined) {
		throw new Error(
			'a dev environment follows its workspace through Control, and Control names no public origin for it (it needs FABRIKA_CONTROL_DOMAIN)',
		)
	}
	return controlOrigin
}

/** The receiver's variables; a dry run issues no key. */
export function platformSourceEnvironment(origin: string, key: string | null): Readonly<Record<string, string>> {
	const variables = platformTransportVariables('source')
	return { [variables.url]: origin, ...(key === null ? {} : { [variables.key]: key }) }
}
