import { afterEach, describe, expect, test } from 'bun:test'
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
