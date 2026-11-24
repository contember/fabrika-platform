#!/usr/bin/env bun

import type { DeployStepResult } from '@fabrika/provider-contract'
import type { AppCli } from '@fabrika/provider-contract/app-cli'
import { parseCloudflareArgs } from './cli-args'
import { buildCloudflareCommand, deployCloudflareBundle, deployCloudflareConfig, fetchCheckToolsCommand } from './command'
import type { CloudflareDeployResult } from './provider'

const USAGE = `Internal Cloudflare app executor

Usage:
  fabrika-cloudflare-executor build --fetch-tools [--access=<file>]
  fabrika-cloudflare-executor build --env=<env> --out=<dir> [--config=<path>] [--domain=<host>] [--access=<file>] [--values=<file>] [--dry-run]
  fabrika-cloudflare-executor deploy --env=<env> --bundle=<dir> [--managed-var=<name>] [--dry-run]
  fabrika-cloudflare-executor deploy --env=<env> [--config=<path>] [--managed-var=<name>] [--dry-run]

Options:
  --env=<env>            Target environment.
  --config=<path>        App config path (default: ./fabrika.config.ts).
  --out=<dir>            build: where the bundle, assets, migrations and manifest are written.
  --bundle=<dir>         deploy: a build's output; nothing in it is imported or run.
  --domain=<host>        build: the environment's domain, which the config's resources read.
  --access=<file>        build: the access Control approved, as the runner wrote it.
  --values=<file>        build: the vars and public managed values the build may read.
  --fetch-tools          build: only fetch the tools the checks run (TypeScript, @fabrika/check).
  --managed-var=<name>   Platform-owned environment name; repeatable. Its value is read like a declared secret.
  --dry-run              Plan only; do not mutate remote resources.
  -h, --help             Show this help.

\`build\` runs the checkout's code and reads no credential. \`deploy --bundle\` runs none of it.
Credentials are read only from the environment. Declared secrets and vars are read from the file
FABRIKA_DEPLOY_VALUES_FILE names when it is set (a runner sets it), and from the environment otherwise;
\`deploy --bundle\` reads them only from that file, and runs without approved access only with --dry-run.
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
	if (args.command === 'build' && args.fetchTools) {
		await fetchCheckToolsCommand(args.access === undefined ? {} : { accessFile: args.access })
		return
	}
	if (args.command === 'build') {
		const env = args.env ?? die(`Missing --env=<env>\n\n${USAGE}`)
		const outDir = args.out ?? die(`Missing --out=<dir>\n\n${USAGE}`)
		await buildCloudflareCommand({
			env,
			configPath: args.config,
			outDir,
			...(args.domain === undefined ? {} : { domain: args.domain }),
			...(args.access === undefined ? {} : { accessFile: args.access }),
			...(args.values === undefined ? {} : { valuesFile: args.values }),
			dryRun: args.dryRun,
		})
		return
	}
	if (args.command !== 'deploy') {
		const command = args.subcommand === undefined ? args.command : `${args.command} ${args.subcommand}`
		die(`Unknown command: ${command}\n\n${USAGE}`)
	}
	const env = args.env ?? die(`Missing --env=<env>\n\n${USAGE}`)
	if (args.bundle !== undefined) {
		requireSuccessful(
			await deployCloudflareBundle({
				env,
				bundleDir: args.bundle,
				dryRun: args.dryRun,
				managedVarNames: args.managedVarNames,
				stateNamespace: process.env['CLOUDFLARE_STATE_NAMESPACE'],
			}),
		)
		return
	}
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
