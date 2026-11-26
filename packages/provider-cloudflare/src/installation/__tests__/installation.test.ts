import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { cloudflareInstallationCli } from '../installation'

const VARIABLE = 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON'
const saved = process.env[VARIABLE]

afterEach(() => {
	if (saved === undefined) delete process.env[VARIABLE]
	else process.env[VARIABLE] = saved
})

describe('the control-plane stage', () => {
	test('refuses a set OAuth client list before any component deploys', async () => {
		process.env[VARIABLE] = '[{"provider":"claude","clientId":"https://claude.example.org/oauth/client.json","redirectUris":[]}]'
		const info = spyOn(console, 'info').mockImplementation(() => {})
		try {
			// The component's config does not exist: a refusal after the component loop would fail on it instead.
			await expect(cloudflareInstallationCli.run('plan', ['--component-config=missing/fabrika.config.ts'])).rejects.toThrow(
				`${VARIABLE} is set, and this release no longer reads it`,
			)
			expect(info.mock.calls.flat().some((line) => String(line).includes('▸'))).toBe(false)
		} finally {
			info.mockRestore()
		}
	})
})
