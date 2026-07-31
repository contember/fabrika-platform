/** A runtime-neutral environment shape containing one canonical/legacy name pair. */
export type EnvironmentAliasValues<Canonical extends string, Legacy extends string> = Partial<
	Record<Canonical | Legacy, string | undefined>
>

export type EnvironmentAliasWarning = (message: string) => void

export interface EnvironmentAliasReader {
	read<Canonical extends string, Legacy extends string>(
		env: EnvironmentAliasValues<Canonical, Legacy>,
		alias: { canonical: Canonical; legacy: Legacy },
	): string | undefined
}

/** Create an isolated canonical-first reader. The warning callback never receives environment values. */
export function createEnvironmentAliasReader(warn: EnvironmentAliasWarning): EnvironmentAliasReader {
	const warnedLegacyNames = new Set<string>()
	return {
		read(env, alias) {
			const canonical = env[alias.canonical]
			const legacy = env[alias.legacy]
			if (legacy !== undefined && !warnedLegacyNames.has(alias.legacy)) {
				warnedLegacyNames.add(alias.legacy)
				warn(
					canonical === undefined
						? `${alias.legacy} is deprecated; use ${alias.canonical} instead.`
						: `${alias.legacy} is deprecated and was ignored because ${alias.canonical} is set.`,
				)
			}
			return canonical ?? legacy
		},
	}
}

/** Process-wide reader used by runtime composition boundaries. */
export const environmentAliases = createEnvironmentAliasReader((message) => console.warn(message))
