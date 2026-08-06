import { describe, expect, test } from 'bun:test'
import { installationCli } from '..'

describe('Zerops installation capability', () => {
	test('offers plan and deploy; the first bring-up is still a hand step', () => {
		expect(installationCli.commands).toEqual(['plan', 'deploy'])
		expect(installationCli.usage).toContain('`platform init` is not available for Zerops')
	})

	test('rejects a direct init call', async () => {
		await expect(installationCli.run('init', [])).rejects.toThrow('does not support `platform init`')
	})

	test('the usage text documents the surface a generated pipeline is written against', () => {
		// Backlog 62 generates the operator's workflow FROM this text; a flag or a variable missing here is
		// a workflow that cannot be written without reading the source.
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
