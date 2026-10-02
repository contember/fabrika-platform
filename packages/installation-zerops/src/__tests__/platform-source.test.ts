import { createZeropsArtifactSourceDescriptor, ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES } from '@fabrika/provider-zerops'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { watch } from 'node:fs'
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type PreparedPlatformSource, preparePlatformSource } from '../platform-source'

let root: string
const prepared: PreparedPlatformSource[] = []
const contents = '# $Format:%H$\r\nzerops: [{setup: control}]\r\n'
const signal = () => new AbortController().signal

async function git(...args: string[]): Promise<string> {
	return new TextDecoder().decode(await gitBytes(...args)).trim()
}

async function gitBytes(...args: string[]): Promise<Uint8Array> {
	const child = Bun.spawn(['git', ...args], {
		cwd: root,
		env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text()])
	if (await child.exited !== 0) throw new Error(stderr)
	return new Uint8Array(stdout)
}

async function commit(): Promise<string> {
	await git('add', '--', 'zerops.yaml', 'packages', '.gitignore', ...await existingAttributes())
	await git('commit', '-qm', 'fixture')
	return git('rev-parse', 'HEAD')
}

async function existingAttributes(): Promise<string[]> {
	return await Bun.file(join(root, '.gitattributes')).exists() ? ['.gitattributes'] : []
}

async function prepare(): Promise<PreparedPlatformSource> {
	const result = await preparePlatformSource(root, signal())
	prepared.push(result)
	return result
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'platform-source-fixture-'))
	await git('init', '-q')
	await git('config', 'user.name', 'Fixture')
	await git('config', 'user.email', 'fixture@example.com')
	await mkdir(join(root, 'packages/auth-core'), { recursive: true })
	await writeFile(join(root, 'packages/auth-core/CLAUDE.md'), 'committed A')
	await symlink('CLAUDE.md', join(root, 'packages/auth-core/AGENTS.md'))
	await writeFile(join(root, 'zerops.yaml'), contents)
	await writeFile(join(root, '.gitignore'), 'node_modules/\n.env\n')
	await commit()
})

afterEach(async () => {
	await Promise.all(prepared.splice(0).map((source) => source.dispose()))
	await rm(root, { recursive: true, force: true })
})

describe('preparePlatformSource', () => {
	test('freezes committed A, preserves relative symlinks, excludes local files, and permits concurrent reads', async () => {
		const sha = await git('rev-parse', 'HEAD')
		await writeFile(join(root, '.env'), 'SECRET=not-in-archive')
		await writeFile(join(root, 'untracked.txt'), 'not-in-archive')
		await mkdir(join(root, 'node_modules'))
		await writeFile(join(root, 'node_modules/local'), 'not-in-archive')
		const source = await prepare()
		await git('checkout', '-qb', 'revision-b')
		await writeFile(join(root, 'zerops.yaml'), 'zerops: [{setup: changed}]\n')
		await writeFile(join(root, 'packages/auth-core/CLAUDE.md'), 'committed B')
		await commit()
		expect(source.commitSha).toBe(sha)
		const [first, second] = await Promise.all([readFile(source.archivePath), readFile(source.archivePath)])
		expect(first).toEqual(second)
		const archive = new Bun.Archive(first)
		const files = await archive.files()
		expect([...files.keys()].sort()).toEqual(['.gitignore', 'packages/auth-core/CLAUDE.md', 'zerops.yaml'])
		const archived = await files.get('zerops.yaml')?.text()
		expect(archived).toBe(contents)
		expect(source.descriptor).toEqual(await createZeropsArtifactSourceDescriptor(contents))
		const extracted = join(root, 'extracted')
		await archive.extract(extracted)
		expect((await lstat(join(extracted, 'packages/auth-core/AGENTS.md'))).isSymbolicLink()).toBe(true)
		expect(await readlink(join(extracted, 'packages/auth-core/AGENTS.md'))).toBe('CLAUDE.md')
		expect(await readFile(join(extracted, 'packages/auth-core/CLAUDE.md'), 'utf8')).toBe('committed A')
		await Promise.all([source.dispose(), source.dispose()])
		expect(await Bun.file(source.archivePath).exists()).toBe(false)
	})

	test.each(['worktree', 'index'])('rejects tracked %s dirt before creating a snapshot', async (kind) => {
		const before = await snapshots()
		await writeFile(join(root, 'zerops.yaml'), 'dirty')
		if (kind === 'index') await git('add', '--', 'zerops.yaml')
		await expect(prepare()).rejects.toThrow('clean tracked index and worktree')
		expect(await snapshots()).toEqual(before)
	})

	test('requires the repository root', async () => {
		await expect(preparePlatformSource(join(root, 'packages'), signal())).rejects.toThrow('repository root')
	})

	test('rejects staged changes even when the worktree again matches HEAD', async () => {
		await writeFile(join(root, 'zerops.yaml'), 'staged')
		await git('add', '--', 'zerops.yaml')
		await writeFile(join(root, 'zerops.yaml'), contents)
		await expect(prepare()).rejects.toThrow('clean tracked index and worktree')
	})

	test('preserves UTF-8 BOM and multibyte descriptor bytes', async () => {
		const unicodeContents = `\ufeff# café\n${contents}`
		await writeFile(join(root, 'zerops.yaml'), unicodeContents)
		await commit()
		const source = await prepare()
		const archived = (await new Bun.Archive(await Bun.file(source.archivePath).arrayBuffer()).files('zerops.yaml')).get('zerops.yaml')
		if (!archived) throw new Error('Missing archived descriptor')
		expect(new Uint8Array(await archived.arrayBuffer())).toEqual(new TextEncoder().encode(unicodeContents))
		expect(source.descriptor).toEqual(await createZeropsArtifactSourceDescriptor(unicodeContents))
	})

	test.each(['--assume-unchanged', '--skip-worktree'])('rejects dirt hidden with %s', async (flag) => {
		await git('update-index', flag, '--', 'zerops.yaml')
		await writeFile(join(root, 'zerops.yaml'), 'hidden dirt')
		await expect(prepare()).rejects.toThrow('full checkout')
	})

	test('disables committed, nested, local and global export attributes without changing the checkout', async () => {
		await writeFile(join(root, '.gitattributes'), '* export-ignore export-subst\n')
		await writeFile(join(root, 'packages/.gitattributes'), '* export-ignore export-subst\n')
		await commit()
		await writeFile(join(root, '.git/info/attributes'), '* export-ignore export-subst\n')
		const global = join(root, 'global-attributes')
		await writeFile(global, '* export-ignore export-subst\n')
		await git('config', 'core.attributesFile', global)
		const source = await prepare()
		const files = await new Bun.Archive(await Bun.file(source.archivePath).arrayBuffer()).files()
		expect(await files.get('zerops.yaml')?.text()).toBe(contents)
		expect(await files.get('packages/auth-core/CLAUDE.md')?.text()).toBe('committed A')
		expect(await git('status', '--porcelain', '--untracked-files=no')).toBe('')
	})

	test.each(['text eol=crlf ident', 'working-tree-encoding=UTF-16LE', 'filter=fixture'])(
		'preserves committed bytes despite %s checkout attributes',
		async (attributes) => {
			const descriptorContents = '# hello $Id$\nzerops: [{setup: control}]\n'
			const scriptContents = 'hello\n$Id$\n'
			await writeFile(join(root, 'zerops.yaml'), descriptorContents)
			await writeFile(join(root, 'packages/auth-core/script.txt'), scriptContents)
			await commit()
			await writeFile(join(root, '.gitattributes'), `zerops.yaml ${attributes}\n`)
			await writeFile(join(root, 'packages/auth-core/.gitattributes'), `script.txt ${attributes}\n`)
			await git('config', 'filter.fixture.smudge', 'git version')
			if (attributes === 'working-tree-encoding=UTF-16LE') {
				await writeFile(join(root, 'zerops.yaml'), Buffer.from(descriptorContents, 'utf16le'))
				await writeFile(join(root, 'packages/auth-core/script.txt'), Buffer.from(scriptContents, 'utf16le'))
			}
			await commit()
			expect(await git('status', '--porcelain', '--untracked-files=no')).toBe('')
			const source = await prepare()
			const files = await new Bun.Archive(await Bun.file(source.archivePath).arrayBuffer()).files()
			for (const path of ['zerops.yaml', 'packages/auth-core/script.txt']) {
				const archived = files.get(path)
				if (!archived) throw new Error('Missing archived fixture file')
				expect(new Uint8Array(await archived.arrayBuffer())).toEqual(await gitBytes('cat-file', 'blob', `${source.commitSha}:${path}`))
			}
			expect(source.descriptor).toEqual(await createZeropsArtifactSourceDescriptor(descriptorContents))
		},
	)

	test('keeps nested source bytes exact even when the descriptor needs no conversion', async () => {
		await writeFile(join(root, 'packages/auth-core/script.txt'), 'hello\n$Id$\n')
		await writeFile(join(root, 'packages/auth-core/.gitattributes'), 'script.txt text eol=crlf ident\n')
		await commit()
		const source = await prepare()
		const files = await new Bun.Archive(await Bun.file(source.archivePath).arrayBuffer()).files()
		for (const path of ['zerops.yaml', 'packages/auth-core/script.txt']) {
			const archived = files.get(path)
			if (!archived) throw new Error('Missing archived fixture file')
			expect(new Uint8Array(await archived.arrayBuffer())).toEqual(await gitBytes('cat-file', 'blob', `${source.commitSha}:${path}`))
		}
	})

	test('rejects submodules', async () => {
		const sha = await git('rev-parse', 'HEAD')
		await git('update-index', '--add', '--cacheinfo', `160000,${sha},submodule`)
		await git('commit', '-qm', 'submodule fixture')
		await expect(prepare()).rejects.toThrow('submodules')
	})

	test.each(['symlink', 'missing', 'oversized', 'invalid-utf8'])('rejects a %s descriptor', async (kind) => {
		await rm(join(root, 'zerops.yaml'))
		if (kind === 'symlink') await symlink('packages/auth-core/CLAUDE.md', join(root, 'zerops.yaml'))
		if (kind === 'oversized') await writeFile(join(root, 'zerops.yaml'), 'x'.repeat(ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES + 1))
		if (kind === 'invalid-utf8') await writeFile(join(root, 'zerops.yaml'), new Uint8Array([0xff]))
		await commit()
		await expect(prepare()).rejects.toThrow()
	})

	test('cleans temporary resources when aborted after snapshot allocation', async () => {
		const before = await snapshots()
		const controller = new AbortController()
		const watcher = watch(tmpdir(), (_event, name) => {
			if (name?.startsWith('fabrika-platform-source-')) controller.abort()
		})
		try {
			await expect(preparePlatformSource(root, controller.signal)).rejects.toThrow()
		} finally {
			watcher.close()
		}
		expect(controller.signal.aborted).toBe(true)
		expect(await snapshots()).toEqual(before)
	})

	test('an already aborted request allocates nothing', async () => {
		const before = await snapshots()
		await expect(preparePlatformSource(root, AbortSignal.abort())).rejects.toThrow()
		expect(await snapshots()).toEqual(before)
	})

	test('descriptor proof failure cleans the completed archive and temporary repository', async () => {
		const before = await snapshots()
		const proof = spyOn(Bun.Archive.prototype, 'files').mockResolvedValue(
			new Map([
				['zerops.yaml', new File(['x'.repeat(new TextEncoder().encode(contents).length)], 'zerops.yaml')],
			]),
		)
		try {
			await expect(prepare()).rejects.toThrow('differs from the committed descriptor')
		} finally {
			proof.mockRestore()
		}
		expect(await snapshots()).toEqual(before)
	})

	test('disposal removes the entire preparation directory', async () => {
		const source = await prepare()
		await source.dispose()
		await expect(readdir(dirname(source.archivePath))).rejects.toThrow()
	})
})

async function snapshots(): Promise<string[]> {
	return (await readdir(tmpdir())).filter((name) => name.startsWith('fabrika-platform-source-')).sort()
}
