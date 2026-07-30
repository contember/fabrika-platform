import { describe, expect, test } from 'bun:test'
import { installationCli } from '..'

describe('Zerops installation capability', () => {
	test('exposes validation only until real-account bring-up is proven', () => {
		expect(installationCli.commands).toEqual(['plan'])
		expect(installationCli.usage).toContain('Real-account init and deploy remain unavailable')
	})

	test('rejects direct init and deploy calls', async () => {
		await expect(installationCli.run('init', [])).rejects.toThrow('does not support `platform init` yet')
		await expect(installationCli.run('deploy', [])).rejects.toThrow('does not support `platform deploy` yet')
	})
})
