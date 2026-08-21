import type { InstallationCli, InstallationCommand } from '@fabrika/installation-contract'
import { deployCloudflareConfig, parseCloudflareArgs, platformComponents } from '@fabrika/provider-cloudflare'
import { resolve } from 'node:path'
import { runInit } from './init'

const USAGE = `Cloudflare installation

Commands:
  fabrika platform init --provider=cloudflare <account>
  fabrika platform plan --provider=cloudflare --runner-config=<path> --worker-config=<path> [--env=<env>]
  fabrika platform deploy --provider=cloudflare --runner-config=<path> --worker-config=<path> [--env=<env>]
`

const deployPlatform = async (argv: readonly string[], forceDryRun: boolean): Promise<void> => {
	const args = parseCloudflareArgs(['platform', 'deploy', ...argv, ...(forceDryRun ? ['--dry-run'] : [])])
	const env = args.env ?? 'prod'
	const rootCwd = process.cwd()
	for (const component of platformComponents(args.runnerConfig, args.workerConfig)) {
		const absolute = resolve(rootCwd, component.configPath)
		const cwd = resolve(absolute, '..')
		process.chdir(cwd)
		try {
			console.info(`\n▸ ${component.label} → ${env}${args.dryRun ? ' (dry-run)' : ''}`)
			const result = await deployCloudflareConfig({ env, configPath: absolute, cwd, dryRun: args.dryRun })
			console.info(`${result.appId} → ${result.env}: ${result.status}`)
			if (result.status === 'failed') {
				throw new Error(`${component.label} deployment failed`)
			}
		} finally {
			process.chdir(rootCwd)
		}
	}
}

const run = async (command: InstallationCommand, argv: readonly string[]): Promise<void> => {
	if (command === 'init') {
		const [account, ...rest] = argv
		if (account === undefined || account === '' || account.startsWith('-')) {
			throw new Error('Cloudflare installation init requires an account name')
		}
		if (rest.length > 0) {
			throw new Error(`Unexpected Cloudflare init arguments: ${rest.join(' ')}`)
		}
		await runInit(account)
		return
	}
	if (command !== 'plan' && command !== 'deploy') {
		// The router already gates on `commands`, so this is unreachable today — and it is the branch that
		// keeps it unreachable: without it, a command added to the contract later falls through to a deploy.
		throw new Error(`Cloudflare installation does not support \`platform ${command}\``)
	}
	await deployPlatform(argv, command === 'plan')
}

export const cloudflareInstallationCli: InstallationCli = {
	provider: 'cloudflare',
	commands: ['init', 'plan', 'deploy'],
	usage: USAGE,
	run,
}
