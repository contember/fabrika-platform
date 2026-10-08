import type { Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { GeneratedConfig } from 'oblaka-iac'
import { assetDirectory } from './bounds'

/** A ceiling on the walk, so a checkout cannot turn the check itself into the denial of service. */
const MAX_ASSET_ENTRIES = 50_000

/** A directory wrangler would refuse on its own; its error is better than one invented here. */
const lstatOrNull = async (path: string): Promise<Stats | null> => {
	try {
		return await lstat(path)
	} catch (err) {
		const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined
		if (code === 'ENOENT' || code === 'ENOTDIR') return null
		throw err
	}
}

interface WalkBudget {
	count: number
}

type Refuse = (detail: string) => Error

const walk = async (base: string, prefix: string, budget: WalkBudget, refuse: Refuse): Promise<void> => {
	for (const name of await readdir(resolve(base, prefix))) {
		budget.count += 1
		if (budget.count > MAX_ASSET_ENTRIES) {
			throw refuse(`holds more than ${MAX_ASSET_ENTRIES} entries and is refused rather than walked`)
		}
		const path = prefix === '' ? name : `${prefix}/${name}`
		const stats = await lstat(resolve(base, path))
		if (stats.isSymbolicLink()) {
			throw refuse(`contains \`${path}\`, which is a symbolic link; wrangler follows it and would publish its target`)
		}
		if (stats.isDirectory()) {
			await walk(base, path, budget, refuse)
		} else if (!stats.isFile()) {
			throw refuse(`contains \`${path}\`, which is neither a regular file nor a directory`)
		}
	}
}

/**
 * wrangler `stat`s each asset rather than `lstat`ing it, so a committed symlink to `/proc/self/environ`
 * (the deploy's own environment holds the account token) or to `.git/config` uploads publicly. Call this
 * per `wrangler deploy` spawn, for the config that spawn reads: the checkout's own build step runs between
 * `open()` and the deploy, so that spawn is the only moment the tree is final.
 */
export const assertLiteralAssets = async (generated: GeneratedConfig, configDir: string): Promise<void> => {
	const directory = assetDirectory(generated)
	if (directory === null) return
	const base = resolve(configDir, directory)
	const refuse = (detail: string): Error =>
		new Error(`cloudflare: Worker \`${generated.config.name ?? generated.path}\` assets directory \`${directory}\` ${detail}`)
	const stats = await lstatOrNull(base)
	if (stats === null) return
	if (stats.isSymbolicLink()) {
		throw refuse('is a symbolic link; wrangler follows it and would publish its target')
	}
	if (!stats.isDirectory()) return
	await walk(base, '', { count: 0 }, refuse)
}
