import type { Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Worker } from 'oblaka-iac'

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

const graphWorkers = (root: Worker): readonly Worker[] => {
	const workers = new Set<Worker>()
	const visit = (worker: Worker): void => {
		if (workers.has(worker)) return
		workers.add(worker)
		for (const value of Object.values(worker.options.bindings ?? {})) {
			if (value instanceof Worker) visit(value)
		}
	}
	visit(root)
	return [...workers]
}

/** `assertBoundedAssets` has already bounded the value; this only needs to find it. */
const assetDirectory = (worker: Worker): string | null => {
	const assets: unknown = worker.options.assets
	if (typeof assets !== 'object' || assets === null) return null
	const directory: unknown = Reflect.get(assets, 'directory')
	return typeof directory === 'string' && directory !== '' ? directory : null
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
 * per `wrangler deploy` spawn, for the Worker whose config lives in `configDir`: the checkout's own build
 * step runs between `open()` and the deploy, so that spawn is the only moment the tree is final.
 */
export const assertLiteralAssets = async (root: Worker, rootDir: string, configDir: string): Promise<void> => {
	for (const worker of graphWorkers(root)) {
		if (resolve(rootDir, worker.options.dir) !== configDir) continue
		const directory = assetDirectory(worker)
		if (directory === null) continue
		const base = resolve(configDir, directory)
		const refuse = (detail: string): Error => new Error(`cloudflare: Worker \`${worker.options.name}\` assets directory \`${directory}\` ${detail}`)
		const stats = await lstatOrNull(base)
		if (stats === null) continue
		if (stats.isSymbolicLink()) {
			throw refuse('is a symbolic link; wrangler follows it and would publish its target')
		}
		if (!stats.isDirectory()) continue
		await walk(base, '', { count: 0 }, refuse)
	}
}
