import { describe, expect, test } from 'bun:test'
import { installationCli } from '..'

describe('Zerops installation capability', () => {
	test('offers install, init, plan, deploy, admin and upgrade — and only ONE of them creates an installation', () => {
		expect(installationCli.commands).toEqual(['install', 'init', 'plan', 'deploy', 'admin', 'upgrade'])
		expect(installationCli.usage).toContain('UPDATE AN\nINSTALLATION THAT ALREADY EXISTS')
		expect(installationCli.usage).toContain('`install` CREATES an installation in a project you created empty')
	})

	test('admin documents the first-administrator surface and refuses anything that could carry a credential', async () => {
		// The cross-app grant is the trap this command exists to close; the usage text is where an operator
		// reads why an app-scoped one would leave the Access plane refusing.
		for (const flag of ['--email', '--iam-host', '--reissue']) {
			expect(installationCli.usage).toContain(flag)
		}
		expect(installationCli.usage).toContain('FABRIKA_PLATFORM_ADMIN_EMAIL')
		expect(installationCli.usage).toContain('cross-app (`app: null`)')
		await expect(installationCli.run('admin', ['--key=nope'])).rejects.toThrow('unexpected argument')
		await expect(installationCli.run('admin', [])).rejects.toThrow('--email=<value> or FABRIKA_PLATFORM_ADMIN_EMAIL is required')
	})

	test('install documents the whole from-scratch surface, credentials included', async () => {
		// The bring-up is the one command an operator runs before anything exists, so its usage is the only
		// place the sequence and its two-pass shape are written down for them.
		for (const flag of ['--project-id', '--client-id', '--env', '--scheme', '--from-git', '--tier']) {
			expect(installationCli.usage).toContain(flag)
		}
		expect(installationCli.usage).toContain('envIsolation: service')
		expect(installationCli.usage).toContain('PASSWORD ONLY')
		// Credentials are environment-only here too, so an unknown flag is an error rather than a value.
		await expect(installationCli.run('install', ['--token=nope'])).rejects.toThrow('unexpected argument')
	})

	test('init names one installation and refuses anything that could carry a credential', async () => {
		await expect(installationCli.run('init', [])).rejects.toThrow('requires an installation name')
		await expect(installationCli.run('init', ['test', '--token=nope'])).rejects.toThrow('unexpected argument')
	})

	test('the usage text documents the surface a generated pipeline is written against', () => {
		// The sidecar workflow is generated FROM this text; a flag or a variable missing here is a workflow
		// that cannot be written without reading the source. `sidecar.test.ts` checks the other direction.
		for (
			const flag of [
				'--project-id',
				'--create-project',
				'--project-name',
				'--env',
				'--iam-host',
				'--console-host',
				'--operations-host',
				'--from-git',
				'--dry-run',
			]
		) {
			expect(installationCli.usage).toContain(flag)
		}
		for (const variable of ['FABRIKA_ZEROPS_ACCESS_TOKEN', 'FABRIKA_IAM_PROVISIONING_KEY', 'FABRIKA_PLATFORM_ENVIRONMENT']) {
			expect(installationCli.usage).toContain(variable)
		}
		expect(installationCli.usage).toContain('iam + operations + source together, then proxy → control')
	})

	test('deploy refuses an unknown argument rather than ignoring it', async () => {
		await expect(installationCli.run('deploy', ['--nope=1'])).rejects.toThrow('unexpected argument')
	})

	test('upgrade documents the roll and refuses anything that is not a published tag', async () => {
		// The usage is where an operator reads that the push IS the trigger and that the run URL comes
		// first — neither is guessable from the flags.
		for (const flag of ['--to=<tag>', '--sidecar=<path>', '--dry-run']) {
			expect(installationCli.usage).toContain(flag)
		}
		expect(installationCli.usage).toContain('chore: roll <installation> forward to fabrika <tag>')
		expect(installationCli.usage).toContain('the push is what triggers the pipeline')
		// The three refusals an operator cannot guess from the flags.
		expect(installationCli.usage).toContain('push: branches: [main]')
		expect(installationCli.usage).toContain('committed and NEVER PUSHED')
		expect(installationCli.usage).toContain('never "no such tag"')
		await expect(installationCli.run('upgrade', ['--nope=1', '--to=v1.0.0'])).rejects.toThrow('unexpected argument')
		await expect(installationCli.run('upgrade', ['test'])).rejects.toThrow('--to=<tag> is required')
		// ADR-0025's first gate: a branch or a SHA never reaches the network.
		await expect(installationCli.run('upgrade', ['--to=main', 'test'])).rejects.toThrow('is not a published tag')
		await expect(installationCli.run('upgrade', ['--to=v1.0.0'])).rejects.toThrow('--sidecar=<path>|<owner>/<name>')
	})
})
