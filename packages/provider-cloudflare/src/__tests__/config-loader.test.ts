import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defaultCloudflareCollaborators, loadCloudflareCommandConfig } from '..'

let root: string
let configDir: string

beforeAll(async () => {
	root = await mkdtemp(join(import.meta.dir, 'config-loader-'))
	configDir = join(root, 'app')
	await mkdir(configDir)
	const authoringPath = JSON.stringify(resolve(import.meta.dir, '../authoring.ts'))
	const app = `import { defineApp } from ${authoringPath}
const config = defineApp({ id: 'fixture', resources: () => { throw new Error('not materialized while loading') } })`
	await writeFile(join(configDir, 'valid.ts'), `${app}\nexport default config`)
	await writeFile(join(configDir, 'named.ts'), `${app}\nexport { config }`)
	await writeFile(join(configDir, 'invalid.ts'), `${app}\nexport { config }\nexport default { id: 'fixture', resources: () => {} }`)
	await writeFile(join(configDir, 'throws.ts'), `throw new Error('config evaluation failed')`)
})

afterAll(async () => {
	if (root !== undefined) {
		await rm(root, { recursive: true, force: true })
	}
})

for (
	const loader of [
		{ name: 'command', load: (cwd: string, configPath: string) => loadCloudflareCommandConfig(configPath, cwd) },
		{ name: 'collaborator', load: defaultCloudflareCollaborators.loadConfig },
	]
) {
	describe(`${loader.name} config loader`, () => {
		test('resolves relative and absolute configs without changing the process cwd', async () => {
			const processCwd = process.cwd()
			const absolutePath = join(configDir, 'valid.ts')
			const expected = {
				config: expect.objectContaining({ id: 'fixture', resources: expect.any(Function) }),
				cwd: configDir,
				...(loader.name === 'command' ? { absolutePath } : {}),
			}
			expect(await loader.load(root, './app/../app/valid.ts')).toEqual(expected)
			expect(await loader.load(join(root, 'unrelated'), absolutePath)).toEqual(expected)
			expect(process.cwd()).toBe(processCwd)
		})

		test('requires a valid default export even when a named config is valid', async () => {
			for (const filename of ['named.ts', 'invalid.ts']) {
				const absolutePath = join(configDir, filename)
				await expect(loader.load(root, `app/${filename}`)).rejects.toThrow(
					`Cloudflare config at ${absolutePath} must export a valid default defineApp(...) value`,
				)
			}
		})

		test('preserves module evaluation errors', async () => {
			await expect(loader.load(root, 'app/throws.ts')).rejects.toThrow('config evaluation failed')
		})

		test('preserves the import failure for an absent config', async () => {
			await expect(loader.load(root, 'app/missing.ts')).rejects.toThrow(`Cannot find module '${join(configDir, 'missing.ts')}'`)
		})
	})
}
