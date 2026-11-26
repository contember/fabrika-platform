#!/usr/bin/env bun

import type { DeployStepResult } from '@fabrika/provider-contract'
import type { AppCli } from '@fabrika/provider-contract/app-cli'
import { parseCloudflareArgs } from './cli-args'
import { defaultCloudflareCollaborators } from './collaborators'
import { deployCloudflareConfig } from './command'
import { changedNothing } from './plan'
import type { CloudflareDeployResult } from './provider'
import { RUNNER_OUTCOME_FILE_ENV, type RunnerOutcomeFile } from './runner-protocol'

const USAGE = `Internal Cloudflare app executor

Usage:
  fabrika-cloudflare-executor deploy --env=<env> [--config=<path>] [--managed-var=<name>] [--dry-run]

Options:
  --env=<env>            Target environment.
  --config=<path>        App config path (default: ./fabrika.config.ts).
  --managed-var=<name>   Platform-owned environment name; repeatable. Its value is read like a declared secret.
  --dry-run              Plan only; do not mutate remote resources.
  -h, --help             Show this help.

Credentials are read only from the environment. Declared secrets and vars are read from the file
FABRIKA_DEPLOY_VALUES_FILE names when it is set (a runner sets it), and from the environment otherwise.
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
	let result: CloudflareDeployResult
	try {
		result = await deployCloudflareConfig({
			env,
			configPath: args.config,
			dryRun: args.dryRun,
			managedVarNames: args.managedVarNames,
			stateNamespace: process.env['CLOUDFLARE_STATE_NAMESPACE'],
		})
	} catch (error) {
		if (!args.dryRun) await reportOutcome(failedDeployOutcome('threw'))
		throw error
	}
	if (result.status === 'failed' && !args.dryRun) await reportOutcome(failedDeployOutcome(result))
	requireSuccessful(result)
}

/**
 * What a failed deploy reports to the runner, always, so a file the checkout's build left at the path never speaks for
 * it. `threw` is a deploy that failed before its first step: `runSteps` keeps every step's error in its result.
 */
export const failedDeployOutcome = (result: CloudflareDeployResult | 'threw'): RunnerOutcomeFile => ({
	untouched: result === 'threw' || changedNothing(result.steps),
})

/**
 * Tell the runner what a failed deploy left alone, so Control can end the maintenance it entered for the deploy. Only a
 * runner names the file; a failed write leaves the report absent, which Control reads as "may have changed something".
 */
const reportOutcome = async (outcome: RunnerOutcomeFile): Promise<void> => {
	if ((process.env[RUNNER_OUTCOME_FILE_ENV] ?? '') === '') return
	await defaultCloudflareCollaborators.writeOutcome(outcome).catch(() => {})
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
