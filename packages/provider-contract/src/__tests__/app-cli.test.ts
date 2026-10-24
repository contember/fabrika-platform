import { describe, expect, test } from 'bun:test'
import { type AppCli, appCliFromModule } from '../app-cli'

const appCli: AppCli = { provider: 'acme', entryRuntime: 'bun', build: async () => {} }

describe('appCliFromModule', () => {
	test('accepts a module whose appCli names the expected provider', () => {
		expect(appCliFromModule({ appCli }, 'acme', '@acme/cli')).toBe(appCli)
		const namespaces = { usage: 'u', run: async () => ({ namespace: null }) }
		expect(appCliFromModule({ appCli: { ...appCli, namespaces } }, 'acme', '@acme/cli').namespaces).toBe(namespaces)
	})

	test('refuses a module without a valid appCli', () => {
		for (
			const module of [
				{},
				{ appCli: null },
				{ appCli: { ...appCli, provider: ' ' } },
				{ appCli: { ...appCli, entryRuntime: 'node' } },
				{ appCli: { ...appCli, build: 'yes' } },
				{ appCli: { ...appCli, deploy: {} } },
				{ appCli: { ...appCli, registrationManifest: 1 } },
				{ appCli: { ...appCli, namespaces: { usage: 'u' } } },
			]
		) {
			expect(() => appCliFromModule(module, 'acme', '@acme/cli')).toThrow('@acme/cli must export a valid `appCli`')
		}
	})

	test('refuses a module that provides another provider', () => {
		expect(() => appCliFromModule({ appCli }, 'zerops', '@acme/cli')).toThrow('@acme/cli provides "acme", expected "zerops"')
	})
})
