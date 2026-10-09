import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const CLI = resolve(import.meta.dir, '../cli.ts')
// Its config answers the two oblaka state reads for account `smoke-account` and refuses every other request.
const SMOKE_DIR = resolve(import.meta.dir, '../../../runner-container/docker/smoke')

const runCli = (args: readonly string[], accountId: string) => {
	const child = Bun.spawnSync(['bun', CLI, ...args], {
		cwd: SMOKE_DIR,
		env: { PATH: process.env['PATH'] ?? '', CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'fake-token' },
	})
	return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

describe('fabrika-cloudflare-executor', () => {
	test('exits 0 and prints the result block for a successful dry run', () => {
		const result = runCli(['deploy', '--env=stage', '--dry-run'], 'smoke-account')

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('Deploy smoke-app → stage (dry-run) — 3 step(s):')
		expect(result.stdout).toContain('\nsmoke-app → stage: succeeded\n')
		expect(result.stdout).toContain('  ✓ deploy-worker — succeeded')
		expect(result.stderr).toBe('')
	})

	test('exits 1 after printing the result block of a failed deploy', () => {
		const result = runCli(['deploy', '--env=stage', '--dry-run'], 'other-account')

		expect(result.exitCode).toBe(1)
		expect(result.stdout).toContain('\nsmoke-app → stage: failed\n')
		expect(result.stdout).toContain('  ✗ provision-resources — failed')
		expect(result.stdout).toContain('  ∅ deploy-worker — skipped')
		expect(result.stderr).toBe('fabrika-cloudflare-executor: Cloudflare deployment failed\n')
	})

	test('exits 1 without deploying when the environment is missing', () => {
		const result = runCli(['deploy'], 'smoke-account')

		expect(result.exitCode).toBe(1)
		expect(result.stderr).toStartWith('fabrika-cloudflare-executor: Missing --env=<env>')
		expect(result.stdout).toBe('')
	})
})
