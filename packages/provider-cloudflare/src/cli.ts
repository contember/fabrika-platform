#!/usr/bin/env bun

import type { ProviderDeployResult } from '@fabrika/provider-contract'
import { parseCloudflareArgs } from './cli-args'
import { deployCloudflareConfig } from './command'

const USAGE = `Internal Cloudflare app executor

Usage:
  fabrika-cloudflare-executor deploy --env=<env> [--config=<path>] [--dry-run]

Options:
  --env=<env>            Target environment.
  --config=<path>        App config path (default: ./fabrika.config.ts).
  --dry-run              Plan only; do not mutate remote resources.
  -h, --help             Show this help.

Credentials, declared secrets and declared vars are read only from the environment.
`

const die = (message: string): never => {
	throw new Error(message)
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
		throw new Error('Cloudflare deployment failed')
	}
}

export const runCloudflareCli = async (argv: readonly string[]): Promise<void> => {
	const args = parseCloudflareArgs(argv)
	if (args.help || args.command === undefined) {
		console.log(USAGE)
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

if (import.meta.main) {
	await runCloudflareCli(process.argv.slice(2)).catch((error: unknown) => {
		console.error(`fabrika-cloudflare-executor: ${error instanceof Error ? error.message : 'unknown error'}`)
		process.exit(1)
	})
}
