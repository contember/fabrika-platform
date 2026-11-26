import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { failedDeployOutcome } from '../cli'
import type { CloudflareDeployResult } from '../provider'
import { RUNNER_OUTCOME_FILE_ENV } from '../runner-protocol'

const CLI = resolve(import.meta.dir, '../cli.ts')
// Its config answers the two oblaka state reads for account `smoke-account` and refuses every other request.
const SMOKE_DIR = resolve(import.meta.dir, '../../../runner-container/docker/smoke')

const runCli = (args: readonly string[], accountId: string, extraEnv: Readonly<Record<string, string>> = {}) => {
	const child = Bun.spawnSync(['bun', CLI, ...args], {
		cwd: SMOKE_DIR,
		env: { PATH: process.env['PATH'] ?? '', CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'fake-token', ...extraEnv },
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

	test('a deploy that failed in provisioning reports itself untouched to the runner; a dry run reports nothing', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'fabrika-executor-outcome-'))
		try {
			const outcomeFile = join(workspace, 'run.outcome.json')
			const failed = runCli(['deploy', '--env=stage'], 'other-account', { [RUNNER_OUTCOME_FILE_ENV]: outcomeFile })
			expect(failed.exitCode).toBe(1)
			expect(failed.stdout).toContain('  ✗ provision-resources — failed')
			expect(JSON.parse(await readFile(outcomeFile, 'utf8'))).toEqual({ untouched: true })

			await rm(outcomeFile)
			const dry = runCli(['deploy', '--env=stage', '--dry-run'], 'other-account', { [RUNNER_OUTCOME_FILE_ENV]: outcomeFile })
			expect(dry.exitCode).toBe(1)
			expect(await Bun.file(outcomeFile).exists()).toBe(false)
		} finally {
			await rm(workspace, { recursive: true, force: true })
		}
	})

	test('a failed deploy reports untouched only while no step that changes data or a Worker ran', () => {
		const result = (steps: CloudflareDeployResult['steps']): CloudflareDeployResult => ({ appId: 'a', env: 'stage', status: 'failed', steps })
		expect(failedDeployOutcome('threw')).toEqual({ untouched: true })
		expect(failedDeployOutcome(result([{ id: 'check', status: 'failed' }, { id: 'deploy-worker', status: 'skipped' }]))).toEqual({ untouched: true })
		expect(failedDeployOutcome(result([{ id: 'provision-resources', status: 'succeeded' }, { id: 'migrate:DB', status: 'failed' }]))).toEqual({
			untouched: false,
		})
		expect(failedDeployOutcome(result([{ id: 'provision-resources', status: 'succeeded' }, { id: 'deploy-worker', status: 'failed' }]))).toEqual({
			untouched: false,
		})
	})

	test('exits 1 without deploying when the environment is missing', () => {
		const result = runCli(['deploy'], 'smoke-account')

		expect(result.exitCode).toBe(1)
		expect(result.stderr).toStartWith('fabrika-cloudflare-executor: Missing --env=<env>')
		expect(result.stdout).toBe('')
	})
})
