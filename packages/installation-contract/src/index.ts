/**
 * The platform commands a provider MAY offer. Every one of them is optional — a provider declares the
 * subset it implements and the CLI prints its usage for anything else.
 *
 * `install` is the newest and the narrowest in support: it BRINGS UP an installation that does not
 * exist yet, generating and placing every credential it needs. Only Zerops declares it, because only
 * there is a from-scratch bring-up a sequence of API calls; on Cloudflare the same ground is covered by
 * `init` plus the workflow it scaffolds.
 */
export type InstallationCommand = 'init' | 'install' | 'plan' | 'deploy'

export const isInstallationCommand = (value: unknown): value is InstallationCommand =>
	value === 'init' || value === 'install' || value === 'plan' || value === 'deploy'

export interface InstallationCli {
	readonly provider: string
	readonly commands: readonly InstallationCommand[]
	readonly usage: string
	run(command: InstallationCommand, argv: readonly string[]): Promise<void>
}

export interface InstallationCliModule {
	readonly installationCli: InstallationCli
}

export const isInstallationCli = (value: unknown): value is InstallationCli =>
	typeof value === 'object'
	&& value !== null
	&& 'provider' in value
	&& typeof value.provider === 'string'
	&& value.provider.trim() !== ''
	&& 'commands' in value
	&& Array.isArray(value.commands)
	&& value.commands.length > 0
	&& value.commands.every(isInstallationCommand)
	&& new Set(value.commands).size === value.commands.length
	&& 'usage' in value
	&& typeof value.usage === 'string'
	&& 'run' in value
	&& typeof value.run === 'function'

export const supportsInstallationCommand = (installation: InstallationCli, command: InstallationCommand): boolean =>
	installation.commands.some((supported) => supported === command)

export const installationCliFromModule = (value: unknown, expectedProvider?: string): InstallationCli => {
	if (typeof value !== 'object' || value === null || !('installationCli' in value) || !isInstallationCli(value.installationCli)) {
		throw new Error('Installation package must export a valid `installationCli`')
	}
	if (expectedProvider !== undefined && value.installationCli.provider !== expectedProvider) {
		throw new Error(
			`Installation package provides "${value.installationCli.provider}", expected "${expectedProvider}"`,
		)
	}
	return value.installationCli
}
