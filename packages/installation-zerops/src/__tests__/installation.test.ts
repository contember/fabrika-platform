import { describe, expect, test } from 'bun:test'
import { installationCli } from '..'

describe('Zerops installation capability', () => {
	test('offers install, init, plan, deploy and admin — and only ONE of them creates an installation', () => {
		expect(installationCli.commands).toEqual(['install', 'init', 'plan', 'deploy', 'admin'])
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
		for (const flag of ['--project-id', '--env', '--iam-host', '--console-host', '--operations-host', '--from-git', '--dry-run']) {
			expect(installationCli.usage).toContain(flag)
		}
		for (const variable of ['FABRIKA_ZEROPS_ACCESS_TOKEN', 'FABRIKA_IAM_PROVISIONING_KEY', 'FABRIKA_PLATFORM_ENVIRONMENT']) {
			expect(installationCli.usage).toContain(variable)
		}
		expect(installationCli.usage).toContain('iam → operations → source → proxy → control')
	})

	test('deploy refuses an unknown argument rather than ignoring it', async () => {
		await expect(installationCli.run('deploy', ['--nope=1'])).rejects.toThrow('unexpected argument')
	})
})
