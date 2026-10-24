#!/usr/bin/env bun

import { CONTRACT_FILE, type EntryRuntime, writeGeneratedEntry } from '@fabrika/app/build'
import { authoredAppProvider } from '@fabrika/provider-contract'
import { type AppCli, appCliFromModule, type NamespaceCli } from '@fabrika/provider-contract/app-cli'
import { installationCliFromModule, isInstallationCommand, supportsInstallationCommand } from '@fabrika/provider-contract/installation'
import { dirname, join, relative, resolve } from 'node:path'
import { CONTROL_USAGE, registerCompiledManifest, runControlCli } from './control.js'

const USAGE = `fabrika — application platform CLI

Usage:
  fabrika platform guide --provider=zerops
  fabrika platform install --provider=zerops [provider options]
  fabrika platform init --provider=<cloudflare|zerops> [provider options]
  fabrika platform plan --provider=<cloudflare|zerops> [provider options]
  fabrika platform deploy --provider=<cloudflare|zerops> [provider options]
  fabrika platform admin --provider=zerops --email=<address> [provider options]
  fabrika platform upgrade --provider=zerops --to=<tag> [<installation>] [--sidecar=<path>|<owner>/<name>]
  fabrika app deploy [--provider=cloudflare] --env=<env> [--config=<path>] [--dry-run]
  fabrika app build [--provider=zerops] --env=<env> [--config=<path>] [--output=<path>]
  fabrika app build --provider=cloudflare [--config=<path>]
  fabrika app dev [--port=<n>] [--host=<loopback address>]
  fabrika app register [--provider=zerops] --env=<env> --app=<id> --repo=<url> [--config=<path>]
                       [--domain=<host>] [--public-origin=<url>] [--trigger-ref=<ref>]
                       [--namespace=<id>] [--installation-id=<n|none>] [--url=<origin>] [--json]
  fabrika namespace <plan|create|adopt|reconcile> --provider=zerops [provider options]
  fabrika control <key|apps|namespaces|register|deploy|runs> [options]
  fabrika builder <init|next|advance|gate|ensure-daemon|induce|build> [options]
  fabrika db <new|migrate|codegen|test-scaffold|test-isolation> [options]
  fabrika job run <name>
  fabrika connect <add|pull> <app>/<export>@<version> --consumer=<app> --env=<env> [--url=<control origin>]

Installing the platform on Zerops? Run \`fabrika platform guide --provider=zerops\` first: the whole bring-up
in order, what to ask the human for, and the traps.

For app commands, the provider is read from the config returned by the selected provider's defineApp().
An explicit --provider is required only when no app config is available.

\`app build\` first writes fabrika/entry.generated.ts for a contract application (one with fabrika.contract.ts next
to its config); on Cloudflare that is all it does.

\`app dev\` serves a contract application through its test kit on a loopback port, to click through its screens.
Run \`fabrika app dev --help\` for its surface.

\`app register\` compiles the manifest in memory, exactly as \`app build\` would, and sends the request
\`control register --manifest=<path>\` sends for it. It writes no file, CREATES only, and reads the
control credential from FABRIKA_CONTROL_KEY alone; a changed manifest is \`control apps environments put\`.
A bare \`--trigger-ref\` is a branch (\`deploy/prod\` deploys on a push to \`refs/heads/deploy/prod\`); a tag needs
\`refs/tags/<tag>\` or a glob such as \`refs/tags/v*\`. \`fabrika control --help\` lists every form.

\`fabrika db\` manages an application's Postgres schema: migration files, applying them (the template's
\`run.initCommands\`), the generated types and the generated isolation tests. Run \`fabrika db --help\` for its surface.

\`fabrika job run <name>\` runs one c.cron job of a contract application: the command each crontab entry runs. Run
\`fabrika job --help\` for its surface.

\`fabrika connect\` vendors another application's export into fabrika/connect/, from the description the owner's
environment approved, as Control answers it to FABRIKA_CONTROL_KEY. Run \`fabrika connect --help\` for its surface.

\`fabrika control\` is the operator's non-browser client for the control plane (ADR-0033). It is
provider-neutral, loads no installation package, and speaks the same typed API the console does. Run
\`fabrika control --help\` for its surface.

Which platform commands exist, and how WIDE each one is, is the provider's own answer — Zerops'
\`platform deploy\` owns the whole ordered sequence while Cloudflare's is one step of a scaffolded
workflow (ADR-0027), and only Zerops offers \`platform install\`, the from-scratch bring-up,
\`platform admin\`, which admits the first human to what that bring-up created, and \`platform upgrade\`,
which rolls a running installation onto a newer published release. Run
\`fabrika platform <command> --provider=<name> --help\` for that surface.
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

const packageNameOf = (specifier: string): string => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')

/**
 * The builder and the providers are optional peers: an application installs only the ones its commands load. A
 * command whose package is absent names the package to add, instead of a resolver error.
 */
const requireInstalled = (specifier: string, command: string): void => {
	try {
		Bun.resolveSync(specifier, import.meta.dir)
	} catch {
		const packageName = packageNameOf(specifier)
		throw new Error(`\`${command}\` needs ${packageName}, which is not installed. Add it: bun add -d ${packageName}`)
	}
}

/** A provider id names its package, `@fabrika/provider-<id>`; anything else is a module specifier of its own. */
const PROVIDER_ID = /^[a-z][a-z0-9-]*$/

const installationSpecifier = (provider: string): string => PROVIDER_ID.test(provider) ? `@fabrika/provider-${provider}/installation` : provider

const installationModule = async (provider: string, command: string): Promise<unknown> => {
	const specifier = installationSpecifier(provider)
	requireInstalled(specifier, command)
	return import(specifier)
}

/** App and namespace commands take a provider id only: the module's `appCli` must name the same one. */
const providerAppCli = async (provider: string, command: string): Promise<AppCli> => {
	if (!PROVIDER_ID.test(provider)) throw new Error(`\`${command}\` takes a provider id ([a-z][a-z0-9-]*), not "${provider}"`)
	const specifier = `@fabrika/provider-${provider}/cli`
	requireInstalled(specifier, command)
	return appCliFromModule(await import(specifier), provider, specifier)
}

const unsupported = (provider: string, command: string): Error => new Error(`${provider} app tooling does not support \`${command}\``)

const runPlatform = async (parsed: ParsedCommand): Promise<void> => {
	if (!isInstallationCommand(parsed.command)) {
		throw new Error(`Unknown platform command: ${parsed.command ?? '(missing)'}`)
	}
	const provider = requireExplicitProvider(parsed)
	const expectedProvider = PROVIDER_ID.test(provider) ? provider : undefined
	const installation = installationCliFromModule(
		await installationModule(provider, `fabrika platform ${parsed.command} --provider=${provider}`),
		expectedProvider,
	)
	if (!supportsInstallationCommand(installation, parsed.command)) {
		throw new Error(`${installation.provider} installation does not support \`platform ${parsed.command}\`\n\n${installation.usage}`)
	}
	await installation.run(parsed.command, parsed.rest)
}

/** Provider inference imports the app config, so it belongs to the compile phase `app register` reports. */
const runAppRegister = async (parsed: ParsedCommand): Promise<void> => {
	const config = configPath(parsed.rest)
	await registerCompiledManifest(parsed.rest, async (env) => {
		const provider = await selectedAppProvider(parsed)
		const cli = await providerAppCli(provider, 'fabrika app register')
		if (cli.registrationManifest === undefined) throw unsupported(provider, 'app register')
		return { provider, text: await cli.registrationManifest({ config, env }) }
	})
}

/** A contract application gets its generated entrypoint before the provider builds it. False when it is none. */
const writeContractEntry = async (argv: readonly string[], runtime: EntryRuntime): Promise<boolean> => {
	const root = dirname(resolve(process.cwd(), configPath(argv)))
	if (!(await Bun.file(join(root, CONTRACT_FILE)).exists())) {
		return false
	}
	const written = await writeGeneratedEntry(root, runtime)
	console.error(`fabrika: wrote ${relative(process.cwd(), written)}`)
	return true
}

const runApp = async (parsed: ParsedCommand): Promise<void> => {
	if (parsed.command === 'dev') {
		const { runAppDevCli } = await import('./app-dev.js')
		await runAppDevCli(parsed.rest)
		return
	}
	if (parsed.command === 'register') {
		await runAppRegister(parsed)
		return
	}
	const provider = await selectedAppProvider(parsed)
	const command = `app ${parsed.command ?? '(missing)'}`
	const cli = await providerAppCli(provider, `fabrika ${command}`)
	if (parsed.command === 'build' && cli.build !== undefined) {
		await cli.build(parsed.rest, { contract: await writeContractEntry(parsed.rest, cli.entryRuntime) })
		return
	}
	if (parsed.command === 'deploy' && cli.deploy !== undefined) {
		await cli.deploy(parsed.rest)
		return
	}
	throw unsupported(provider, command)
}

const namespaceCli = async (provider: string): Promise<NamespaceCli> => {
	const cli = await providerAppCli(provider, 'fabrika namespace')
	if (cli.namespaces === undefined) throw new Error(`Provider ${provider} does not expose deployment namespaces`)
	return cli.namespaces
}

const runNamespace = async (parsed: ParsedCommand): Promise<void> => {
	const provider = requireExplicitProvider(parsed)
	const cli = await namespaceCli(provider)
	if (parsed.command === undefined) {
		throw new Error('Namespace command is required')
	}
	const { runNamespaceCommand } = await import('./namespace.js')
	await runNamespaceCommand(cli, parsed.command, parsed.rest, {
		source: process.env,
		fetch: globalThis.fetch,
		write: (value) => console.info(value.trimEnd()),
	})
}

export const runCli = async (argv: readonly string[]): Promise<void> => {
	const parsed = parseCliArgs(argv)
	if (parsed.help && parsed.area === 'platform' && parsed.provider !== undefined && parsed.provider !== '') {
		// A platform command's real surface is the installation's, not this router's — and on Zerops that
		// text is what backlog 62 generates the operator's workflow from, so `--help` must reach it.
		console.info(installationCliFromModule(await installationModule(parsed.provider, `fabrika platform --provider=${parsed.provider}`)).usage)
		return
	}
	if (parsed.help && parsed.area === 'control') {
		console.info(CONTROL_USAGE)
		return
	}
	if (parsed.help && parsed.area === 'namespace') {
		if (parsed.provider !== undefined && parsed.provider !== '') {
			console.info((await namespaceCli(parsed.provider)).usage)
			return
		}
		const { NAMESPACE_USAGE } = await import('./namespace.js')
		console.info(NAMESPACE_USAGE)
		return
	}
	if (parsed.help && parsed.area === 'app' && parsed.command === 'dev') {
		const { APP_DEV_USAGE } = await import('./app-dev.js')
		console.info(APP_DEV_USAGE)
		return
	}
	if (parsed.help && parsed.area === 'db') {
		const { DB_USAGE } = await import('./db.js')
		console.info(DB_USAGE)
		return
	}
	if (parsed.help && parsed.area === 'job') {
		const { JOB_USAGE } = await import('./job.js')
		console.info(JOB_USAGE)
		return
	}
	if (parsed.help && parsed.area === 'connect') {
		const { CONNECT_USAGE } = await import('./connect.js')
		console.info(CONNECT_USAGE)
		return
	}
	if (parsed.help && parsed.area === 'builder') {
		requireInstalled('@fabrika/builder', 'fabrika builder')
		const { BUILDER_USAGE } = await import('@fabrika/builder')
		console.info(BUILDER_USAGE)
		return
	}
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
	if (parsed.area === 'control') {
		await runControlCli(parsed.command, parsed.rest, parsed.provider)
		return
	}
	if (parsed.area === 'db') {
		const { runDbCli } = await import('./db.js')
		await runDbCli(parsed.command, parsed.rest)
		return
	}
	if (parsed.area === 'job') {
		const { runJobCli } = await import('./job.js')
		await runJobCli(parsed.command, parsed.rest)
		return
	}
	if (parsed.area === 'connect') {
		const { runConnectCli } = await import('./connect.js')
		await runConnectCli(parsed.command, parsed.rest)
		return
	}
	if (parsed.area === 'builder') {
		requireInstalled('@fabrika/builder', 'fabrika builder')
		const { runBuilderCli } = await import('@fabrika/builder')
		const exitCode = await runBuilderCli(parsed.command === undefined ? [] : [parsed.command, ...parsed.rest])
		if (exitCode !== 0) process.exitCode = exitCode
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
