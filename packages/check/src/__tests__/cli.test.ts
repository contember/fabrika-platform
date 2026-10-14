import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CLEAN_APPLICATION } from './helpers'

const CLI = join(import.meta.dir, '..', 'cli.ts')
const roots: string[] = []

const application = async (files: Readonly<Record<string, string>>): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), 'fabrika-check-'))
	roots.push(root)
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), text)
	}
	return root
}

const run = async (...args: string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> => {
	const child = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
	const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
	return { code, stdout, stderr }
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fabrika-check', () => {
	test('refuses an application that stands in for @fabrika/app by self-reference, which Bun resolves', async () => {
		const root = await application({
			...CLEAN_APPLICATION,
			'package.json': '{ "name": "@fabrika/app", "type": "module", "exports": { "./build": "./dist/build.js" } }\n',
			'dist/build.js': "export const origin = 'the application'\n",
			'probe.mjs': "const build = await import('@fabrika/app/build')\nconsole.log(build.origin)\n",
		})
		const probe = Bun.spawn(['bun', join(root, 'probe.mjs')], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
		expect((await new Response(probe.stdout).text()).trim()).toBe('the application')

		const result = await run(root)

		expect(result.stdout).toContain('package.json:1:3 package-replacement the package is named @fabrika/app')
		expect(result.stdout).toContain('package.json:1:45 package-replacement an exports map')
	})

	test('reads the root .npmrc and bun.lock from disk, and still no other dot entry', async () => {
		const root = await application({
			...CLEAN_APPLICATION,
			'.npmrc': '@fabrika:registry=https://registry.example.test\n',
			'bun.lock': '{\n  "packages": {\n    "dep/@fabrika/app": ["@fabrika/app@file:../app", {}],\n  },\n}\n',
			'.hidden/config.ts': 'export const url = process.env.DATABASE_URL\n',
		})

		const result = await run(root)

		expect(result.stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
			'.npmrc:1:1 package-replacement',
			'bun.lock:3:5 package-replacement',
		])
	})

	test('prints one actionable line per finding and exits 1', async () => {
		const root = await application({ ...CLEAN_APPLICATION, 'src/config.ts': 'export const url = process.env.DATABASE_URL\n' })

		const result = await run(root)

		expect(result.code).toBe(1)
		expect(result.stdout).toBe(
			'src/config.ts:1:20 env-read process.env is read outside the generated entrypoint (allowed form: values the framework hands the handler through deps or ctx)\n',
		)
		expect(result.stderr).toBe('fabrika-check: 1 refusal, 0 hints\n')
	})

	test('reads no build output, installed package or dot-directory', async () => {
		const root = await application({
			...CLEAN_APPLICATION,
			'dist/app/index.js': 'document.body.innerHTML = location.hash',
			'node_modules/pg/index.ts': 'export const url = process.env.DATABASE_URL',
			'.lopata/state.ts': 'export const key = "px_live"',
		})

		const result = await run(root)

		expect(result).toEqual({ code: 0, stdout: '', stderr: 'fabrika-check: 0 refusals, 0 hints\n' })
	})

	test('reports a symbolic link instead of following it', async () => {
		const outside = await application({ 'serve.ts': 'Bun.serve({ fetch: () => new Response() })\n' })
		const root = await application({ ...CLEAN_APPLICATION, 'src/main.ts': "import './linked'\n" })
		await symlink(join(outside, 'serve.ts'), join(root, 'src', 'linked.ts'))

		const result = await run(root)

		expect(result.code).toBe(1)
		expect(result.stdout).toBe(
			'src/linked.ts:1:1 unchecked-import a symbolic link, which the checker does not follow (allowed form: a regular file or directory inside the application)\n',
		)
	})

	test('refuses an unknown argument with exit 2', async () => {
		const result = await run('--fix')

		expect(result.code).toBe(2)
		expect(result.stderr).toStartWith("fabrika-check: unexpected argument '--fix'")
	})
})

describe('fabrika-check --packed', () => {
	const VERSION = '0.3.3-local.abc1234'
	const tarballOf = (name: string): string => `fabrika-${name}-${VERSION}.tgz`
	const integrity = (bytes: string): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
	const NAMES = ['app', 'db']
	const bytesOf = (name: string): string => `the packed bytes of @fabrika/${name}`

	/** The release manifest of a local pack of @fabrika/app and @fabrika/db, written outside the application. */
	const manifest = async (): Promise<string> => {
		const directory = await application({
			'release-manifest.json': JSON.stringify({
				tag: `v${VERSION}`,
				version: VERSION,
				packages: NAMES.map((name) => ({ name: `@fabrika/${name}`, filename: tarballOf(name), dependencies: [], integrity: integrity(bytesOf(name)) })),
			}),
		})
		return join(directory, 'release-manifest.json')
	}

	/** An application installed from the pack's block, as `bun install` leaves it; `bytes` stands in for a tarball. */
	const packedApplication = (bytes: (name: string) => string = bytesOf, overrides: Readonly<Record<string, string>> = {}) => {
		const block = Object.fromEntries(NAMES.map((name) => [`@fabrika/${name}`, `file:vendor/${tarballOf(name)}`]))
		return application({
			'package.json': `${JSON.stringify({ name: 'notes', private: true, dependencies: block, overrides: { ...block, ...overrides } }, null, '\t')}\n`,
			'bun.lock': `${
				JSON.stringify(
					{
						lockfileVersion: 1,
						packages: Object.fromEntries(
							NAMES.map((name) => [`@fabrika/${name}`, [`@fabrika/${name}@vendor/${tarballOf(name)}`, {}, integrity(bytesOf(name))]]),
						),
					},
					null,
					'\t',
				)
			}\n`,
			...Object.fromEntries(NAMES.map((name) => [`vendor/${tarballOf(name)}`, bytes(name)])),
		})
	}

	const refusals = (stdout: string): string[] => stdout.split('\n').filter((line) => line !== '').map((line) => line.split(' ').slice(0, 2).join(' '))

	test('without --packed, the tarballs, the overrides and their lockfile entries are refused', async () => {
		const result = await run(await packedApplication())

		expect(result.code).toBe(1)
		expect(refusals(result.stdout)).toEqual([
			'bun.lock:4:3 package-replacement',
			'bun.lock:9:3 package-replacement',
			'package.json:5:3 package-replacement',
			'package.json:6:3 package-replacement',
			'package.json:8:2 package-replacement',
		])
	})

	test('with the manifest of the pack, the same application passes and the run says it took a local pack', async () => {
		const result = await run('--packed', await manifest(), await packedApplication())

		expect(result).toEqual({
			code: 0,
			stdout: '',
			stderr: `fabrika-check: accepting the tarballs of the local pack ${VERSION}, which no deploy build does\nfabrika-check: 0 refusals, 0 hints\n`,
		})
	})

	test('a tarball whose bytes differ from the manifest is refused at each place that names it', async () => {
		const root = await packedApplication((name) => (name === 'db' ? 'other bytes under the same name' : bytesOf(name)))

		const result = await run(`--packed=${await manifest()}`, root)

		expect(result.code).toBe(1)
		expect(refusals(result.stdout)).toEqual([
			'bun.lock:9:3 package-replacement',
			'package.json:6:3 package-replacement',
			'package.json:8:2 package-replacement',
		])
	})

	test('an override of a package outside the set is still refused', async () => {
		const result = await run('--packed', await manifest(), await packedApplication(bytesOf, { zod: 'npm:other-zod@1.0.0' }))

		expect(refusals(result.stdout)).toEqual(['package.json:8:2 package-replacement'])
	})

	test('a manifest that is not a release manifest is a read error', async () => {
		const directory = await application({ 'release-manifest.json': '{ "version": "0.3.3" }' })

		const result = await run('--packed', join(directory, 'release-manifest.json'), await packedApplication())

		expect(result.code).toBe(2)
		expect(result.stderr).toContain('does not name each package with its tarball and sha512 integrity')
	})
})
