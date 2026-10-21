// What an SPA mount answers at `<prefix>/__fabrika-config.json`: the browser's Operations settings (DSN, release and
// environment) and the public values the contract names, and nothing else of the environment.

import type { ContractArtifact } from '@fabrika/auth-core'
import type { CapturedEnvironment } from './environment'

export interface BrowserConfig {
	/** The Operations ingest DSN (a public key), or `null` without one. */
	readonly dsn: string | null
	readonly release: string | null
	/** `FABRIKA_ENVIRONMENT`, which the page's error reports carry, or `null` when unset. */
	readonly environment: string | null
	/**
	 * Every public procedure challenge's site key, and the variables the mount lists in `public`, by variable name. Absent when
	 * there is none, so the file of an application without them holds the three Operations values only.
	 */
	readonly public?: Readonly<Record<string, string>>
}

/**
 * The browser config of each SPA mount, by mount name: the Operations settings, and the public variables the contract
 * names. A named variable that is not set is a boot problem.
 */
export function browserConfigs(
	artifact: ContractArtifact,
	environment: CapturedEnvironment,
	operations: Pick<BrowserConfig, 'dsn' | 'release'>,
	problems: string[],
): ReadonlyMap<string, BrowserConfig> {
	// A value is served as the environment holds it; only a blank one counts as unset.
	const valueOf = (name: string): string | null => {
		const value: unknown = environment.application[name]
		return typeof value === 'string' && value.trim() !== '' ? value : null
	}
	const siteKeys: Record<string, string> = {}
	for (const [id, procedure] of Object.entries(artifact.procedures ?? {})) {
		const challenge = procedure.challenge
		// Only Turnstile's widget needs a key in the page; ALTCHA's fetches its challenge from the application.
		if (challenge?.provider !== 'turnstile' || challenge.siteKey === undefined) continue
		const value = valueOf(challenge.siteKey)
		if (value === null) problems.push(`procedure '${id}' names its ${challenge.provider} site key in ${challenge.siteKey}, which is not set`)
		else siteKeys[challenge.siteKey] = value
	}
	const configs = new Map<string, BrowserConfig>()
	for (const [name, mount] of Object.entries(artifact.mounts)) {
		if (mount.kind !== 'spa') continue
		const own: Record<string, string> = {}
		for (const variable of mount.public ?? []) {
			const value = valueOf(variable)
			if (value === null) problems.push(`mount '${name}' serves the public variable ${variable}, which is not set`)
			else own[variable] = value
		}
		const served = { ...siteKeys, ...own }
		const reporting = { ...operations, environment: environment.framework['FABRIKA_ENVIRONMENT']?.trim() || null }
		configs.set(name, Object.freeze(Object.keys(served).length === 0 ? reporting : { ...reporting, public: Object.freeze(served) }))
	}
	return configs
}
