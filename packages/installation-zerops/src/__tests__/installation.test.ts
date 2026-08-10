import { describe, expect, test } from 'bun:test'
import { installationCli } from '..'

describe('Zerops installation capability', () => {
	test('offers install, init, plan and deploy — and only ONE of them creates an installation', () => {
		expect(installationCli.commands).toEqual(['install', 'init', 'plan', 'deploy'])
		expect(installationCli.usage).toContain('UPDATE AN\nINSTALLATION THAT ALREADY EXISTS')
		expect(installationCli.usage).toContain('`install` CREATES an installation in a project you created empty')
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
		for (const flag of ['--project-id', '--env', '--iam-host', '--console-host', '--operations-host', '--from-git', '--dry-run']) {
			expect(installationCli.usage).toContain(flag)
		}
		for (const variable of ['FABRIKA_ZEROPS_ACCESS_TOKEN', 'FABRIKA_IAM_PROVISIONING_KEY', 'FABRIKA_PLATFORM_ENVIRONMENT']) {
			expect(installationCli.usage).toContain(variable)
		}
		expect(installationCli.usage).toContain('iam → operations → proxy → control')
	})

	test('deploy refuses an unknown argument rather than ignoring it', async () => {
		await expect(installationCli.run('deploy', ['--nope=1'])).rejects.toThrow('unexpected argument')
	})
})
