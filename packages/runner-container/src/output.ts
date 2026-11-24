// The one way a build's output reaches the deploy (ADR-0086): the runner creates a tree of its own and copies into it
// regular files only, each checked with `lstat` and again on the open descriptor. A link, a hard link, a device, a fifo,
// a socket, an unsafe name or an output over the limits fails the deploy with one line. The build's processes are
// reaped before the copy starts, so nothing changes the tree while it is read.

import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface CopyLimits {
	/** Regular files in the whole output. */
	readonly maxFiles: number
	/** Bytes of all files together. */
	readonly maxBytes: number
	/** Directories below the root. */
	readonly maxDepth: number
	/** Bytes of a path relative to the root. */
	readonly maxPathBytes: number
}

/** Above any real output: the assets walk stops at 50,000 entries, a Worker bundle at 10 MiB and the maps at 64 MiB. */
export const DEFAULT_COPY_LIMITS: CopyLimits = { maxFiles: 60_000, maxBytes: 1024 * 1024 * 1024, maxDepth: 32, maxPathBytes: 1024 }

const MAX_NAME_BYTES = 255
const CHUNK_BYTES = 1024 * 1024

export class BuildOutputRefused extends Error {}

/** The message quotes the path the build chose, after it passed the name check, and never anything else of the output. */
const refuse = (detail: string): BuildOutputRefused => new BuildOutputRefused(`the build's output is refused: ${detail}`)

const quoted = (path: string): string => `\`${path.length > 200 ? `${path.slice(0, 200)}…` : path}\``

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** A name decoded from its bytes, refused when it is not UTF-8, is too long, or holds a control character or a backslash. */
const safeName = (raw: Buffer, parent: string): string => {
	let name: string
	try {
		name = utf8.decode(raw)
	} catch {
		throw refuse(`${parent === '' ? 'its root' : quoted(parent)} holds a name that is not UTF-8`)
	}
	const unsafe = [...name].some((char) => {
		const code = char.codePointAt(0) ?? 0
		return code < 0x20 || code === 0x7f || char === '\\'
	})
	if (unsafe || raw.length > MAX_NAME_BYTES || name === '' || name === '.' || name === '..' || name.includes('/')) {
		throw refuse(`${parent === '' ? 'its root' : quoted(parent)} holds an unsafe name`)
	}
	return name
}

interface Budget {
	files: number
	bytes: number
}

const kind = (stats: Stats): string => {
	if (stats.isSymbolicLink()) return 'a symbolic link'
	if (stats.isFIFO()) return 'a fifo'
	if (stats.isSocket()) return 'a socket'
	if (stats.isBlockDevice() || stats.isCharacterDevice()) return 'a device'
	return 'neither a regular file nor a directory'
}

/** Copy one regular file through its own descriptor: the file opened must be the one checked, and no larger than it was. */
const copyFileChecked = async (source: string, target: string, path: string, checked: Stats): Promise<void> => {
	const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
		throw refuse(`${quoted(path)} cannot be opened as a regular file`)
	})
	try {
		const stats = await input.stat()
		if (!stats.isFile() || stats.ino !== checked.ino || stats.dev !== checked.dev || stats.nlink !== 1 || stats.size !== checked.size) {
			throw refuse(`${quoted(path)} changed while it was copied`)
		}
		// `wx`: the runner's tree is new, so a name that exists already is refused rather than written through.
		const output = await open(target, 'wx', 0o644)
		try {
			const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(1, checked.size + 1)))
			let copied = 0
			for (;;) {
				const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
				if (bytesRead === 0) break
				copied += bytesRead
				if (copied > checked.size) throw refuse(`${quoted(path)} grew while it was copied`)
				await output.write(buffer, 0, bytesRead)
			}
			if (copied !== checked.size) throw refuse(`${quoted(path)} shrank while it was copied`)
		} finally {
			await output.close()
		}
	} finally {
		await input.close()
	}
}

const walk = async (source: string, target: string, path: string, depth: number, limits: CopyLimits, budget: Budget): Promise<void> => {
	const names = (await readdir(source, { encoding: 'buffer' })).sort(Buffer.compare)
	for (const raw of names) {
		const name = safeName(raw, path)
		const relative = path === '' ? name : `${path}/${name}`
		if (Buffer.byteLength(relative) > limits.maxPathBytes) throw refuse(`holds a path longer than ${limits.maxPathBytes} bytes`)
		const from = join(source, name)
		const to = join(target, name)
		const stats = await lstat(from)
		if (stats.isDirectory()) {
			if (depth + 1 > limits.maxDepth) throw refuse(`nests directories deeper than ${limits.maxDepth}`)
			await mkdir(to, { mode: 0o700 })
			await walk(from, to, relative, depth + 1, limits, budget)
			continue
		}
		if (!stats.isFile()) throw refuse(`${quoted(relative)} is ${kind(stats)}`)
		if (stats.nlink !== 1) throw refuse(`${quoted(relative)} is a hard link`)
		budget.files += 1
		budget.bytes += stats.size
		if (budget.files > limits.maxFiles) throw refuse(`holds more than ${limits.maxFiles} files`)
		if (budget.bytes > limits.maxBytes) throw refuse(`exceeds ${limits.maxBytes} bytes`)
		await copyFileChecked(from, to, relative, stats)
	}
}

/**
 * Copy the build's output at `source` into `target`, a directory the runner creates now (it must not exist). Returns
 * what was copied. Anything but directories and single-linked regular files with safe names, within `limits`, throws a
 * `BuildOutputRefused` whose message is the one line the run fails with.
 */
export const copyBuildOutput = async (
	source: string,
	target: string,
	limits: CopyLimits = DEFAULT_COPY_LIMITS,
): Promise<{ readonly files: number; readonly bytes: number }> => {
	const root = await lstat(source).catch(() => null)
	if (root === null || !root.isDirectory()) throw refuse('it is not a directory')
	await mkdir(target, { mode: 0o700 })
	const budget: Budget = { files: 0, bytes: 0 }
	await walk(source, target, '', 0, limits, budget)
	return budget
}
