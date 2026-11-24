import { afterEach, describe, expect, test } from 'bun:test'
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BuildOutputRefused, copyBuildOutput, DEFAULT_COPY_LIMITS } from '../output'

// The one way a build's output reaches the deploy: a fresh tree of the runner's, regular files only.

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const output = async (): Promise<{ readonly source: string; readonly target: string; readonly root: string }> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-output-'))
	roots.push(root)
	const source = join(root, 'out')
	mkdirSync(join(source, 'app', 'bundle'), { recursive: true })
	writeFileSync(join(source, 'fabrika-build.json'), '{}')
	writeFileSync(join(source, 'app', 'bundle', 'entry.js'), 'export default {}\n')
	return { source, target: join(root, 'bundle'), root }
}

const refusal = async (source: string, target: string, limits = DEFAULT_COPY_LIMITS): Promise<string> => {
	try {
		await copyBuildOutput(source, target, limits)
	} catch (error) {
		if (error instanceof BuildOutputRefused) return error.message
		throw error
	}
	throw new Error('the output was copied')
}

describe('copyBuildOutput', () => {
	test('copies directories and regular files into a new tree of its own, file by file', async () => {
		const { source, target } = await output()
		mkdirSync(join(source, 'app', 'assets', '.well-known'), { recursive: true })
		writeFileSync(join(source, 'app', 'assets', '.well-known', 'security.txt'), 'contact')
		writeFileSync(join(source, 'app', 'assets', 'empty.txt'), '')
		const copied = await copyBuildOutput(source, target)
		expect(copied).toEqual({ files: 4, bytes: 2 + 18 + 7 })
		expect(await readFile(join(target, 'app', 'bundle', 'entry.js'), 'utf8')).toBe('export default {}\n')
		expect(await readFile(join(target, 'app', 'assets', '.well-known', 'security.txt'), 'utf8')).toBe('contact')
		const file = await stat(join(target, 'app', 'bundle', 'entry.js'))
		const source_ = await stat(join(source, 'app', 'bundle', 'entry.js'))
		// A copy, not a link: its own inode.
		expect(file.ino).not.toBe(source_.ino)
		expect(file.nlink).toBe(1)
		expect((await stat(target)).mode & 0o777).toBe(0o700)
	})

	test('refuses a symbolic link, to a file or a directory, anywhere in the output', async () => {
		const outside = await output()
		writeFileSync(join(outside.root, 'secret'), 'token')
		for (const link of ['app/bundle/environ.js', 'app/assets']) {
			const { source, target } = await output()
			mkdirSync(join(source, 'app', 'assets'), { recursive: true })
			if (link === 'app/assets') {
				await rm(join(source, 'app', 'assets'), { recursive: true })
				symlinkSync('/etc', join(source, link))
			} else {
				symlinkSync(join(outside.root, 'secret'), join(source, link))
			}
			expect(await refusal(source, target)).toBe(`the build's output is refused: \`${link}\` is a symbolic link`)
		}
	})

	test('refuses a hard link: the build could have linked a file it cannot otherwise publish', async () => {
		const { source, target, root } = await output()
		writeFileSync(join(root, 'elsewhere'), 'not the build output')
		linkSync(join(root, 'elsewhere'), join(source, 'app', 'bundle', 'linked.js'))
		expect(await refusal(source, target)).toBe("the build's output is refused: `app/bundle/linked.js` is a hard link")
	})

	test('refuses a fifo', async () => {
		const { source, target } = await output()
		const made = Bun.spawnSync(['mkfifo', join(source, 'app', 'bundle', 'pipe.js')])
		expect(made.exitCode).toBe(0)
		expect(await refusal(source, target)).toBe("the build's output is refused: `app/bundle/pipe.js` is a fifo")
	})

	test('refuses an output over its file, byte, depth or path limits', async () => {
		const { source, target } = await output()
		expect(await refusal(source, `${target}-files`, { ...DEFAULT_COPY_LIMITS, maxFiles: 1 })).toBe(
			"the build's output is refused: holds more than 1 files",
		)
		expect(await refusal(source, `${target}-bytes`, { ...DEFAULT_COPY_LIMITS, maxBytes: 10 })).toBe("the build's output is refused: exceeds 10 bytes")
		expect(await refusal(source, `${target}-depth`, { ...DEFAULT_COPY_LIMITS, maxDepth: 1 })).toBe(
			"the build's output is refused: nests directories deeper than 1",
		)
		expect(await refusal(source, `${target}-path`, { ...DEFAULT_COPY_LIMITS, maxPathBytes: 8 })).toBe(
			"the build's output is refused: holds a path longer than 8 bytes",
		)
	})

	test('refuses a name with a control character or a backslash, which could forge a path or a log line', async () => {
		for (const name of ['line\nbreak.js', 'back\\slash.js', 'tab\t.js']) {
			const { source, target } = await output()
			writeFileSync(join(source, 'app', 'bundle', name), 'x')
			expect(await refusal(source, target)).toBe("the build's output is refused: `app/bundle` holds an unsafe name")
		}
	})

	test('refuses a source that is not a directory, and never writes into a tree that exists', async () => {
		const { source, target, root } = await output()
		symlinkSync(source, join(root, 'linked-out'))
		expect(await refusal(join(root, 'linked-out'), target)).toBe("the build's output is refused: it is not a directory")
		mkdirSync(target)
		await expect(copyBuildOutput(source, target)).rejects.toThrow('EEXIST')
		expect((await lstat(target)).isDirectory()).toBe(true)
	})
})
