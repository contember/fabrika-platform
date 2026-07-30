#!/usr/bin/env bun

import { installationCliFromModule, isInstallationCommand, supportsInstallationCommand } from '@fabrika/installation-contract'
import { authoredAppProvider } from '@fabrika/provider-contract'
import { resolve } from 'node:path'

const USAGE = `fabrika — application platform CLI

Usage:
  fabrika platform init --provider=<cloudflare|zerops> [provider options]
  fabrika platform plan --provider=<cloudflare|zerops> [provider options]
  fabrika platform deploy --provider=<cloudflare|zerops> [provider options]
  fabrika app deploy [--provider=cloudflare] --env=<env> [--config=<path>] [--dry-run]
  fabrika app build [--provider=zerops] --env=<env> [--config=<path>] [--output=<path>]
  fabrika namespace <plan|create|adopt|reconcile> --provider=zerops [provider options]

For app commands, the provider is read from the config returned by the selected provider's defineApp().
An explicit --provider is required only when no app config is available.
`

export interface ParsedCommand {
	readonly area: string | undefined
	readonly command: string | undefined
	readonly provider: string | undefined
	readonly rest: string[]
	readonly help: boolean
}

export const parseCliArgs = (argv: readonly string[]): ParsedCommand => {
	let area: string | undefined
	let command: string | undefined
	let provider: string | undefined
	let help = false
	const rest: string[] = []
	for (const arg of argv) {
		if (arg === '-h' || arg === '--help') {
			help = true
		} else if (arg.startsWith('--provider=')) {
			provider = arg.slice('--provider='.length)
		} else if (area === undefined && !arg.startsWith('-')) {
			area = arg
		} else if (command === undefined && !arg.startsWith('-')) {
			command = arg
		} else {
			rest.push(arg)
		}
	}
	return { area, command, provider, rest, help }
}

const configPath = (argv: readonly string[]): string => {
	const option = argv.find((arg) => arg.startsWith('--config='))
	return option === undefined ? './fabrika.config.ts' : option.slice('--config='.length)
}

export const providerFromConfig = async (argv: readonly string[]): Promise<string | undefined> => {
	const absolute = resolve(process.cwd(), configPath(argv))
	const file = Bun.file(absolute)
	if (!(await file.exists())) {
		return undefined
	}
	const loaded: unknown = await import(absolute)
	if (typeof loaded !== 'object' || loaded === null) {
		return undefined
	}
	return authoredAppProvider(Reflect.get(loaded, 'default'))
}

const requireExplicitProvider = (parsed: ParsedCommand): string => {
	const provider = parsed.provider
	if (provider === undefined || provider === '') {
		throw new Error('Provider is required. Pass --provider=<cloudflare|zerops>.')
	}
	return provider
}

const selectedAppProvider = async (parsed: ParsedCommand): Promise<string> => {
	const inferred = await providerFromConfig(parsed.rest)
	if (parsed.provider !== undefined && inferred !== undefined && parsed.provider !== inferred) {
		throw new Error(`App config belongs to provider "${inferred}", but --provider=${parsed.provider} was requested.`)
	}
	const provider = inferred ?? parsed.provider
	if (provider === undefined || provider === '') {
		throw new Error('Provider is required. Pass --provider=<cloudflare|zerops> or default-export a provider defineApp() config.')
	}
	return provider
}

const installationModule = async (provider: string): Promise<unknown> => {
	const packageName = provider === 'cloudflare'
		? '@fabrika/installation-cloudflare'
		: provider === 'zerops'
		? '@fabrika/installation-zerops'
		: provider
	return import(packageName)
}

export type AppCliRunner = (argv: readonly string[]) => Promise<void>

export const appCliRunnerFromModule = (loaded: unknown, packageName: string, exportName: string): AppCliRunner => {
	if (typeof loaded !== 'object' || loaded === null || !(exportName in loaded)) {
		throw new Error(`${packageName} must export \`${exportName}\``)
	}
	const runner = Reflect.get(loaded, exportName)
	if (typeof runner !== 'function') {
		throw new Error(`${packageName} must export \`${exportName}\` as a function`)
	}
	return runner
}

const appCliRunner = async (packageName: string, exportName: string): Promise<AppCliRunner> => {
	const loaded: unknown = await import(packageName)
	return appCliRunnerFromModule(loaded, packageName, exportName)
}

const runPlatform = async (parsed: ParsedCommand): Promise<void> => {
	if (!isInstallationCommand(parsed.command)) {
		throw new Error(`Unknown platform command: ${parsed.command ?? '(missing)'}`)
	}
	const provider = requireExplicitProvider(parsed)
	const expectedProvider = provider === 'cloudflare' || provider === 'zerops' ? provider : undefined
	const installation = installationCliFromModule(await installationModule(provider), expectedProvider)
	if (!supportsInstallationCommand(installation, parsed.command)) {
		throw new Error(`${installation.provider} installation does not support \`platform ${parsed.command}\`\n\n${installation.usage}`)
	}
	await installation.run(parsed.command, parsed.rest)
}

const runApp = async (parsed: ParsedCommand): Promise<void> => {
	const provider = await selectedAppProvider(parsed)
	if (provider === 'cloudflare') {
		if (parsed.command !== 'deploy') {
			throw new Error(`Cloudflare app tooling does not support \`app ${parsed.command ?? '(missing)'}\``)
		}
		const runCloudflareCli = await appCliRunner('@fabrika/provider-cloudflare/cli', 'runCloudflareCli')
		await runCloudflareCli(['deploy', ...parsed.rest])
		return
	}
	if (provider === 'zerops') {
		if (parsed.command !== 'build') {
			throw new Error(`Zerops app tooling does not support \`app ${parsed.command ?? '(missing)'}\``)
		}
		const runZeropsCli = await appCliRunner('@fabrika/provider-zerops/cli', 'runZeropsCli')
		await runZeropsCli(['build', ...parsed.rest])
		return
	}
	throw new Error(`Provider ${provider} does not expose app CLI commands`)
}

const runNamespace = async (parsed: ParsedCommand): Promise<void> => {
	const provider = requireExplicitProvider(parsed)
	if (provider !== 'zerops') {
		throw new Error(`Provider ${provider} does not expose deployment namespaces`)
	}
	if (parsed.command === undefined) {
		throw new Error('Namespace command is required')
	}
	const runZeropsCli = await appCliRunner('@fabrika/provider-zerops/cli', 'runZeropsCli')
	await runZeropsCli(['namespace', parsed.command, ...parsed.rest])
}

export const runCli = async (argv: readonly string[]): Promise<void> => {
	const parsed = parseCliArgs(argv)
	if (parsed.help || parsed.area === undefined) {
		console.info(USAGE)
		return
	}
	if (parsed.area === 'platform') {
		await runPlatform(parsed)
		return
	}
	if (parsed.area === 'app') {
		await runApp(parsed)
		return
	}
	if (parsed.area === 'namespace') {
		await runNamespace(parsed)
		return
	}
	throw new Error(`Unknown command area: ${parsed.area}\n\n${USAGE}`)
}

if (import.meta.main) {
	await runCli(process.argv.slice(2)).catch((error: unknown) => {
		console.error(`fabrika: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	})
}
