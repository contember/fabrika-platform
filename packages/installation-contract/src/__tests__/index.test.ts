import { describe, expect, test } from 'bun:test'
import { type InstallationCli, installationCliFromModule, isInstallationCli, supportsInstallationCommand } from '..'

const installationCli: InstallationCli = {
	provider: 'cloudflare',
	commands: ['init', 'plan', 'deploy'],
	usage: 'Cloudflare installation',
	run: async (): Promise<void> => {},
}

describe('installation CLI contract', () => {
	test('accepts a complete capability declaration', () => {
		expect(isInstallationCli(installationCli)).toBe(true)
		expect(supportsInstallationCommand(installationCli, 'plan')).toBe(true)
	})

	test('rejects unknown and duplicate capabilities', () => {
		expect(isInstallationCli({ ...installationCli, commands: ['plan', 'destroy'] })).toBe(false)
		expect(isInstallationCli({ ...installationCli, commands: ['plan', 'plan'] })).toBe(false)
		expect(isInstallationCli({ ...installationCli, commands: [] })).toBe(false)
	})

	test('validates the provider selected by a built-in dispatcher', () => {
		expect(installationCliFromModule({ installationCli }, 'cloudflare')).toBe(installationCli)
		expect(() => installationCliFromModule({ installationCli }, 'zerops')).toThrow(
			'provides "cloudflare", expected "zerops"',
		)
	})

	test('rejects malformed dynamically imported modules', () => {
		expect(() => installationCliFromModule({})).toThrow('must export a valid `installationCli`')
		expect(() => installationCliFromModule({ installationCli: { ...installationCli, run: 'not a function' } })).toThrow(
			'must export a valid `installationCli`',
		)
	})
})
