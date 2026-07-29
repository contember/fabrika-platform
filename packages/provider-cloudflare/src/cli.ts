#!/usr/bin/env bun

import type { ProviderDeployResult } from '@fabrika/provider-contract'
import { resolve } from 'node:path'
import { parseCloudflareArgs, platformComponents } from './cli-args'
import { deployCloudflareConfig } from './command'

const USAGE = `fabrika-cloudflare — Cloudflare deploy provider

Usage:
  fabrika-cloudflare deploy --env=<env> [--config=<path>] [--dry-run]
  fabrika-cloudflare platform deploy [--env=<env>] --runner-config=<path> --worker-config=<path> [--build-runner-image] [--dry-run]

Options:
  --env=<env>            Target environment. Required for deploy; platform deploy defaults to prod.
  --config=<path>        App config path (default: ./fabrika.config.ts).
  --runner-config=<path> Runner config for platform deploy.
  --worker-config=<path> Control-plane config for platform deploy.
  --build-runner-image   Build the runner image from its Dockerfile.
  --dry-run              Plan only; do not mutate remote resources.
  -h, --help             Show this help.

Credentials, declared secrets and declared vars are read only from the environment.
`

const die = (message: string): never => {
	console.error(message)
	process.exit(1)
}

const formatDuration = (step: ProviderDeployResult['steps'][number]): string => {
	if (step.startedAt === undefined || step.finishedAt === undefined) {
		return ''
	}
	return ` (${step.finishedAt - step.startedAt}ms)`
}

const ICON: Readonly<Record<string, string>> = {
	pending: '·',
	running: '…',
	succeeded: '✓',
	failed: '✗',
	skipped: '∅',
}

const printResult = (result: ProviderDeployResult): void => {
	console.log(`\n${result.appId} → ${result.env}: ${result.status}`)
	for (const step of result.steps) {
		console.log(`  ${ICON[step.status] ?? '?'} ${step.spec.id} — ${step.status}${formatDuration(step)}`)
		if (step.error !== undefined) {
			console.log(`      ${step.error}`)
		}
	}
}

const requireSuccessful = (result: ProviderDeployResult): void => {
	printResult(result)
	if (result.status === 'failed') {
		process.exit(1)
	}
}

const runPlatformDeploy = async (
	env: string,
	runnerConfig: string | undefined,
	workerConfig: string | undefined,
	buildRunnerImage: boolean,
	dryRun: boolean,
): Promise<void> => {
	if (buildRunnerImage) {
		process.env['RUNNER_BUILD'] = '1'
	}
	const rootCwd = process.cwd()
	for (const component of platformComponents(runnerConfig, workerConfig)) {
		const absolute = resolve(rootCwd, component.configPath)
		const cwd = resolve(absolute, '..')
		process.chdir(cwd)
		try {
			console.log(`\n▸ ${component.label} → ${env}${dryRun ? ' (dry-run)' : ''} (idempotent — safe to re-run)`)
			requireSuccessful(await deployCloudflareConfig({ env, configPath: absolute, cwd, dryRun }))
		} finally {
			process.chdir(rootCwd)
		}
	}
}

const main = async (): Promise<void> => {
	const args = parseCloudflareArgs(process.argv.slice(2))
	if (args.help || args.command === undefined) {
		console.log(USAGE)
		process.exit(args.help ? 0 : 1)
	}
	if (args.command === 'platform' && args.subcommand === 'deploy') {
		await runPlatformDeploy(args.env ?? 'prod', args.runnerConfig, args.workerConfig, args.buildRunnerImage, args.dryRun)
		return
	}
	if (args.command !== 'deploy') {
		const command = args.subcommand === undefined ? args.command : `${args.command} ${args.subcommand}`
		die(`Unknown command: ${command}\n\n${USAGE}`)
	}
	const env = args.env ?? die(`Missing --env=<env>\n\n${USAGE}`)
	requireSuccessful(
		await deployCloudflareConfig({
			env,
			configPath: args.config,
			dryRun: args.dryRun,
			stateNamespace: process.env['CLOUDFLARE_STATE_NAMESPACE'],
		}),
	)
}

await main().catch((error: unknown) => {
	console.error(`fabrika-cloudflare: ${error instanceof Error ? error.message : 'unknown error'}`)
	process.exit(1)
})
