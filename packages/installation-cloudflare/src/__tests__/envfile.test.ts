import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistEnvBundleAt } from '../envfile'

const directories: string[] = []

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

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
