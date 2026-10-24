#!/usr/bin/env bun

import type { DeployStepResult } from '@fabrika/provider-contract'
import type { AppCli } from '@fabrika/provider-contract/app-cli'
import { parseCloudflareArgs } from './cli-args'
import { deployCloudflareConfig } from './command'
import type { CloudflareDeployResult } from './provider'

const USAGE = `Internal Cloudflare app executor

Usage:
  fabrika-cloudflare-executor deploy --env=<env> [--config=<path>] [--managed-var=<name>] [--dry-run]

Options:
  --env=<env>            Target environment.
  --config=<path>        App config path (default: ./fabrika.config.ts).
  --managed-var=<name>   Platform-owned environment name; repeatable. Values stay in the environment.
  --dry-run              Plan only; do not mutate remote resources.
  -h, --help             Show this help.

Credentials, declared secrets and declared vars are read only from the environment.
`

const die = (message: string): never => {
	throw new Error(message)
}

const formatDuration = (step: DeployStepResult): string => {
	if (step.startedAt === undefined || step.finishedAt === undefined) {
		return ''
	}
	return ` (${step.finishedAt - step.startedAt}ms)`
}

const ICON: Readonly<Record<DeployStepResult['status'], string>> = {
	succeeded: '✓',
	failed: '✗',
	skipped: '∅',
}

const printResult = (result: CloudflareDeployResult): void => {
	console.log(`\n${result.appId} → ${result.env}: ${result.status}`)
	for (const step of result.steps) {
		console.log(`  ${ICON[step.status]} ${step.id} — ${step.status}${formatDuration(step)}`)
		if (step.error !== undefined) {
			console.log(`      ${step.error}`)
		}
	}
}

const requireSuccessful = (result: CloudflareDeployResult): void => {
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
			managedVarNames: args.managedVarNames,
			stateNamespace: process.env['CLOUDFLARE_STATE_NAMESPACE'],
		}),
	)
}

/**
 * What `fabrika app build` and `app deploy` run for an application on Cloudflare. A contract application's build is its
 * generated Worker entry, which the `fabrika` command writes; there is nothing else to build.
 */
export const appCli: AppCli = {
	provider: 'cloudflare',
	entryRuntime: 'cloudflare',
	build: async (_argv, { contract }) => {
		if (!contract) throw new Error('Cloudflare app tooling does not support `app build` for an application without fabrika.contract.ts')
	},
	deploy: (argv) => runCloudflareCli(['deploy', ...argv]),
}

if (import.meta.main) {
	await runCloudflareCli(process.argv.slice(2)).catch((error: unknown) => {
		console.error(`fabrika-cloudflare-executor: ${error instanceof Error ? error.message : 'unknown error'}`)
		process.exit(1)
	})
}
