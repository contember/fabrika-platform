import { afterEach, describe, expect, test } from 'bun:test'
import { createTarRewrite, SOURCE_MAX_EXPANDED_BYTES, type SourceBytes } from '../archive'
import { SOURCE_MAX_TREE_ENTRIES } from '../tree'
import {
	bytes,
	concat,
	corrupt,
	DESCRIPTOR,
	descriptor,
	descriptorSha256,
	entries,
	entry,
	file,
	gitFixture,
	globalHeader,
	handCommitSha,
	handPrefix,
	handSource,
	handTarball,
	link,
	paxed,
	platformArchive,
	removeFixtureRoots,
	repository,
	runArchive,
	sourceFor,
	text,
} from './fixtures'

afterEach(removeFixtureRoots)

describe('the archive rewrite', () => {
	test('default application archives do not request tree metadata', async () => {
		const requests: string[] = []
		const source = handSource(handTarball([file(`${handPrefix}zerops.yaml`, descriptor)]), { onMetadataRequest: (url) => requests.push(url) })
		const archived = await runArchive(source, { repository, commitSha: handCommitSha, descriptorSha256, signal: new AbortController().signal })
		expect(archived.failure).toBeUndefined()
		expect(requests).toEqual([])
	})

	test('platform mode preserves safe chains and intermediate directory links', async () => {
		const parts = [
			file(`${handPrefix}zerops.yaml`, descriptor),
			file(`${handPrefix}docs/CLAUDE.md`, 'instructions'),
			link('AGENTS.md', 'alias/CLAUDE.md'),
			link('alias', 'docs'),
			link('chain', 'AGENTS.md'),
			link('docs/parent', '../AGENTS.md'),
		]
		const archived = await platformArchive(parts)
		expect(archived.failure).toBeUndefined()
		expect(entries(archived).filter((part) => part.type === '2').map((part) => [part.path, part.linkpath])).toEqual([
			['AGENTS.md', 'alias/CLAUDE.md'],
			['alias', 'docs'],
			['chain', 'AGENTS.md'],
			['docs/parent', '../AGENTS.md'],
		])
	})

	test('platform mode preserves long PAX link targets', async () => {
		const target = `${'directory'.repeat(14)}/CLAUDE.md`
		const archived = await platformArchive([
			file(`${handPrefix}zerops.yaml`, descriptor),
			paxed(`path=${handPrefix}${target}\n`, file(`${handPrefix}placeholder`, 'instructions')),
			paxed(`linkpath=${target}\n`, link('AGENTS.md', 'placeholder')),
		])
		expect(archived.failure).toBeUndefined()
		expect(entries(archived).find((part) => part.path === 'AGENTS.md')?.linkpath).toBe(target)
	})

	test.each([
		{ name: 'escape', parts: [link('link', '../outside')] },
		{ name: 'absolute target', parts: [link('link', '/outside')] },
		{ name: 'backslash', parts: [link('link', 'dir\\file')] },
		{ name: 'control', parts: [link('link', 'bad\nname')] },
		{ name: 'dangling', parts: [link('link', 'missing')] },
		{ name: 'cycle', parts: [link('one', 'two'), link('two', 'one')] },
		{ name: 'escape through chain', parts: [link('one', 'two/../..'), link('two', 'dir'), entry({ name: `${handPrefix}dir/`, type: '5' })] },
		{ name: 'file below earlier symlink', parts: [link('dir', '.'), file(`${handPrefix}dir/file`, 'x')] },
		{ name: 'symlink replaces regenerated parent', parts: [file(`${handPrefix}dir/file`, 'x'), link('dir', '.')] },
		{ name: 'directory below earlier symlink', parts: [link('dir', '.'), entry({ name: `${handPrefix}dir/sub/`, type: '5' })] },
		{ name: 'symlink replaces directory parent', parts: [entry({ name: `${handPrefix}dir/sub/`, type: '5' }), link('dir', '.')] },
		{ name: 'file-directory collision', parts: [file(`${handPrefix}dir`, 'x'), file(`${handPrefix}dir/file`, 'x')] },
		{ name: 'directory-file collision', parts: [file(`${handPrefix}dir/file`, 'x'), file(`${handPrefix}dir`, 'x')] },
		{ name: 'descriptor symlink', parts: [link('zerops.yaml', 'actual'), file(`${handPrefix}actual`, descriptor)] },
		{ name: 'directory traversal', parts: [entry({ name: `${handPrefix}../escape/`, type: '5' })] },
		{ name: 'nonzero link size', parts: [entry({ name: `${handPrefix}link`, type: '2', linkname: 'zerops.yaml', content: bytes('x') })] },
		{ name: 'hardlink', parts: [entry({ name: `${handPrefix}link`, type: '1', linkname: 'zerops.yaml' })] },
		...['3', '4', '6', 'L', 'K', 'S'].map((type) => ({ name: `special type ${type}`, parts: [entry({ name: `${handPrefix}special`, type })] })),
		{ name: 'submodule marker', parts: [file(`${handPrefix}.gitmodules`, 'submodules')] },
	])('platform mode rejects $name', async ({ parts }) => {
		const archived = await platformArchive([...parts, file(`${handPrefix}zerops.yaml`, descriptor)])
		expect(archived.failure).toMatchObject({ code: 'archive_rejected', stage: 'archive' })
		expect(archived.collected.ok).toBe(false)
	})

	test('streams the tarball into an archive of regular files with fixed modes, each parent directory written once before its first file', async () => {
		const fixture = await gitFixture()
		const archived = await runArchive(sourceFor(fixture), {
			repository,
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(archived.failure).toBeUndefined()
		expect(archived.summary).toEqual({
			commitSha: fixture.commitSha,
			descriptorSha256,
			entryCount: 3,
			expandedBytes: entries(archived).reduce((total, entry) => total + entry.content.byteLength, 0),
		})
		// The Zerops unpacker creates no directory it was not told about, so `bin/` precedes `bin/run`.
		expect(entries(archived).map((entry) => [entry.path, entry.mode, entry.type])).toEqual([
			['.gitattributes', 0o644, '0'],
			['bin/', 0o755, '5'],
			['bin/run', 0o755, '0'],
			['zerops.yaml', 0o644, '0'],
		])
		expect(text(archived, 'zerops.yaml')).toBe(descriptor)
	})

	test('writes nested parent directories outermost first and never twice', async () => {
		const tarball = handTarball([
			file(`${handPrefix}src/app/a.ts`, 'a'),
			file(`${handPrefix}src/app/b.ts`, 'b'),
			file(`${handPrefix}src/lib/c.ts`, 'c'),
			file(`${handPrefix}zerops.yaml`, descriptor),
		])
		const archived = await runArchive(handSource(tarball), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(archived.failure).toBeUndefined()
		expect(archived.summary?.entryCount).toBe(4)
		expect(entries(archived).map((entry) => [entry.path, entry.type])).toEqual([
			['src/', '5'],
			['src/app/', '5'],
			['src/app/a.ts', '0'],
			['src/app/b.ts', '0'],
			['src/lib/', '5'],
			['src/lib/c.ts', '0'],
			['zerops.yaml', '0'],
		])
	})

	test('rejects a repository whose tarball carries a symlink', async () => {
		const fixture = await gitFixture({ symlink: true })
		const archived = await runArchive(sourceFor(fixture), {
			repository,
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(archived.failure).toMatchObject({ code: 'archive_rejected', stage: 'archive' })
	})

	test('honours export-ignore and export-subst because the tarball is git archive', async () => {
		const fixture = await gitFixture({ exportIgnored: true })
		const archived = await runArchive(sourceFor(fixture), {
			repository,
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(entries(archived).map((entry) => entry.path)).not.toContain('secrets/local.env')
		expect(text(archived, 'bin/run')).toContain(fixture.commitSha)
		expect(text(archived, 'bin/run')).not.toContain('$Format')
	})

	test('carries a long path through its own pax header', async () => {
		const longPath = `${'nested-'.repeat(15)}directory/child/file.txt`
		const fixture = await gitFixture({ longPath })
		const archived = await runArchive(sourceFor(fixture), {
			repository,
			commitSha: fixture.commitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})

		expect(entries(archived).map((entry) => entry.path)).toContain(longPath)
		expect(text(archived, longPath)).toBe('long path contents')
		const directory = entries(archived).find((entry) => entry.path === `${'nested-'.repeat(15)}directory/`)
		expect(directory?.type).toBe('5')
	})

	test.each([
		{ name: 'a symlink', tarball: () => handTarball([entry({ name: `${handPrefix}link`, type: '2', linkname: 'zerops.yaml' })]) },
		{ name: 'a hard link', tarball: () => handTarball([entry({ name: `${handPrefix}link`, type: '1', linkname: 'zerops.yaml' })]) },
		{ name: 'a character device', tarball: () => handTarball([entry({ name: `${handPrefix}dev`, type: '3' })]) },
		{ name: 'a GNU long-name entry', tarball: () => handTarball([entry({ name: `${handPrefix}long`, type: 'L', content: bytes('x') })]) },
		{ name: 'a submodule marker', tarball: () => handTarball([file(`${handPrefix}.gitmodules`, '[submodule "x"]\n')]) },
		{ name: 'a second path prefix', tarball: () => handTarball([file(`${handPrefix}zerops.yaml`, descriptor), file('other-repo-aaaaaaa/extra', 'x')]) },
		{ name: 'a traversing path', tarball: () => handTarball([file(`${handPrefix}../escape`, 'x')]) },
		{
			name: 'an absolute path',
			tarball: () => handTarball([paxed('path=/absolute\n', entry({ name: `${handPrefix}placeholder`, content: bytes('x') }))]),
		},
		{ name: 'a duplicate path', tarball: () => handTarball([file(`${handPrefix}same`, 'x'), file(`${handPrefix}same`, 'y')]) },
		{ name: 'a pax linkpath record', tarball: () => handTarball([paxed(`linkpath=elsewhere\n`, file(`${handPrefix}zerops.yaml`, descriptor))]) },
		{
			name: 'an oversized pax record',
			tarball: () => handTarball([paxed(`path=${handPrefix}${'x'.repeat(70 * 1024)}\n`, entry({ name: `${handPrefix}placeholder` }))]),
		},
		{
			name: 'a truncated entry',
			tarball: () => concat(globalHeader(handCommitSha), entry({ name: `${handPrefix}zerops.yaml`, size: 4096 }), bytes('short')),
		},
		{ name: 'a missing end-of-archive', tarball: () => concat(globalHeader(handCommitSha), file(`${handPrefix}zerops.yaml`, descriptor)) },
		{ name: 'a missing pax global header', tarball: () => concat(file(`${handPrefix}zerops.yaml`, descriptor), new Uint8Array(1024)) },
		{ name: 'a corrupt header checksum', tarball: () => handTarball([corrupt(file(`${handPrefix}zerops.yaml`, descriptor))]) },
	])('rejects $name', async ({ tarball }) => {
		const archived = await runArchive(handSource(tarball()), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(archived.collected.ok).toBe(false)
		expect(archived.failure).toMatchObject({ stage: 'archive' })
		expect(archived.failure).not.toMatchObject({ code: 'internal' })
		expect(archived.failure).toBeInstanceOf(Error)
	})

	test('rejects a tarball that names a different commit', async () => {
		const archived = await runArchive(handSource(handTarball([file(`${handPrefix}zerops.yaml`, descriptor)], { commitSha: 'c'.repeat(40) })), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(archived.failure).toMatchObject({ code: 'commit_mismatch', stage: 'archive' })
	})

	test.each([
		{
			name: 'entry count',
			tarball: () => handTarball(Array.from({ length: SOURCE_MAX_TREE_ENTRIES + 1 }, (_value, index) => entry({ name: `${handPrefix}file-${index}` }))),
		},
		{
			name: 'expanded bytes',
			tarball: () => concat(globalHeader(handCommitSha), entry({ name: `${handPrefix}huge`, size: SOURCE_MAX_EXPANDED_BYTES + 1 })),
		},
	])('refuses a repository over the $name limit while streaming', async ({ tarball }) => {
		const archived = await runArchive(handSource(tarball()), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(archived.failure).toMatchObject({ code: 'archive_rejected', stage: 'archive' })
	})

	test.each([
		{ name: 'drifted', entries: [file(`${handPrefix}zerops.yaml`, 'zerops: drifted\n')], expected: { code: 'descriptor_mismatch' } },
		{ name: 'missing', entries: [file(`${handPrefix}other.yaml`, descriptor)], expected: { code: 'descriptor_missing' } },
		{ name: 'nested only', entries: [file(`${handPrefix}nested/zerops.yaml`, descriptor)], expected: { code: 'descriptor_missing' } },
		{
			name: 'oversized',
			entries: [entry({ name: `${handPrefix}zerops.yaml`, size: 512 * 1024 })],
			expected: { code: 'archive_rejected' },
		},
	])('rejects a $name root descriptor', async ({ entries: parts, expected }) => {
		const archived = await runArchive(handSource(handTarball(parts)), {
			repository,
			commitSha: handCommitSha,
			descriptorSha256,
			signal: new AbortController().signal,
		})
		expect(archived.failure).toMatchObject({ ...expected, stage: 'archive' })
	})

	test('passes file content through without buffering a whole entry', async () => {
		const chunkBytes = 64 * 1024
		const content: SourceBytes = new Uint8Array(3 * 1024 * 1024).fill(0x61)
		const tarball = handTarball([file(`${handPrefix}zerops.yaml`, descriptor), entry({ name: `${handPrefix}big`, content })])
		const rewrite = createTarRewrite({ commitSha: handCommitSha, descriptor: DESCRIPTOR, descriptorSha256 })
		const observed: number[] = []
		let pushed = 0
		const source = new ReadableStream<SourceBytes>({
			pull(controller) {
				if (pushed >= tarball.byteLength) {
					controller.close()
					return
				}
				const next = tarball.subarray(pushed, Math.min(pushed + chunkBytes, tarball.byteLength))
				pushed += next.byteLength
				controller.enqueue(next.slice())
			},
		})
		const reader = source.pipeThrough(rewrite.transform).getReader()
		let total = 0
		while (true) {
			const result = await reader.read()
			if (result.done) break
			observed.push(result.value.byteLength)
			total += result.value.byteLength
		}
		const summary = await rewrite.completed

		expect(summary.expandedBytes).toBe(descriptor.length + content.byteLength)
		expect(Math.max(...observed)).toBeLessThanOrEqual(chunkBytes)
		expect(observed.length).toBeGreaterThan(content.byteLength / chunkBytes)
		expect(total).toBeGreaterThan(content.byteLength)
	})
})
