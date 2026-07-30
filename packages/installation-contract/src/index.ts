export type InstallationCommand = 'init' | 'plan' | 'deploy'

export const isInstallationCommand = (value: unknown): value is InstallationCommand => value === 'init' || value === 'plan' || value === 'deploy'

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
