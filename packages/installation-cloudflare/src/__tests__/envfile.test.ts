import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountEnvDirectory, envPath, openEnvFile, parseEnvFile, persistEnvBundle, persistEnvBundleAt } from '../envfile'

const directories: string[] = []

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** Point XDG at a throwaway directory for the length of one test. */
async function withConfigHome(run: (configHome: string) => Promise<void>): Promise<void> {
	const configHome = await mkdtemp(join(tmpdir(), 'fabrika-cloudflare-xdg-'))
	directories.push(configHome)
	const previous = process.env['XDG_CONFIG_HOME']
	process.env['XDG_CONFIG_HOME'] = configHome
	try {
		await run(configHome)
	} finally {
		if (previous === undefined) delete process.env['XDG_CONFIG_HOME']
		else process.env['XDG_CONFIG_HOME'] = previous
	}
}

describe('Cloudflare installer env persistence', () => {
	test('atomically replaces one complete bundle with owner-only permissions', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'fabrika-cloudflare-env-'))
		directories.push(directory)
		const path = join(directory, '.env')
		await writeFile(path, "UNRELATED='preserved'\n", { mode: 0o644 })

		await persistEnvBundleAt(path, {
			GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----',
			GITHUB_WEBHOOK_SECRET: 'webhook-secret',
		})

		const contents = await readFile(path, 'utf8')
		expect(contents).toContain("UNRELATED='preserved'")
		expect(contents).toContain('GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\nprivate\\n-----END PRIVATE KEY-----"')
		expect(contents).toContain("GITHUB_WEBHOOK_SECRET='webhook-secret'")
		expect((await stat(path)).mode & 0o777).toBe(0o600)
		expect(await Array.fromAsync(new Bun.Glob('.env.*.tmp').scan({ cwd: directory }))).toEqual([])
	})
})

describe('Cloudflare installer env file location', () => {
	test('lives under the per-account config directory, never the cwd', async () => {
		await withConfigHome(async (configHome) => {
			const path = await openEnvFile('mangoweb')

			expect(path).toBe(join(configHome, 'fabrika', 'cloudflare', 'mangoweb', '.env'))
			expect(envPath()).toBe(path)
			expect(path.startsWith(process.cwd())).toBe(false)
			expect((await stat(join(configHome, 'fabrika', 'cloudflare', 'mangoweb'))).mode & 0o777).toBe(0o700)
		})
	})

	test('an account that is not one path segment is refused', () => {
		expect(() => accountEnvDirectory('../../etc')).toThrow('cannot name a config directory')
		expect(() => accountEnvDirectory('a/b')).toThrow('cannot name a config directory')
	})

	test('a persisted bundle lands there at 0600 and resumes into process.env', async () => {
		await withConfigHome(async () => {
			delete process.env['A_RESUMED_KEY']
			await openEnvFile('mangoweb')
			await persistEnvBundle({ A_RESUMED_KEY: 'kept-$value', A_RESUMED_PEM: '-----BEGIN-----\nbody\n-----END-----' })
			expect((await stat(envPath())).mode & 0o777).toBe(0o600)

			delete process.env['A_RESUMED_KEY']
			delete process.env['A_RESUMED_PEM']
			await openEnvFile('mangoweb')
			expect(process.env['A_RESUMED_KEY']).toBe('kept-$value')
			expect(process.env['A_RESUMED_PEM']).toBe('-----BEGIN-----\nbody\n-----END-----')
			delete process.env['A_RESUMED_KEY']
			delete process.env['A_RESUMED_PEM']
		})
	})

	test('decodes both quoting styles and ignores anything else', () => {
		expect(parseEnvFile("A='plain'\nB=\"line\\none\"\nexport C='c'\n# comment\n\nD=bare\n")).toEqual({
			A: 'plain',
			B: 'line\none',
			C: 'c',
			D: 'bare',
		})
	})
})
