// What a provider's `/cli` module offers the `fabrika` command for an application: `app build`, `app deploy`,
// `app register` and `fabrika namespace`. The command loads the module by the provider's id and never branches on it.

import type { ProviderDeploymentNamespace, ProviderNamespacePlan } from './control'

/** The runtime a contract application's generated entry is written for (`@fabrika/app/build`'s `EntryRuntime`). */
export type AppEntryRuntime = 'bun' | 'cloudflare'

/** The database a deployer composed a Cloudflare application for: its Durable Object's SQLite, or Postgres through Hyperdrive. */
export type AppBuildDatabase = 'sqlite' | 'postgres'

const APP_BUILD_DATABASE_OPTION = '--database='

/**
 * What a deployer appends to `fabrika app build --provider=cloudflare` for an application it composed on Postgres. The
 * application's own CLI writes the Postgres entry only when it is asked to: a deployer older than `0.9.0-dev.9` never
 * asks and composes no database, so the build fails there instead of deploying an entry without its database. A deploy
 * on the object's SQLite passes nothing, as every older deployer does.
 */
export const appBuildDatabaseArgument = (database: AppBuildDatabase): string => `${APP_BUILD_DATABASE_OPTION}${database}`

/** The database `fabrika app build` was asked for; none asked is undefined. Throws on any other value. */
export const requestedAppBuildDatabase = (argv: readonly string[]): AppBuildDatabase | undefined => {
	const option = argv.find((arg) => arg.startsWith(APP_BUILD_DATABASE_OPTION))
	if (option === undefined) return undefined
	const value = option.slice(APP_BUILD_DATABASE_OPTION.length)
	if (value === 'sqlite' || value === 'postgres') return value
	throw new Error(`${APP_BUILD_DATABASE_OPTION}${value}: expected sqlite or postgres`)
}

/** What a namespace command asks of Control. The `fabrika` command holds the Control origin, the credential and the transport. */
export interface NamespaceControl {
	create(namespace: ProviderDeploymentNamespace): Promise<unknown>
	adopt(namespace: ProviderDeploymentNamespace): Promise<unknown>
	reconcile(namespaceId: string): Promise<unknown>
}

/** A plan, or the namespace Control answered with; the `fabrika` command validates and prints either. */
export type NamespaceCommandResult = { readonly plan: ProviderNamespacePlan } | { readonly namespace: unknown }

export interface NamespaceCommandContext {
	readonly source: Readonly<Record<string, string | undefined>>
	/** Reads the Control origin and credential, and throws when either is missing: call it after every other input is checked. */
	control(): NamespaceControl
}

export interface NamespaceCli {
	readonly usage: string
	/** `argv` is the command's own arguments, without the router's `--provider` and `--json`. */
	run(subcommand: string, argv: readonly string[], context: NamespaceCommandContext): Promise<NamespaceCommandResult>
}

export interface AppCli {
	readonly provider: string
	readonly entryRuntime: AppEntryRuntime
	/** `fabrika app build`, after the command wrote a contract application's entry; `contract` says whether it did. */
	build?(argv: readonly string[], context: { readonly contract: boolean }): Promise<void>
	deploy?(argv: readonly string[]): Promise<void>
	/** The text `fabrika app register` hands Control: the application's manifest for one environment. */
	registrationManifest?(options: { readonly config: string; readonly env: string }): Promise<string>
	readonly namespaces?: NamespaceCli
}

export interface AppCliModule {
	readonly appCli: AppCli
}

const optionalFunction = (value: object, key: string): boolean => {
	const member: unknown = Reflect.get(value, key)
	return member === undefined || typeof member === 'function'
}

const isNamespaceCli = (value: unknown): value is NamespaceCli =>
	typeof value === 'object'
	&& value !== null
	&& 'usage' in value
	&& typeof value.usage === 'string'
	&& 'run' in value
	&& typeof value.run === 'function'

export const isAppCli = (value: unknown): value is AppCli =>
	typeof value === 'object'
	&& value !== null
	&& 'provider' in value
	&& typeof value.provider === 'string'
	&& value.provider.trim() !== ''
	&& 'entryRuntime' in value
	&& (value.entryRuntime === 'bun' || value.entryRuntime === 'cloudflare')
	&& optionalFunction(value, 'build')
	&& optionalFunction(value, 'deploy')
	&& optionalFunction(value, 'registrationManifest')
	&& (!('namespaces' in value) || value.namespaces === undefined || isNamespaceCli(value.namespaces))

/** `specifier` names the module in the error, so an operator knows which package to upgrade. */
export const appCliFromModule = (value: unknown, expectedProvider: string, specifier: string): AppCli => {
	if (typeof value !== 'object' || value === null || !('appCli' in value) || !isAppCli(value.appCli)) {
		throw new Error(`${specifier} must export a valid \`appCli\`; a provider release older than this CLI has none`)
	}
	if (value.appCli.provider !== expectedProvider) {
		throw new Error(`${specifier} provides "${value.appCli.provider}", expected "${expectedProvider}"`)
	}
	return value.appCli
}
