/**
 * `examples/app` deploys as a contract application: the deployer reads its `fabrika.contract.ts` from the checkout with
 * the static reader and builds the proxy Worker from the contract's endpoint table.
 */

import { compileContract } from '@fabrika/app/contract'
import { contractDigest, FABRIKA_CONTRACT_DIGEST } from '@fabrika/auth-core'
import { contractProxyTable, parseProxyManifestJson } from '@fabrika/proxy-core/manifest'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Worker } from 'oblaka-iac'
import { contract } from '../../../../examples/app/fabrika.contract'
import { tables } from '../../../../examples/app/src/db/tables'
import { createCloudflareDeployer, defaultCloudflareCollaborators, generateWranglerConfigs, type ProvisionInput } from '..'
import { CLOUDFLARE_PROXY_WORKER_DIR, proxyManifestJson } from '../proxy'

const EXAMPLE = resolve(import.meta.dir, '..', '..', '..', '..', 'examples', 'app')
const artifact = compileContract(contract, tables)

async function deployedRoot(): Promise<Worker | undefined> {
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
	return provisions[0]?.definition
}

describe('the example application', () => {
	test('deploys behind the proxy Worker the platform builds from the endpoint table it read in the checkout', async () => {
		const root = await deployedRoot()
		expect(root?.options).toMatchObject({ name: 'example-app-proxy', dir: CLOUDFLARE_PROXY_WORKER_DIR })
		const manifest = root === undefined ? null : proxyManifestJson(root)
		const apps = typeof manifest === 'string' ? parseProxyManifestJson(manifest)?.apps : undefined
		expect(apps).toEqual([{ id: 'example-app@stage', hosts: ['app.example.com'], upstream: 'APP', scheme: 'https', ...contractProxyTable(artifact) }])
	})

	test('its application Worker starts the generated entrypoint as the contract the deploy read', async () => {
		const app = (await deployedRoot())?.options.bindings?.['APP']
		const options = app instanceof Worker ? app.options : undefined
		expect(options?.name).toBe('example-app')
		expect(options?.main).toBe('./fabrika/entry.generated.ts')
		expect(options?.vars?.[FABRIKA_CONTRACT_DIGEST]).toBe(contractDigest(artifact))
	})
})
