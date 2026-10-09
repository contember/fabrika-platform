// Connector edges through Control's run lifecycle (B9b): a consumer deploys only an import the owner environment of the
// same name approved for it, with the vendored snapshot the owner serves; it gets one app key at the owner and the
// owner's origin. An owner deploy that would break an approved import fails, whoever approves it.

import { exportDescription } from '@fabrika/app/contract'
import { readContractSource } from '@fabrika/check/contract'
import { uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployInput } from '@fabrika/provider-contract'
import { describe, expect, spyOn, test } from 'bun:test'
import { approvedSnapshot } from '../approval/snapshot'
import { describeConnector } from '../connectors'
import type { ControlRepositories } from '../db'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { VaultWorkloadCredentials, type WorkloadKeyIssuer } from '../workload-credentials'
import { memoryCommits } from './helpers/commits'
import { createHarness, harnessDatabase } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

const COMMIT = 'c'.repeat(40)
const ENV = 'stage'

const catalogSource = (product: string, procedures = '') =>
	`import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

const Product = z.strictObject(${product})

export const contract = defineContract({
	app: 'catalog',
	dimensions: { catalog: {} },
	actions: { 'catalog.read': 'Read the catalog' },
	roles: { reader: { grants: ['catalog.read'] } },
}, (c) => ({
	health: c.health('/healthz'),
	exports: {
		products: c.export({
			version: 1,
			consumers: ['shop'],
			audience: 'any consumer user',
			procedures: {
				get: c.query({ input: z.strictObject({ sku: z.string() }), output: Product, access: { action: 'catalog.read', over: 'catalog' } }),${procedures}
			},
		}),
	},
}))
`

const CATALOG = catalogSource('{ sku: z.string(), name: z.string() }')
const CATALOG_WITHOUT_NAME = catalogSource('{ sku: z.string() }')
const CATALOG_WITH_LIST = catalogSource(
	'{ sku: z.string(), name: z.string() }',
	"\n\t\t\t\tlist: c.query({ output: z.array(Product), access: { action: 'catalog.read', over: 'catalog' } }),",
)

const digestOf = (source: string): string => {
	const description = exportDescription(readContractSource(new Map([['fabrika.contract.ts', source]])), 'products')
	if (description === null) throw new Error('the catalog exports products')
	return description.digest
}

const shopSource = (digest: string, app = 'catalog', procedures = "'get'") =>
	`import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const contract = defineContract({
	app: 'shop',
	dimensions: { shop: {} },
	actions: { 'shop.view': 'View the shop' },
	roles: { visitor: { grants: ['shop.view'] } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		show: c.query({ input: z.strictObject({ sku: z.string() }), output: z.strictObject({ name: z.string() }), access: { action: 'shop.view', over: 'shop' } }),
	}),
	imports: {
		catalog: { app: '${app}', export: 'products', version: 1, digest: '${digest}', procedures: [${procedures}], usedBy: ['api.show'] },
	},
}))
`

interface World {
	readonly db: ControlRepositories
	readonly deploys: ProviderDeployInput[]
	readonly issued: string[]
	readonly revoked: string[]
	readonly logs: Map<string, string>
	/** Each application's contract source at the next commit, by repository. */
	readonly sources: Map<string, string>
	workloadCredentials: VaultWorkloadCredentials
}

const repository = (app: string): string => `github.com/acme/${app}`

async function world(): Promise<World> {
	const { db } = createHarness()
	const vault = await Vault.create(harnessDatabase(db), btoa(String.fromCharCode(...new Uint8Array(32).fill(9))))
	const issued: string[] = []
	const revoked: string[] = []
	const issuer: WorkloadKeyIssuer = {
		issue: (input) => {
			issued.push(`${input.app}/${input.kind}:${input.name}`)
			return Promise.resolve({ key: `px_${'e'.repeat(40)}${issued.length}`, credentialId: `credential-${issued.length}`, expiresAt: input.expiresAt })
		},
		revoke: (input) => {
			revoked.push(`${input.app}/${input.kind}:${input.name}`)
			return Promise.resolve()
		},
	}
	const w: World = {
		db,
		deploys: [],
		issued,
		revoked,
		logs: new Map(),
		sources: new Map(),
		workloadCredentials: new VaultWorkloadCredentials(db.workloadCredentials, () => Promise.resolve(vault), issuer),
	}
	for (const app of ['catalog', 'shop', 'crm']) {
		await db.registry.createApp({ id: app, repoUrl: repository(app) })
		await db.registry.upsertAppEnv({
			appId: app,
			env: ENV,
			domain: `${ENV}.${app}.example.test`,
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
			providerArtifactJson: JSON.stringify({ provider: 'harbor', version: 1, payload: {} }),
		})
	}
	return w
}

function provider(w: World): ControlProvider {
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: (input) => {
			w.deploys.push(input)
			return Promise.resolve({ state: 'succeeded' })
		},
	}
}

function deps(w: World): RunDeps {
	return {
		repositories: w.db,
		provider: provider(w),
		secrets: new VaultSecretResolver({}),
		lock: makeFakeLock(w.db),
		workloadCredentials: w.workloadCredentials,
		logs: {
			put: (key, value) => {
				if (typeof value === 'string') w.logs.set(key, value)
				return Promise.resolve()
			},
		},
		commits: {
			open: (input) => {
				const source = w.sources.get(input.repoUrl)
				return memoryCommits(source === undefined ? {} : { 'fabrika.contract.ts': source }).open(input)
			},
		},
	}
}

async function deploy(w: World, app: string, source: string): Promise<string> {
	w.sources.set(repository(app), source)
	const runId = uuidv7()
	await w.db.runs.createRun({ id: runId, appId: app, env: ENV, ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test' })
	const quiet = spyOn(console, 'error').mockImplementation(() => {})
	try {
		return (await executeDeploy(deps(w), { runId })).status
	} finally {
		quiet.mockRestore()
	}
}

async function approvedDigest(w: World, app: string): Promise<string | null> {
	const row = await w.db.registry.getAppEnv(app, ENV)
	const contract = row === null ? null : approvedSnapshot(row).snapshot.contract
	return contract === null ? null : exportDescription(contract, 'products')?.digest ?? null
}

const runLog = (w: World): string => [...w.logs.values()].join('\n')

describe('a consumer deploy', () => {
	test("imports the owner's approved export: one app key at <owner>@<env> and the owner's origin, under the import's names", async () => {
		const w = await world()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		expect(await deploy(w, 'shop', shopSource(digestOf(CATALOG)))).toBe('succeeded')
		expect(w.issued).toEqual(['catalog@stage/app:shop'])
		const managed = w.deploys.at(-1)?.managedEnvironment ?? {}
		expect(managed['FABRIKA_CONNECT_CATALOG_URL']).toBe('https://stage.catalog.example.test')
		expect(managed['FABRIKA_CONNECT_CATALOG_KEY']).toMatch(/^px_e+1$/)
		expect(runLog(w)).not.toContain(String(managed['FABRIKA_CONNECT_CATALOG_KEY']))
	})

	test("that drops its last import of an owner revokes the pair's keys at the owner before the provider deploys", async () => {
		const w = await world()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		expect(await deploy(w, 'shop', shopSource(digestOf(CATALOG)))).toBe('succeeded')
		const withoutImport = shopSource(digestOf(CATALOG)).replace(/\timports: \{[\s\S]*?\n\t\},\n/, '')
		expect(withoutImport).not.toContain('imports')
		expect(await deploy(w, 'shop', withoutImport)).toBe('succeeded')
		expect(w.revoked).toEqual(['catalog@stage/app:shop'])
		expect(Object.keys(w.deploys.at(-1)?.managedEnvironment ?? {}).filter((name) => name.startsWith('FABRIKA_CONNECT_'))).toEqual([])
	})

	test('is refused when it imports a procedure the export does not have, which then blocks no owner publish', async () => {
		const w = await world()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		expect(await deploy(w, 'shop', shopSource(digestOf(CATALOG), 'catalog', "'get', 'doesNotExist'"))).toBe('failed')
		expect(runLog(w)).toContain("imports 'doesNotExist', which catalog@stage does not export")
		expect(w.issued).toEqual([])
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
	})

	test('is refused when its vendored snapshot is not what the owner serves, or the owner exports nothing to it', async () => {
		const w = await world()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		expect(await deploy(w, 'shop', shopSource(digestOf(CATALOG_WITH_LIST)))).toBe('failed')
		expect(runLog(w)).toContain('the vendored snapshot is not what catalog@stage serves; run fabrika connect pull')
		expect(await deploy(w, 'shop', shopSource(digestOf(CATALOG), 'crm'))).toBe('failed')
		expect(runLog(w)).toContain('crm@stage has approved no export products@1 for shop')
		expect(w.issued).toEqual([])
		expect(w.deploys.filter((input) => input.app.id === 'shop')).toEqual([])
	})

	test("fails when the owner environment has no domain, since nothing can reach the owner's proxy", async () => {
		const w = await world()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		const owner = await w.db.registry.getAppEnv('catalog', ENV)
		if (owner === null) throw new Error('the catalog has a stage environment')
		await w.db.registry.upsertAppEnv({
			appId: 'catalog',
			env: ENV,
			domain: null,
			namespaceId: null,
			provider: 'harbor',
			providerTargetJson: owner.provider_target_json,
			providerArtifactJson: owner.provider_artifact_json,
		})
		expect(await deploy(w, 'shop', shopSource(digestOf(CATALOG)))).toBe('failed')
		expect(w.deploys.filter((input) => input.app.id === 'shop')).toEqual([])
	})
})

describe('an owner deploy', () => {
	test('that removes an output field an approved consumer imports is refused, and the approved export stays', async () => {
		const w = await world()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		expect(await deploy(w, 'shop', shopSource(digestOf(CATALOG)))).toBe('succeeded')
		const deploys = w.deploys.length
		expect(await deploy(w, 'catalog', CATALOG_WITHOUT_NAME)).toBe('failed')
		expect(runLog(w)).toContain(
			"access: connector: shop@stage imports products@1 (import 'catalog'), and this deploy 'get' answers another output than before; bump the export's version instead",
		)
		expect(w.deploys).toHaveLength(deploys)
		expect(await approvedDigest(w, 'catalog')).toBe(digestOf(CATALOG))
	})

	test('that removes the export, or stops naming the consumer, is refused; one that adds a procedure deploys', async () => {
		const w = await world()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		expect(await deploy(w, 'shop', shopSource(digestOf(CATALOG)))).toBe('succeeded')
		const withoutExport = CATALOG.slice(0, CATALOG.indexOf('\texports: {')) + '}))\n'
		expect(await deploy(w, 'catalog', withoutExport)).toBe('failed')
		expect(runLog(w)).toContain('which this deploy removes; keep that version until shop no longer imports it')
		expect(await deploy(w, 'catalog', CATALOG.replace("consumers: ['shop']", "consumers: ['crm']"))).toBe('failed')
		expect(runLog(w)).toContain('and this deploy no longer names shop as a consumer')
		expect(await deploy(w, 'catalog', CATALOG_WITH_LIST)).toBe('succeeded')
	})

	test('with no consumer importing it changes freely', async () => {
		const w = await world()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		expect(await deploy(w, 'catalog', CATALOG_WITHOUT_NAME)).toBe('succeeded')
	})
})

describe('describeConnector', () => {
	test("answers the owner's approved export to its consumer, and the same nothing for any other request", async () => {
		const w = await world()
		const request = { consumer: 'shop', env: ENV, app: 'catalog', export: 'products', version: 1 }
		expect(await describeConnector(w.db.registry, request)).toBeNull()
		expect(await deploy(w, 'catalog', CATALOG)).toBe('succeeded')
		expect((await describeConnector(w.db.registry, request))?.digest).toBe(digestOf(CATALOG))
		for (const other of [{ consumer: 'crm' }, { version: 2 }, { export: 'orders' }, { env: 'prod' }]) {
			expect(await describeConnector(w.db.registry, { ...request, ...other })).toBeNull()
		}
	})
})
