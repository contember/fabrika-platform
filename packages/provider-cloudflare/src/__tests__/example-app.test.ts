/** `examples/app` deploys as an application without a contract: its config hands the gates, the platform builds the proxy. */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Worker } from 'oblaka-iac'
import { createCloudflareDeployer, defaultCloudflareCollaborators, generateWranglerConfigs, type ProvisionInput } from '..'
import { CLOUDFLARE_PROXY_WORKER_DIR } from '../proxy'

const EXAMPLE = resolve(import.meta.dir, '..', '..', '..', '..', 'examples', 'app')

describe('the example application', () => {
	test('deploys behind the proxy Worker the platform builds from its gates', async () => {
		const provisions: ProvisionInput[] = []
		const result = await createCloudflareDeployer({
			accountId: 'account',
			apiToken: 'token',
			collaborators: {
				...defaultCloudflareCollaborators,
				runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
				provision: async (input) => {
					provisions.push(input)
					if (input.definition === undefined) throw new Error('nothing to provision')
					const { configs } = await generateWranglerConfigs(input.definition, input.env)
					return { wranglerConfigs: [...configs], wranglerConfig: configs[0]?.config ?? {} }
				},
				writeOutcome: async () => {},
			},
		})({
			appId: 'example-app',
			env: 'stage',
			domain: 'app.example.com',
			cwd: EXAMPLE,
			configPath: 'fabrika.config.ts',
			secrets: {},
			vars: {},
			managedEnvironment: {},
			dryRun: true,
			signal: new AbortController().signal,
			log: () => {},
		})
		expect(result.status).toBe('succeeded')
		const root = provisions[0]?.definition
		expect(root?.options).toMatchObject({ name: 'example-app-proxy', dir: CLOUDFLARE_PROXY_WORKER_DIR })
		const app = root?.options.bindings?.['APP']
		expect(app instanceof Worker ? app.options.name : undefined).toBe('propustka-example-app')
	})
})
