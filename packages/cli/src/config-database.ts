// The database an application runs on, as the static read of `fabrika.config.ts` says it (the read Control approves
// from), checked against the config the command loads where the read cannot follow it. A config whose loaded value names
// a database the static read does not see would run on Postgres while Control, the checker and the build assume SQLite.

import { type ApplicationTarget, applicationTarget, CONFIG_FILE, READABLE_DATABASE_SHAPE } from '@fabrika/check'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Whether the default export of the loaded config names a `database`. */
const loadedDatabase = async (path: string): Promise<boolean> => {
	const loaded: unknown = await import(path)
	if (typeof loaded !== 'object' || loaded === null) return false
	const config: unknown = Reflect.get(loaded, 'default')
	if (typeof config !== 'object' || config === null) return false
	const database: unknown = Reflect.get(config, 'database')
	return database !== undefined && database !== null
}

export type SettledTarget = { readonly target: ApplicationTarget } | { readonly refusal: string }

/**
 * The static read of `<root>/fabrika.config.ts`, refused when it names a `database` it cannot read. The config is loaded
 * when the read cannot tell whether it names a database (`unsettled`), and on `always` (a caller that loads it anyway, as
 * `app build` does to infer the provider) whenever the file exists; a loaded `database` the read does not see, or a
 * Postgres read the loaded config does not confirm, is refused with the shape the read settles. A config the read cannot
 * follow and that names no database keeps the Durable Object's SQLite.
 */
export const settleTarget = async (root: string, load: 'unsettled' | 'always'): Promise<SettledTarget> => {
	const path = join(root, CONFIG_FILE)
	const exists = existsSync(path)
	const target = applicationTarget(new Map(exists ? [[CONFIG_FILE, readFileSync(path, 'utf8')]] : []))
	if (target.unreadable !== undefined) return { refusal: `${CONFIG_FILE}: ${target.unreadable}` }
	if (!exists || (target.unsettled === undefined && load === 'unsettled')) return { target }
	const named = await loadedDatabase(path)
	const postgres = target.cloudflare && target.dialect === 'postgres'
	if (named && !postgres) {
		const why = target.unsettled === undefined ? '' : ` (${target.unsettled})`
		return {
			refusal:
				`${CONFIG_FILE} names a \`database\` when it loads, and the static read that Control, the checker and the build share does not see it${why}: write it as ${READABLE_DATABASE_SHAPE}`,
		}
	}
	if (!named && postgres) {
		return {
			refusal:
				`${CONFIG_FILE} reads statically as Postgres, and the config it loads names no \`database\`: write it as ${READABLE_DATABASE_SHAPE}, and nothing that removes it at runtime`,
		}
	}
	return { target }
}
