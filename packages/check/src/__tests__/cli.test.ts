import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
	test('prints one actionable line per finding and exits 1', async () => {
		const root = await application({ ...CLEAN_APPLICATION, 'src/config.ts': 'export const url = process.env.DATABASE_URL\n' })

		const result = await run(root)

		expect(result.code).toBe(1)
		expect(result.stdout).toBe(
			'src/config.ts:1:20 env-read process.env is read outside the generated entrypoint (allowed form: values the framework hands the handler through deps or ctx)\n',
		)
		expect(result.stderr).toBe('fabrika-check: 1 finding\n')
	})

	test('reads no build output, installed package or dot-directory', async () => {
		const root = await application({
			...CLEAN_APPLICATION,
			'dist/app/index.js': 'document.body.innerHTML = location.hash',
			'node_modules/pg/index.ts': 'export const url = process.env.DATABASE_URL',
			'.lopata/state.ts': 'export const key = "px_live"',
		})

		const result = await run(root)

		expect(result).toEqual({ code: 0, stdout: '', stderr: 'fabrika-check: 0 findings\n' })
	})

	test('refuses an unknown argument with exit 2', async () => {
		const result = await run('--fix')

		expect(result.code).toBe(2)
		expect(result.stderr).toStartWith("fabrika-check: unexpected argument '--fix'")
	})
})
