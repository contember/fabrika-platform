// The SPA files of a contract application on Cloudflare. Workers Assets gives a Worker one directory, and a contract may
// declare several SPA and link mounts, each with a build directory of its own, so the deploy stages every mount's files
// into one directory that mirrors the request paths (`/admin/app.js` is `admin/app.js`), and the application's object
// serves a mount's paths from it (`bindingAssets` of `@fabrika/app`).

import { CLOUDFLARE_ASSETS_BINDING } from '@fabrika/app/build'
import type { ContractArtifact } from '@fabrika/auth-core'
import type { Stats } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Where the deploy stages the mounts' files, beside the generated `wrangler.jsonc` of the application Worker. */
export const SPA_ASSETS_DIRECTORY = 'fabrika/assets'

/** The `assets` the platform writes into an application Worker that declares none and has a mount with files. */
export const SPA_ASSETS = { directory: SPA_ASSETS_DIRECTORY, binding: CLOUDFLARE_ASSETS_BINDING, run_worker_first: true } as const

/**
 * The files Workers Assets reads as its own configuration at the root of the directory: a build that wrote them would
 * steer the platform's asset routing and headers, so they are never staged.
 */
const ASSET_CONFIG_PATHS: ReadonlySet<string> = new Set(['/_headers', '/_redirects', '/.assetsignore'])

/** A ceiling on the staging walk, as on the check of a published directory. */
const MAX_ASSET_ENTRIES = 50_000

/** A mount that serves files: its prefix, and its build directory relative to the application's root. */
export interface AssetMount {
	readonly name: string
	readonly prefix: string
	readonly dir: string
}

/** Every SPA and link mount of the contract with the directory its files come from, the most specific prefix first. */
export const assetMounts = (contract: ContractArtifact): readonly AssetMount[] =>
	Object.entries(contract.mounts)
		.flatMap(([name, mount]): AssetMount[] =>
			mount.kind === 'spa'
				? [{ name, prefix: mount.prefix, dir: mount.dir }]
				: mount.kind === 'link'
				? [{ name, prefix: mount.prefix, dir: mount.spa }]
				: []
		)
		.sort((left, right) => right.prefix.length - left.prefix.length || (left.prefix < right.prefix ? -1 : left.prefix > right.prefix ? 1 : 0))

/** The request path of `file` (relative, `/`-separated) of the mount at `prefix`. */
const requestPath = (prefix: string, file: string): string => (prefix === '/' ? `/${file}` : `${prefix}/${file}`)

/** Whether `path` is the mount at `prefix` or lies below it: the proxy routes it there, never to a shorter prefix. */
const isUnder = (path: string, prefix: string): boolean => prefix !== '/' && (path === prefix || path.startsWith(`${prefix}/`))

const lstatOrNull = async (path: string): Promise<Stats | null> => {
	try {
		return await lstat(path)
	} catch (err) {
		const code: unknown = err instanceof Error ? Reflect.get(err, 'code') : undefined
		if (code === 'ENOENT' || code === 'ENOTDIR') return null
		throw err
	}
}

/**
 * Whether some segment of `relativePath` below `base` is a symbolic link, from the first segment to the last. `resolve`
 * only reads the text, so `x/etc` with `x -> /` passes it; this reads the disk. A segment that does not exist ends it.
 */
const linkOnPath = async (base: string, relativePath: string): Promise<string | null> => {
	let current = base
	for (const segment of relativePath.split('/').filter((part) => part !== '' && part !== '.')) {
		current = join(current, segment)
		const stats = await lstatOrNull(current)
		if (stats === null) return null
		if (stats.isSymbolicLink()) return relative(base, current)
	}
	return null
}

const isWithin = (root: string, path: string): boolean => {
	const between = relative(root, path)
	return between === '' || (!between.startsWith('..') && !isAbsolute(between))
}

/**
 * Copy each mount's build directory under `root` into `target` at its prefix, after removing whatever `target` held. A
 * file of a mount that lies under a longer mount's prefix is that mount's path, so it is left out; a source map is never
 * served (the platform build uploads it to Operations), so it is left out too, and so is Workers Assets' own
 * configuration at the root (`ASSET_CONFIG_PATHS`). A mount whose directory is missing, a symbolic link anywhere on
 * its path or in its tree, or anything but a regular file or a directory is refused: the staged tree is uploaded
 * publicly, and a link would publish its target. `target` is `SPA_ASSETS_DIRECTORY` under `base`, with no link on the
 * way either. Returns how many files it staged.
 */
export const stageSpaAssets = async (mounts: readonly AssetMount[], root: string, base: string): Promise<number> => {
	const target = resolve(base, SPA_ASSETS_DIRECTORY)
	const targetLink = await linkOnPath(base, SPA_ASSETS_DIRECTORY)
	if (targetLink !== null) {
		throw new Error(`cloudflare: \`${targetLink}\` is a symbolic link, and the deploy stages the SPA files into \`${SPA_ASSETS_DIRECTORY}\``)
	}
	const sources = mounts.map((mount) => {
		const source = resolve(root, mount.dir)
		const segments = mount.dir.split('/')
		if (isAbsolute(mount.dir) || segments.includes('..') || segments.includes('.git') || !isWithin(root, source) || source === root) {
			throw new Error(`cloudflare: mount \`${mount.name}\` serves \`${mount.dir}\`, which is no directory inside the application`)
		}
		if (isWithin(source, target) || isWithin(target, source)) {
			throw new Error(
				`cloudflare: mount \`${mount.name}\` serves \`${mount.dir}\`, which overlaps \`${SPA_ASSETS_DIRECTORY}\`, where the deploy stages the SPA files`,
			)
		}
		return { mount, source }
	})
	await rm(target, { recursive: true, force: true })
	await mkdir(target, { recursive: true })
	let entries = 0
	let staged = 0
	for (const { mount, source } of sources) {
		const refuse = (detail: string): Error => new Error(`cloudflare: mount \`${mount.name}\` serves \`${mount.dir}\`, which ${detail}`)
		const link = await linkOnPath(root, mount.dir)
		if (link !== null) throw refuse(`passes \`${link}\`, a symbolic link; the deploy would publish its target`)
		const stats = await lstatOrNull(source)
		if (stats === null) {
			throw refuse('the build did not produce; build it in `pipeline.build`')
		}
		if (!stats.isDirectory()) {
			throw refuse(stats.isSymbolicLink() ? 'is a symbolic link; the deploy would publish its target' : 'is not a directory')
		}
		const longer = mounts.filter((other) => other.prefix.length > mount.prefix.length).map((other) => other.prefix)
		const walk = async (prefix: string): Promise<void> => {
			for (const name of (await readdir(join(source, prefix))).sort()) {
				entries += 1
				if (entries > MAX_ASSET_ENTRIES) throw refuse(`holds more than ${MAX_ASSET_ENTRIES} entries with the other mounts`)
				const file = prefix === '' ? name : `${prefix}/${name}`
				const path = requestPath(mount.prefix, file)
				if (longer.some((other) => isUnder(path, other)) || ASSET_CONFIG_PATHS.has(path)) continue
				const entry = await lstat(join(source, file))
				if (entry.isSymbolicLink()) throw refuse(`contains \`${file}\`, a symbolic link; the deploy would publish its target`)
				if (entry.isDirectory()) {
					await walk(file)
				} else if (!entry.isFile()) {
					throw refuse(`contains \`${file}\`, which is neither a regular file nor a directory`)
				} else if (!file.endsWith('.map')) {
					const destination = join(target, path.slice(1))
					await mkdir(dirname(destination), { recursive: true })
					await copyFile(join(source, file), destination)
					staged += 1
				}
			}
		}
		await walk('')
	}
	return staged
}
