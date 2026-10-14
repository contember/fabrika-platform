// A local pack the operator names explicitly (`fabrika-check --packed <release-manifest.json>`): the
// package-replacement rule then accepts its tarballs, byte for byte, where it otherwise wants registry versions. The
// platform build never names one, so a deployed application still installs from the registry (ADR-0043).

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { isIgnoredSegment } from './layout'

/** One package of the set: the tarball `release:pack` wrote and the sha512 integrity of its bytes. */
export interface PackedTarball {
	readonly filename: string
	readonly integrity: string
}

export interface PackedSet {
	/** The version the pack gave every package of the set. */
	readonly version: string
	/** Each package's tarball, by package name. */
	readonly packages: ReadonlyMap<string, PackedTarball>
	/** The sha512 integrity of every file under the root named like one of the tarballs, by path relative to the root. */
	readonly tarballs: ReadonlyMap<string, string>
}

const releaseManifestSchema = z.object({
	version: z.string().min(1),
	packages: z.array(z.object({
		name: z.string().startsWith('@fabrika/'),
		filename: z.string().regex(/^[A-Za-z0-9._-]+\.tgz$/),
		integrity: z.string().startsWith('sha512-'),
	})),
})

const integrityOf = (bytes: Uint8Array): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

/** The tarball files under `root` named in `filenames`, hashed; the checker's skipped directories are skipped here too. */
const hashTarballs = async (root: string, filenames: ReadonlySet<string>): Promise<Map<string, string>> => {
	const tarballs = new Map<string, string>()
	const visit = async (relativeDirectory: string): Promise<void> => {
		const entries = await readdir(join(root, relativeDirectory), { withFileTypes: true })
		for (const entry of entries) {
			if (isIgnoredSegment(entry.name)) continue
			const path = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
			if (entry.isDirectory()) await visit(path)
			else if (entry.isFile() && filenames.has(entry.name)) tarballs.set(path, integrityOf(await readFile(join(root, path))))
		}
	}
	await visit('')
	return tarballs
}

/** The packed set `manifestText` (a `release-manifest.json`) describes, with the tarballs found under `root`. */
export const readPackedSet = async (root: string, manifestText: string): Promise<PackedSet> => {
	let json: unknown
	try {
		json = JSON.parse(manifestText)
	} catch {
		throw new Error('the release manifest is not JSON')
	}
	const parsed = releaseManifestSchema.safeParse(json)
	if (!parsed.success) throw new Error('the release manifest does not name each package with its tarball and sha512 integrity')
	const packages = new Map(parsed.data.packages.map(({ name, filename, integrity }) => [name, { filename, integrity }]))
	const tarballs = await hashTarballs(root, new Set([...packages.values()].map((item) => item.filename)))
	return { version: parsed.data.version, packages, tarballs }
}
