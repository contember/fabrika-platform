/**
 * Deploy the Cloudflare runner executor out of band.
 *
 * Required environment: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN.
 * Optional: VOZKA_ENV (defaults to prod), RUNNER_BUILD=1.
 */

import { deployCloudflareConfig } from '@fabrika/provider-cloudflare'
import { resolve } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const env = process.env['VOZKA_ENV'] ?? 'prod'

const main = async (): Promise<void> => {
	const cwd = resolve(import.meta.dir, '..')
	console.log(`Deploying vozka-runner → ${env}${dryRun ? ' (dry-run)' : ''} (idempotent — safe to re-run).`)
	if (process.env['RUNNER_BUILD'] === '1') {
		console.log('  RUNNER_BUILD=1 — building the container image from the Dockerfile.')
	}

	process.chdir(cwd)
	const result = await deployCloudflareConfig({
		env,
		configPath: resolve(cwd, 'fabrika-runner.config.ts'),
		cwd,
		dryRun,
	})
	console.log(`\n${result.appId} → ${result.env}: ${result.status}`)
	for (const step of result.steps) {
		console.log(`  ${step.status.padEnd(10)} ${step.spec.id}${step.error === undefined ? '' : ` — ${step.error}`}`)
	}
	if (result.status === 'failed') {
		process.exit(1)
	}
}

main().catch((error: unknown) => {
	console.error(`\n✗ ${error instanceof Error ? error.message : 'unknown error'}`)
	process.exit(1)
})
