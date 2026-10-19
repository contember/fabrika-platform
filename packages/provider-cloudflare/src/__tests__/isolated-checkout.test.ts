/**
 * A checkout installs its own `oblaka-iac`, so the Workers its config returns are not instances of the runner's class.
 * The deployer must still front the application with the platform proxy, target managed values at the application
 * Worker, and check what oblaka generates.
 */

import { contractDigest } from '@fabrika/auth-core'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Worker } from 'oblaka-iac'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { type CloudflareDeployRun, createCloudflareDeployer, defaultCloudflareCollaborators, generateWranglerConfigs, type ProvisionInput } from '..'
import { CLOUDFLARE_PROXY_WORKER_DIR } from '../proxy'

let checkout: string

const RUNNER_OBLAKA = dirname(Bun.resolveSync('oblaka-iac/package.json', import.meta.dir))

/** One file per case: Bun caches a module by its path. */
const writeConfig = async (file: string, bindings: string): Promise<void> => {
	const authoring = JSON.stringify(resolve(import.meta.dir, '../authoring.ts'))
	await writeFile(
		join(checkout, file),
		`import { D1Database, ServiceReference, Worker } from 'oblaka-iac'
import { defineApp } from ${authoring}
export const application = () => new Worker({
	dir: '.', name: 'demo', main: 'src/index.ts', compatibility_flags: [], workers_dev: false, preview_urls: false,
	bindings: ${bindings},
})
export default defineApp({ id: 'demo', schema: { scopes: [], actions: [], roles: {}, contract: true }, resources: application })
`,
	)
}

beforeAll(async () => {
	checkout = await realpath(await mkdtemp(join(tmpdir(), 'fabrika-isolated-checkout-')))
	// Its own copies, as a checkout's `bun install` lays them out: a second module instance of every oblaka class.
	await cp(await realpath(RUNNER_OBLAKA), join(checkout, 'node_modules', 'oblaka-iac'), { recursive: true, dereference: true })
	await cp(await realpath(join(RUNNER_OBLAKA, '..', 'jsonc-parser')), join(checkout, 'node_modules', 'jsonc-parser'), {
		recursive: true,
		dereference: true,
	})
})

afterAll(async () => {
	await rm(checkout, { recursive: true, force: true })
})

const deployCheckout = async (
	configPath: string,
): Promise<{ readonly result: Awaited<ReturnType<ReturnType<typeof createCloudflareDeployer>>>; readonly provisions: ProvisionInput[] }> => {
	const provisions: ProvisionInput[] = []
	const run: CloudflareDeployRun = {
		appId: 'demo',
		env: 'stage',
		domain: 'stage.example.com',
		cwd: checkout,
		configPath,
		secrets: {},
		vars: {},
		managedEnvironment: { FABRIKA_IAM_ISSUER: 'https://iam.example.test' },
		installationApps: [{ app: 'otherapp', env: 'stage' }],
		approved: { kind: 'contract', contract: notesArtifact, contractDigest: contractDigest(notesArtifact) },
		dryRun: false,
		signal: new AbortController().signal,
		log: () => {},
	}
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
	})(run)
	return { result, provisions }
}

describe('a checkout with its own oblaka-iac', () => {
	test('its Workers are another module instance of the class', async () => {
		await writeConfig('plain.config.ts', '{}')
		const loaded: unknown = await import(join(checkout, 'plain.config.ts'))
		const application: unknown = typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'application') : undefined
		expect(typeof application).toBe('function')
		expect(typeof application === 'function' ? Reflect.apply(application, undefined, []) instanceof Worker : true).toBe(false)
	})

	test('deploys behind the platform proxy, with the managed values on the application Worker', async () => {
		await writeConfig(
			'own.config.ts',
			"{ IAM: new ServiceReference('propustka-worker', 'PropustkaApplication'), DB: new D1Database({ name: 'demo-db' }) }",
		)
		const { result, provisions } = await deployCheckout('own.config.ts')
		expect(result.status).toBe('succeeded')
		const root = provisions[0]?.definition
		const app = root?.options.bindings?.['APP']
		expect(root).toBeInstanceOf(Worker)
		expect(root?.options).toMatchObject({ name: 'demo-proxy', dir: CLOUDFLARE_PROXY_WORKER_DIR })
		expect(app).toBeInstanceOf(Worker)
		expect(app instanceof Worker ? app.options.vars : undefined).toMatchObject({ FABRIKA_IAM_ISSUER: 'https://iam.example.test' })
		const { configs } = await generateWranglerConfigs(root ?? new Worker({ dir: '.', name: 'none', compatibility_flags: [], bindings: {} }), 'stage')
		expect(configs.map((generated) => generated.config.name)).toEqual(['stage-demo-proxy', 'stage-demo'])
	})

	test("another application's name is refused through the checkout's own classes", async () => {
		await writeConfig('foreign.config.ts', "{ OTHER: new ServiceReference('otherapp'), DB: new D1Database({ name: 'otherapp-db' }) }")
		await expect(deployCheckout('foreign.config.ts')).rejects.toThrow(
			'D1 database `otherapp-db` becomes `stage-otherapp-db`, a name of application `otherapp`',
		)
	})
})
