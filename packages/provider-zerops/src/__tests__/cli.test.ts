import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readZeropsSourceDescriptor, runZeropsCli } from '../cli'
import { parseFabrikaManifest, ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES } from '../manifest'

const roots: string[] = []

const temporaryRoot = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-zerops-cli-'))
	roots.push(root)
	return root
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Zerops source descriptor loading', () => {
	test('preserves exact UTF-8 contents and hashes CR bytes', async () => {
		const root = await temporaryRoot()
		const contents = 'zerops:\r\n  - setup: notes\r\n'
		await writeFile(join(root, 'zerops.yaml'), contents)

		expect(await readZeropsSourceDescriptor(root)).toEqual({
			path: 'zerops.yaml',
			contents,
			sha256: 'd1d6553b6db05b027ecacc35e1048e1846005d5d595268f32c6bf89aeec0019c',
		})
	})

	test('preserves a UTF-8 BOM as exact descriptor bytes', async () => {
		const root = await temporaryRoot()
		const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('zerops:\r\n')])
		await writeFile(join(root, 'zerops.yaml'), bytes)

		expect(await readZeropsSourceDescriptor(root)).toEqual({
			path: 'zerops.yaml',
			contents: '\uFEFFzerops:\r\n',
			sha256: '7b6817755943a7935d1522dc45e2eb6c654c953e8ff9f6f06a31ba00ad9b3e2d',
		})
	})

	test('rejects a missing descriptor', async () => {
		const root = await temporaryRoot()
		await expect(readZeropsSourceDescriptor(root)).rejects.toThrow('Missing repository-root')
	})

	test('rejects a symlink descriptor', async () => {
		const root = await temporaryRoot()
		await writeFile(join(root, 'actual.yaml'), 'zerops:\n')
		await symlink(join(root, 'actual.yaml'), join(root, 'zerops.yaml'))
		await expect(readZeropsSourceDescriptor(root)).rejects.toThrow('must not be a symlink')
	})

	test('rejects a non-file descriptor', async () => {
		const root = await temporaryRoot()
		await mkdir(join(root, 'zerops.yaml'))
		await expect(readZeropsSourceDescriptor(root)).rejects.toThrow('must be a regular file')
	})

	test('rejects an empty descriptor', async () => {
		const root = await temporaryRoot()
		await writeFile(join(root, 'zerops.yaml'), '')
		await expect(readZeropsSourceDescriptor(root)).rejects.toThrow('must not be empty')
	})

	test('rejects an oversized descriptor', async () => {
		const root = await temporaryRoot()
		await writeFile(join(root, 'zerops.yaml'), 'x'.repeat(ZEROPS_SOURCE_DESCRIPTOR_MAX_BYTES + 1))
		await expect(readZeropsSourceDescriptor(root)).rejects.toThrow('exceeds')
	})

	test('rejects invalid UTF-8', async () => {
		const root = await temporaryRoot()
		await writeFile(join(root, 'zerops.yaml'), new Uint8Array([0xc3, 0x28]))
		await expect(readZeropsSourceDescriptor(root)).rejects.toThrow('valid UTF-8')
	})

	test('build embeds the descriptor from the current repository root', async () => {
		const root = await temporaryRoot()
		const descriptor = 'zerops:\r\n  - setup: app\r\n'
		const authoringUrl = pathToFileURL(join(import.meta.dir, '..', 'authoring.ts')).href
		await writeFile(join(root, 'zerops.yaml'), descriptor)
		await writeFile(
			join(root, 'fabrika.config.ts'),
			`import { defineApp } from ${
				JSON.stringify(authoringUrl)
			}\nexport default defineApp({ id: 'app', target: { platform: 'zerops', services: () => [{ hostname: 'app', type: 'alpine/bun@1.3' }] } })\n`,
		)
		const originalCwd = process.cwd()
		try {
			process.chdir(root)
			await runZeropsCli(['build', '--env=prod'])
		} finally {
			process.chdir(originalCwd)
		}
		const manifest: unknown = JSON.parse(await Bun.file(join(root, 'fabrika.manifest.json')).text())
		expect(parseFabrikaManifest(manifest).target.sourceDescriptor.contents).toBe(descriptor)
	})
})
