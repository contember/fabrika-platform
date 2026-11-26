/** An entry of an application's configuration: a secret or a variable, on one environment or (`env: null`) all of them. */
export interface LayeredEntry {
	readonly name: string
	readonly env: string | null
}

/** One name across its layers: the value for all environments, and each environment's own. */
export interface LayeredName<T extends LayeredEntry> {
	readonly name: string
	readonly all: T | null
	readonly byEnv: ReadonlyMap<string, T>
}

/** What an environment reads for a name: its own entry, the one for all environments, or nothing. */
export type LayerCell<T extends LayeredEntry> =
	| { readonly kind: 'own'; readonly entry: T }
	| { readonly kind: 'inherits'; readonly entry: T }
	| { readonly kind: 'missing' }

/** The entries grouped one row per name, in name order. */
export function layersByName<T extends LayeredEntry>(entries: readonly T[]): LayeredName<T>[] {
	const names = [...new Set(entries.map((entry) => entry.name))].sort()
	return names.map((name) => {
		const own = entries.filter((entry) => entry.name === name)
		return {
			name,
			all: own.find((entry) => entry.env === null) ?? null,
			byEnv: new Map(own.flatMap((entry): [string, T][] => entry.env === null ? [] : [[entry.env, entry]])),
		}
	})
}

/** What `env` reads for the row's name. */
export function cellAt<T extends LayeredEntry>(row: LayeredName<T>, env: string): LayerCell<T> {
	const own = row.byEnv.get(env)
	if (own !== undefined) return { kind: 'own', entry: own }
	if (row.all !== null) return { kind: 'inherits', entry: row.all }
	return { kind: 'missing' }
}

/** A layer in the console's words. */
export function layerLabel(env: string | null): string {
	return env === null ? 'all environments' : env
}
