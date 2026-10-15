// Control's real Zerops composition over the local stack's seams: the shipped migrations, the fixture
// seed, `createRuntime` and the vault-held App keys, with GitHub answered by the double. Needs a real
// Postgres, like every other database-backed suite in the repository.
import { FABRIKA_SERVICE_TABLE_DIGEST } from '@fabrika/auth-core'
import { controlServiceDigest } from '@fabrika/control/service'
import { Vault } from '@fabrika/control/vault'
import { createRuntime } from '@fabrika/control/zerops/runtime'
import { PostgresDatabase } from '@fabrika/platform-node'
import type { ProviderEnvironment, ProviderSourceResolution, ProviderSourceResolutionInput } from '@fabrika/provider-contract'
import {
	compileFabrikaManifest,
	createZeropsArtifactSourceDescriptor,
	zeropsArtifactCodec,
	zeropsNamespaceTargetCodec,
	zeropsStoredTargetCodec,
} from '@fabrika/provider-zerops'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import cheapNotesConfig from 'fabrika-example-zerops/fabrika.cheap.config'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { localSourceSeams } from '../control-server'
import {
	LOCAL_SOURCE_APPLICATION_REPOSITORY_URL,
	LOCAL_SOURCE_FIXTURE_DIRECTORY,
	LOCAL_SOURCE_PLATFORM_REPOSITORY,
	type LocalSourceManifest,
} from '../local-source-contract'
import { prepareLocalSourceFixtures } from '../local-source-fixtures/fixture'
import { REPO_ROOT } from '../prepare'
import { ensureLocalGitHubApps, LOCAL_SOURCE_CONNECTIONS, type LocalGitHubApps } from '../source-connection-fixture'
import { seedLocalSourceConnections } from '../source-connection-fixture-seed'

const POSTGRES_URL = process.env['FABRIKA_TEST_POSTGRES_URL']
const [ALPHA, BETA] = LOCAL_SOURCE_CONNECTIONS
if (ALPHA === undefined || BETA === undefined) throw new Error('the local source connection fixture needs two connections')

if (POSTGRES_URL === undefined) {
	console.info('keyed local source integration skipped: set FABRIKA_TEST_POSTGRES_URL to run Control over the GitHub double')
}

interface Fixture {
	readonly directory: string
	readonly databaseUrl: string
	readonly vaultKey: string
	readonly apps: LocalGitHubApps
	readonly manifest: LocalSourceManifest
}

let fixture: Fixture | undefined
let dropDatabase = async (): Promise<void> => {}

const databaseUrl = (base: string, name: string): string => {
	const url = new URL(base)
	url.pathname = `/${name}`
	return url.href
}

async function migrate(url: string): Promise<void> {
	const child = Bun.spawn(['bun', resolve(REPO_ROOT, 'packages/control/src/zerops/migrate.ts')], {
		env: { PATH: process.env['PATH'] ?? '', FABRIKA_CONTROL_DATABASE_URL: url },
		stdout: 'ignore',
		stderr: 'ignore',
	})
	if (await child.exited !== 0) throw new Error('control migrations failed')
}

async function seed(current: Fixture, apps: LocalGitHubApps = current.apps): Promise<void> {
	const database = PostgresDatabase.connect(current.databaseUrl, { max: 1 })
	try {
		await seedLocalSourceConnections({ database, vault: await Vault.create(database, current.vaultKey), apps, webhookSecret: 'local-webhook-secret' })
	} finally {
		await database.close()
	}
}

beforeAll(async () => {
	if (POSTGRES_URL === undefined) return
	const name = `local_stack_keyed_${randomBytes(4).toString('hex')}`
	const admin = PostgresDatabase.connect(POSTGRES_URL, { max: 1 })
	await admin.prepare(`CREATE DATABASE ${name}`).run()
	await admin.close()
	dropDatabase = async () => {
		const cleanup = PostgresDatabase.connect(POSTGRES_URL, { max: 1 })
		await cleanup.prepare(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).run()
		await cleanup.close()
	}
	const directory = await mkdtemp(join(tmpdir(), 'fabrika-keyed-source-'))
	const url = databaseUrl(POSTGRES_URL, name)
	await migrate(url)
	fixture = {
		directory,
		databaseUrl: url,
		vaultKey: randomBytes(32).toString('base64'),
		apps: await ensureLocalGitHubApps(directory),
		manifest: await prepareLocalSourceFixtures(join(directory, LOCAL_SOURCE_FIXTURE_DIRECTORY)),
	}
	await seed(fixture)
}, 60_000)

afterAll(async () => {
	if (fixture !== undefined) await rm(fixture.directory, { recursive: true, force: true })
	await dropDatabase()
})

const requireFixture = (): Fixture => {
	if (fixture === undefined) throw new Error('the keyed source fixture was not prepared')
	return fixture
}

async function environment(current: Fixture): Promise<ProviderEnvironment> {
	const platform = current.manifest.platform
	const sourceDescriptor = await createZeropsArtifactSourceDescriptor(current.manifest.application.descriptorContents)
	return {
		appId: 'notes',
		env: 'prod',
		namespace: {
			id: 'apps-prod',
			env: 'prod',
			target: {
				provider: 'zerops',
				version: zeropsNamespaceTargetCodec.version,
				payload: zeropsNamespaceTargetCodec.encode({
					proxySource: {
						repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
						commitSha: platform.commitSha,
						descriptor: await createZeropsArtifactSourceDescriptor(platform.descriptorContents),
					},
					projectId: 'project-1',
					proxyServiceId: 'proxy-1',
					ready: true,
				}),
			},
		},
		target: { provider: 'zerops', version: zeropsStoredTargetCodec.version, payload: zeropsStoredTargetCodec.encode({ serviceId: 'notes-1' }) },
		artifact: {
			provider: 'zerops',
			version: zeropsArtifactCodec.version,
			payload: zeropsArtifactCodec.encode(compileFabrikaManifest(cheapNotesConfig, 'prod', sourceDescriptor)),
		},
	}
}

/** Resolve the private application fixture through the composed provider, counting what reaches the App double. */
async function resolveNotes(
	current: Fixture,
	sourceBinding: ProviderSourceResolutionInput['sourceBinding'],
): Promise<{ result: Promise<ProviderSourceResolution>; appCalls: () => number; shutdown: () => Promise<void> }> {
	const seams = await localSourceSeams(current.directory)
	let appCalls = 0
	const runtime = createRuntime({
		FABRIKA_CONTROL_DATABASE_URL: current.databaseUrl,
		FABRIKA_CONTROL_VAULT_KEY: current.vaultKey,
		FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
		FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
		FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
		FABRIKA_IAM_RPC_URL: 'http://iam:3000',
		FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
		FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
		FABRIKA_ZEROPS_CLIENT_ID: 'local-client',
		FABRIKA_ZEROPS_PROXY_SOURCE_JSON: JSON.stringify({
			repository: LOCAL_SOURCE_PLATFORM_REPOSITORY,
			commitSha: current.manifest.platform.commitSha,
			descriptor: await createZeropsArtifactSourceDescriptor(current.manifest.platform.descriptorContents),
		}),
		FABRIKA_ZEROPS_PROXY_IAM_URL: 'http://iam.fabrika.localhost:18080',
		FABRIKA_ZEROPS_PROXY_IAM_KEY: 'px_proxy_placeholder',
		ENVIRONMENT: 'stage',
		[FABRIKA_SERVICE_TABLE_DIGEST]: controlServiceDigest({ mcp: false }),
	}, {
		sourceSeams: {
			...seams,
			githubAppFetch: (input, init) => {
				appCalls++
				return seams.githubAppFetch === undefined ? Promise.reject(new Error('no App double')) : seams.githubAppFetch(input, init)
			},
		},
	})
	const resolveSource = runtime.provider.resolveSource
	if (resolveSource === undefined) throw new Error('the Zerops provider resolves no source')
	const result = resolveSource({
		runId: 'run-1',
		app: { id: 'notes', source: { repoUrl: LOCAL_SOURCE_APPLICATION_REPOSITORY_URL, ref: 'refs/heads/main', workerDir: '.' } },
		environment: await environment(current),
		...(sourceBinding === undefined ? {} : { sourceBinding }),
		signal: AbortSignal.timeout(10_000),
	})
	return { result, appCalls: () => appCalls, shutdown: () => runtime.shutdown() }
}

describe.skipIf(POSTGRES_URL === undefined)('a keyed private deploy over the local GitHub double', () => {
	test("an unbound resolve reads through the owner's connection, and a foreign connection is refused before any App call", async () => {
		const current = requireFixture()
		// The owner's connection covers the repository, so the read is authenticated without a binding (ADR-0029).
		const unbound = await resolveNotes(current, undefined)
		expect(await unbound.result).toEqual({ commitSha: current.manifest.application.commitSha })
		expect(unbound.appCalls()).toBe(1)
		await unbound.shutdown()

		const foreign = await resolveNotes(current, { connectionId: BETA.connectionId, installationId: BETA.installationId })
		await expect(foreign.result).rejects.toThrow('(installation_not_found)')
		expect(foreign.appCalls()).toBe(0)
		await foreign.shutdown()
	})

	test("resolves the pushed branch through a token minted with the bound connection's vault-held App key", async () => {
		const current = requireFixture()
		const keyed = await resolveNotes(current, { connectionId: ALPHA.connectionId, installationId: ALPHA.installationId })
		expect(await keyed.result).toEqual({ commitSha: current.manifest.application.commitSha })
		expect(keyed.appCalls()).toBe(1)
		await keyed.shutdown()
	})

	test('a seeded connection whose App key differs from the key file refuses to start instead of minting a token GitHub would reject', async () => {
		const current = requireFixture()
		const directory = await mkdtemp(join(tmpdir(), 'fabrika-keyed-source-stale-'))
		try {
			await expect(seed(current, await ensureLocalGitHubApps(directory))).rejects.toThrow('explicitly reset the local stack')
			await seed(current)
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
