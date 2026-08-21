// A deploy that cannot inject the Operations-managed environment says so in the run log, naming the
// catalog state it observed (backlog 84). Before this, the first deploy after a registration shipped
// without `FABRIKA_OPERATIONS_DSN` and nothing anywhere recorded that it had.

import { FABRIKA_OPERATIONS_DSN } from '@fabrika/operations-contract/ingest'
import type { BlobStore } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { ControlRepositories } from '../db'
import { uuidv7 } from '../db'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { EnvSecretResolver } from '../secret-resolver'
import { createHarness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

const PROVIDER_ID = 'memory'

const envelope = (payload: string): ProviderEnvelope => ({ provider: PROVIDER_ID, version: 1, payload })

async function seedRun(db: ControlRepositories): Promise<string> {
	await db.registry.createApp({ id: 'app', repoUrl: 'https://github.com/acme/app.git', githubInstallationId: 42 })
	await db.registry.upsertAppEnv({
		appId: 'app',
		env: 'prod',
		domain: 'app.example.com',
		publicOrigin: 'https://public.example.com',
		namespaceId: null,
		provider: PROVIDER_ID,
		providerTargetJson: JSON.stringify(envelope('target')),
		providerArtifactJson: JSON.stringify(envelope('artifact')),
	})
	const runId = uuidv7()
	await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'refs/heads/main', trigger: 'manual' })
	return runId
}

function memoryLogs(): { logs: BlobStore; lines: () => string[] } {
	const objects = new Map<string, string>()
	return {
		logs: {
			put: (key, value) => {
				if (typeof value !== 'string') throw new Error('test log store accepts strings only')
				objects.set(key, value)
				return Promise.resolve()
			},
			get: () => Promise.resolve(null),
			delete: () => Promise.resolve(),
		},
		lines: () =>
			[...objects.values()]
				.flatMap((contents) => contents.split('\n'))
				.filter((line) => line !== '')
				.map((line) => {
					const parsed: unknown = JSON.parse(line)
					if (typeof parsed !== 'object' || parsed === null) throw new Error('unreadable run log line')
					const text = Reflect.get(parsed, 'text')
					if (typeof text !== 'string') throw new Error('unreadable run log line')
					return text
				}),
	}
}

function deps(db: ControlRepositories, logs: BlobStore, inputs: ProviderDeployInput[]): RunDeps {
	const provider: ControlProvider = {
		id: PROVIDER_ID,
		normalizeRegistration: (input) => input,
		deploy: (input) => {
			inputs.push(input)
			return Promise.resolve({ state: 'succeeded' })
		},
	}
	return { repositories: db, provider, secrets: new EnvSecretResolver({}), lock: makeFakeLock(), logs }
}

describe('deploy run log names a missing Operations ingest configuration', () => {
	test('reports a pending catalog revision when a registration has not been projected yet', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.operationsCatalog.markDirty()
		await db.operationsCatalog.markAttempt(1, 'snapshot-hash')
		const stored = memoryLogs()
		const inputs: ProviderDeployInput[] = []

		expect((await executeDeploy(deps(db, stored.logs, inputs), { runId })).status).toBe('succeeded')
		expect(stored.lines()).toEqual([
			'operations ingest not injected: app has no active ingest config (catalog revision 1 pending)',
		])
		expect(inputs[0]?.managedEnvironment[FABRIKA_OPERATIONS_DSN]).toBeNull()
	})

	test('reports that Operations is not wired when no change ever advanced a revision', async () => {
		// `runCatalogSync` answers `disabled` before `markDirty`, so a registered app with desired 0 is an
		// installation without an Operations transport — not one whose projection is late.
		const { db } = createHarness()
		const runId = await seedRun(db)
		const stored = memoryLogs()

		expect((await executeDeploy(deps(db, stored.logs, []), { runId })).status).toBe('succeeded')
		expect(stored.lines()).toEqual(['operations ingest not injected: app has no active ingest config (operations catalog is disabled)'])
	})

	test('reports that a scheduled sync has not been attempted yet', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.operationsCatalog.markDirty()
		const stored = memoryLogs()

		expect((await executeDeploy(deps(db, stored.logs, []), { runId })).status).toBe('succeeded')
		expect(stored.lines()).toEqual(['operations ingest not injected: app has no active ingest config (no catalog sync yet)'])
	})

	test('reports the ATTEMPTED revision and the stored reason when the last sync failed', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.operationsCatalog.markDirty()
		await db.operationsCatalog.markAttempt(1, 'snapshot-hash')
		await db.operationsCatalog.markDirty()
		await db.operationsCatalog.markFailed('operations catalog transport is not configured')
		const stored = memoryLogs()

		expect((await executeDeploy(deps(db, stored.logs, []), { runId })).status).toBe('succeeded')
		expect(stored.lines()).toEqual([
			'operations ingest not injected: app has no active ingest config '
			+ '(catalog revision 1 failed: operations catalog transport is not configured)',
		])
	})

	test('replaces a pre-existing log object with the gap line, and completes that write before the provider starts', async () => {
		// The sibling of run-lifecycle.test.ts's "does not overwrite an existing runner log": with no active
		// ingest config control DOES write, so the object it replaces must not be a live runner log. It cannot
		// be — `executeDeploy` refuses a run that is not `pending`, so no relay has written for this run yet —
		// and the write completes BEFORE the provider is invoked, so a later relay flush always wins the key.
		const { db } = createHarness()
		const runId = await seedRun(db)
		const key = `runs/${runId}/logs.ndjson`
		const objects = new Map<string, string>([[key, '{"ts":1,"stream":"stdout","text":"runner-owned"}']])
		const writes: string[] = []
		const logs: BlobStore = {
			put: (target, value) => {
				if (typeof value !== 'string') throw new Error('test log store accepts strings only')
				writes.push('put')
				objects.set(target, value)
				return Promise.resolve()
			},
			get: () => Promise.resolve(null),
			delete: () => Promise.resolve(),
		}
		const provider: ControlProvider = {
			id: PROVIDER_ID,
			normalizeRegistration: (input) => input,
			deploy: () => {
				writes.push('deploy')
				return Promise.resolve({ state: 'succeeded' })
			},
		}

		expect(
			(await executeDeploy(
				{ repositories: db, provider, secrets: new EnvSecretResolver({}), lock: makeFakeLock(), logs },
				{ runId },
			)).status,
		).toBe('succeeded')
		expect(writes).toEqual(['put', 'deploy'])
		expect(objects.get(key)).toContain('operations ingest not injected')
		expect(objects.get(key)).not.toContain('runner-owned')
	})

	test('reports an applied revision that carries no configuration for this environment', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.operationsCatalog.markDirty()
		await db.operationsCatalog.snapshot()
		await db.operationsCatalog.markAttempt(1, 'snapshot-hash')
		// Applied with an EMPTY config list: exactly the live shape where Operations knows the source and
		// control never recorded the ingest configuration back.
		await db.operationsCatalog.markApplied(1, 'snapshot-hash', [])
		const stored = memoryLogs()

		expect((await executeDeploy(deps(db, stored.logs, []), { runId })).status).toBe('succeeded')
		expect(stored.lines()).toEqual([
			'operations ingest not injected: app has no active ingest config '
			+ '(catalog revision 1 applied with no configuration for this environment)',
		])
	})

	test('writes nothing about Operations when the ingest configuration is active', async () => {
		const { db } = createHarness()
		const runId = await seedRun(db)
		await db.operationsCatalog.markDirty()
		const snapshot = await db.operationsCatalog.snapshot()
		const source = snapshot.sources[0]
		if (source === undefined) throw new Error('missing Operations catalog source')
		const dsn = `https://${source.public_key}@errors.example.test/100000000000000001`
		await db.operationsCatalog.markApplied(snapshot.revision, 'snapshot-hash', [{
			appId: source.app_id,
			environment: source.env,
			serviceKey: source.service_key,
			credentialId: source.credential_id,
			ingestProjectId: '100000000000000001',
			dsn,
		}])
		const stored = memoryLogs()
		const inputs: ProviderDeployInput[] = []

		expect((await executeDeploy(deps(db, stored.logs, inputs), { runId })).status).toBe('succeeded')
		expect(stored.lines()).toEqual([])
		expect(inputs[0]?.managedEnvironment[FABRIKA_OPERATIONS_DSN]).toBe(dsn)
	})
})
