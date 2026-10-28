// A dev bootstrap: a run whose lane is a workspace of a `dev` environment deploys into that workspace's sandbox, with the
// workspace's own origin, proxy secret and source key, publishes the workspace's proxy table and keeps IAM's return
// origins to the environment's ready sandboxes. No credential reaches a log line.

import { FABRIKA_APP_ORIGIN, FABRIKA_PROXY_SECRET, platformTransportVariables } from '@fabrika/auth-core'
import { hashPlatformKey } from '@fabrika/email/platform'
import { type BlobStore, uuidv7 } from '@fabrika/platform'
import type { ControlProvider, ProviderDeployInput, ProviderDevSandboxes, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import { triggerDeployUseCase } from '../api/runs'
import { parseClassification } from '../approval/publish'
import type { ControlRepositories } from '../db'
import {
	deleteDevSandboxProxySecret,
	DEV_RUN_NEEDS_WORKSPACE,
	type DevSandboxKeyDeps,
	devSandboxOrigin,
	devSandboxProxySecret,
	sandboxHostKey,
	sandboxHostKeyPurpose,
	workspacePublication,
} from '../dev/sandbox-keys'
import type { IamSchemaPort } from '../iam-schema'
import { VaultPlatformTransport } from '../platform-transport'
import { VaultProxySecrets } from '../proxy-secret'
import { projectedReturnOrigins } from '../return-origins'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { Vault } from '../vault'
import { memoryCommits } from './helpers/commits'
import { BASE, edited } from './helpers/contracts'
import { createHarness, queryRows } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'
import { makeFakeLock } from './helpers/lock'
import { testVaultKey } from './helpers/vault'

const COMMIT = 'c'.repeat(40)
const DOMAIN = 'dev.notes.test'
const CONTROL_ORIGIN = 'https://control.example.test'
const ENVELOPE = JSON.stringify({ provider: 'harbor', version: 1, payload: {} })
const SOURCE_KEY = platformTransportVariables('source').key

interface IamWrite {
	readonly app: string
	readonly returnOrigins: readonly string[] | undefined
}

interface World {
	readonly db: ControlRepositories
	readonly sqlite: ReturnType<typeof createHarness>['sqlite']
	readonly vault: Vault
	readonly deploys: ProviderDeployInput[]
	readonly republished: Array<{ readonly members: readonly ProviderNamespaceMember[]; readonly sandboxKey: string | undefined }>
	readonly iam: IamWrite[]
	readonly logs: Map<string, string>
}

async function world(): Promise<World> {
	const { db, sqlite, d1 } = createHarness()
	const vault = await Vault.create(d1, testVaultKey())
	const w: World = { db, sqlite, vault, deploys: [], republished: [], iam: [], logs: new Map() }
	await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	await db.registry.createDeploymentNamespaceWithResourceClaims({
		id: 'apps-dev',
		env: 'dev',
		provider: 'harbor',
		exclusiveAppId: null,
		providerTargetJson: ENVELOPE,
		state: 'ready',
	}, [])
	await db.registry.upsertAppEnv({
		appId: 'notes',
		env: 'dev',
		kind: 'dev',
		domain: DOMAIN,
		namespaceId: 'apps-dev',
		provider: 'harbor',
		providerTargetJson: ENVELOPE,
		providerArtifactJson: ENVELOPE,
	})
	return w
}

/** A provider that serves workspace sandboxes, or, with `sandboxes: false`, one that predates them. */
function provider(w: World, sandboxes = true): ControlProvider {
	return {
		id: 'harbor',
		...(sandboxes ? { devSandboxes: noSandboxEffects } : {}),
		normalizeRegistration: (input) => input,
		applicationRoot: () => '',
		resolveSource: () => Promise.resolve({ commitSha: COMMIT }),
		deploy: (input) => {
			w.deploys.push(input)
			return Promise.resolve({ state: 'succeeded' })
		},
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: () => [],
			registrationResourceClaims: () => [],
			provision: (input) => Promise.resolve(input.namespace),
			reconcile: (input) => Promise.resolve(input.namespace),
			republish: (input) => {
				w.republished.push({ members: input.members, sandboxKey: input.sandboxKey })
				return Promise.resolve({ namespace: input.namespace, settled: true })
			},
		},
	}
}

const noSandboxEffects: ProviderDevSandboxes = {
	ensure: () => Promise.reject(new Error('not used')),
	park: () => Promise.resolve(),
	wake: () => Promise.resolve(),
	remove: () => Promise.resolve(),
}

/** `BASE` for the application `crm`, a standard environment sharing the dev namespace. */
const CRM = edited("app: 'notes'", "app: 'crm'")

const keyDeps = (w: World): DevSandboxKeyDeps => ({ repositories: w.db, vault: () => Promise.resolve(w.vault) })

function deps(w: World): RunDeps {
	const logs: Pick<BlobStore, 'put'> = {
		put: (key, value) => {
			if (typeof value === 'string') w.logs.set(key, value)
			return Promise.resolve()
		},
	}
	const iamSchema: IamSchemaPort = {
		apply: (input) => Promise.resolve(void w.iam.push({ app: input.app, returnOrigins: input.returnOrigins })),
	}
	return {
		repositories: w.db,
		provider: provider(w),
		proxySecrets: new VaultProxySecrets(w.db.registry, () => Promise.resolve(w.vault)),
		platformTransport: new VaultPlatformTransport(w.db.platformTransportKeys, () => Promise.resolve(w.vault)),
		vault: () => Promise.resolve(w.vault),
		controlOrigin: CONTROL_ORIGIN,
		iamSchema,
		secrets: new VaultSecretResolver({}),
		lock: makeFakeLock(w.db),
		queue: { send: () => Promise.resolve() },
		logs,
		commits: {
			...memoryCommits(),
			open: (input) => memoryCommits({ 'fabrika.contract.ts': input.repoUrl.endsWith('/crm') ? CRM : BASE }).open(input),
		},
	}
}

/** A workspace of `notes/dev` whose sandbox Box created, as `bind_dev` leaves it. */
async function readySandbox(w: World): Promise<string> {
	const workspaceId = uuidv7()
	await w.db.workspaces.createWorkspace({
		id: workspaceId,
		appId: 'notes',
		env: 'dev',
		ownerId: 'user:ada',
		branch: `fabrika/${workspaceId}`,
		baseSha: 'a'.repeat(40),
		title: 't',
	})
	await w.db.devSandboxes.insertCreating({ workspaceId, appId: 'notes', env: 'dev', now: 1 })
	const { ref } = await devSandboxProxySecret(keyDeps(w), { appId: 'notes', env: 'dev', workspaceId })
	await w.db.devSandboxes.markReady({
		workspaceId,
		sandboxId: `sbx-${workspaceId}`,
		baseDigest: 'sha256:base',
		upstreamHost: `3000-sbx-${workspaceId}.box.test`,
		proxySecretRef: ref,
	})
	return workspaceId
}

async function bootstrap(w: World, workspaceId: string, runDeps: RunDeps = deps(w)): Promise<{ runId: string; status: string }> {
	const runId = uuidv7()
	await w.db.runs.createRun({
		id: runId,
		appId: 'notes',
		env: 'dev',
		ref: `refs/heads/fabrika/${workspaceId}`,
		trigger: 'manual',
		actor: 'user:test',
		lane: workspaceId,
	})
	return executeDeploy(runDeps, { runId })
}

/** The managed environment one deploy handed the provider, by name. */
const handed = (input: ProviderDeployInput | undefined): Readonly<Record<string, string | null>> =>
	Object.fromEntries(Object.entries(input?.managedEnvironment ?? {}).map(([name, entry]) => [name, entry.value]))

describe('a dev bootstrap', () => {
	const printed: string[] = []
	let spies: Array<{ mockRestore(): void }> = []

	beforeEach(() => {
		printed.length = 0
		const capture = (...args: unknown[]): void => void printed.push(args.map(String).join(' '))
		spies = [
			spyOn(console, 'info').mockImplementation(capture),
			spyOn(console, 'error').mockImplementation(capture),
			spyOn(console, 'warn').mockImplementation(capture),
			spyOn(console, 'log').mockImplementation(capture),
		]
	})

	afterEach(() => {
		for (const spy of spies) spy.mockRestore()
	})

	test("deploys into the workspace's sandbox with its origin, proxy secret and source key", async () => {
		const w = await world()
		const workspaceId = await readySandbox(w)
		const result = await bootstrap(w, workspaceId)
		expect(result.status).toBe('succeeded')

		const origin = `https://${workspaceId}.${DOMAIN}`
		const input = w.deploys[0]
		const hostKey = await sandboxHostKey(keyDeps(w), 'apps-dev')
		expect(input?.devSandbox).toEqual({ workspaceId, sandboxId: `sbx-${workspaceId}`, origin, sandboxKey: hostKey })
		const env = handed(input)
		expect(env[FABRIKA_APP_ORIGIN]).toBe(origin)
		const secret = (await devSandboxProxySecret(keyDeps(w), { appId: 'notes', env: 'dev', workspaceId })).secret
		expect(env[FABRIKA_PROXY_SECRET]).toBe(secret)
		// Not the environment's own secret: each workspace has its own.
		expect(secret).not.toBe(await new VaultProxySecrets(w.db.registry, () => Promise.resolve(w.vault)).forAppEnv('notes', 'dev'))

		const sourceKey = env[SOURCE_KEY]
		expect(typeof sourceKey).toBe('string')
		const keyRow = await w.db.platformTransportKeys.findValidByHash(await hashPlatformKey(sourceKey ?? ''), Math.floor(Date.now() / 1000))
		expect(keyRow).toMatchObject({ app_id: 'notes', env: 'dev', receiver: 'source', workspace_id: workspaceId })

		expect((await w.db.devSandboxes.get(workspaceId))?.published_run_id).toBe(result.runId)
		const appEnv = await w.db.registry.getAppEnv('notes', 'dev')
		expect(appEnv?.iam_digest).toBe(input?.environment.access?.contractDigest ?? 'missing')
		expect(w.iam).toEqual([{ app: 'notes@dev', returnOrigins: [origin] }])
	})

	test('two workspaces get their own secrets and keys, and the namespace proxy routes both', async () => {
		const w = await world()
		const first = await readySandbox(w)
		const second = await readySandbox(w)
		expect((await bootstrap(w, first)).status).toBe('succeeded')
		expect((await bootstrap(w, second)).status).toBe('succeeded')

		const [a, b] = [handed(w.deploys[0]), handed(w.deploys[1])]
		expect(a[FABRIKA_PROXY_SECRET]).not.toBe(b[FABRIKA_PROXY_SECRET])
		expect(a[SOURCE_KEY]).not.toBe(b[SOURCE_KEY])
		expect(a[FABRIKA_APP_ORIGIN]).not.toBe(b[FABRIKA_APP_ORIGIN])
		expect(w.deploys[0]?.devSandbox?.sandboxKey).toBe(w.deploys[1]?.devSandbox?.sandboxKey ?? 'missing')

		// The second run's republish already routes the first workspace's table and its own fresh publication.
		const republish = w.republished[1]
		expect(republish?.sandboxKey).toBe(await sandboxHostKey(keyDeps(w), 'apps-dev'))
		const member = republish?.members.find((m) => m.appId === 'notes' && m.env === 'dev')
		expect(member?.access).toBeUndefined()
		expect(
			member?.devSandboxes?.map((s) => ({ workspaceId: s.workspaceId, host: s.host, upstreamHost: s.upstreamHost, proxySecret: s.proxySecret ?? null })),
		)
			.toEqual(
				[first, second].sort().map((workspaceId) => ({
					workspaceId,
					host: `${workspaceId}.${DOMAIN}`,
					upstreamHost: `3000-sbx-${workspaceId}.box.test`,
					proxySecret: workspaceId === first ? a[FABRIKA_PROXY_SECRET] : b[FABRIKA_PROXY_SECRET],
				})),
			)
		expect(member?.devSandboxes?.every((s) => s.access.contractDigest !== '')).toBe(true)

		expect(w.iam[1]?.returnOrigins).toEqual([first, second].sort().map((id) => `https://${id}.${DOMAIN}`))
	})

	test("a workspace's next bootstrap is classified against its own publication, not the last workspace's", async () => {
		const w = await world()
		const first = await readySandbox(w)
		const second = await readySandbox(w)
		const one = await bootstrap(w, first)
		await bootstrap(w, second)
		const again = await bootstrap(w, first)
		expect(again.status).toBe('succeeded')
		const run = await w.db.runs.getRun(again.runId)
		expect(parseClassification(run?.classification_json ?? '{}').baselineRunId).toBe(one.runId)
	})

	test('a workspace without a ready sandbox fails the run in one line and deploys nothing', async () => {
		const w = await world()
		const workspaceId = uuidv7()
		await w.db.workspaces.createWorkspace({
			id: workspaceId,
			appId: 'notes',
			env: 'dev',
			ownerId: 'user:ada',
			branch: `fabrika/${workspaceId}`,
			baseSha: 'a'.repeat(40),
			title: 't',
		})
		await w.db.devSandboxes.insertCreating({ workspaceId, appId: 'notes', env: 'dev', now: 1 })
		expect((await bootstrap(w, workspaceId)).status).toBe('failed')
		expect(w.deploys).toEqual([])
		expect([...w.logs.values()].join('\n')).toContain(`deploy failed: the sandbox of workspace ${workspaceId} is not ready (creating)`)
		expect((await w.db.registry.getAppEnv('notes', 'dev'))?.generation).toBe(0)
	})

	test('without a vault the bootstrap fails naming FABRIKA_CONTROL_VAULT_KEY', async () => {
		const w = await world()
		const workspaceId = await readySandbox(w)
		const { vault: _vault, ...withoutVault } = deps(w)
		expect((await bootstrap(w, workspaceId, withoutVault)).status).toBe('failed')
		expect(w.deploys).toEqual([])
		expect([...w.logs.values()].join('\n')).toContain('FABRIKA_CONTROL_VAULT_KEY')
	})

	test('no credential reaches a log line, the run log or an error', async () => {
		const w = await world()
		const workspaceId = await readySandbox(w)
		expect((await bootstrap(w, workspaceId)).status).toBe('succeeded')
		const env = handed(w.deploys[0])
		const credentials = [env[FABRIKA_PROXY_SECRET], env[SOURCE_KEY], w.deploys[0]?.devSandbox?.sandboxKey]
		expect(credentials.every((value) => typeof value === 'string' && value.length >= 20)).toBe(true)
		const written = [...printed, ...w.logs.values()].join('\n')
		expect(written).toContain('access: published')
		for (const credential of credentials) expect(written).not.toContain(credential ?? 'missing')
	})
})

describe('the sandbox keys', () => {
	test("the namespace's host key is generated once, alphanumeric, and sealed under its purpose", async () => {
		const w = await world()
		const key = await sandboxHostKey(keyDeps(w), 'apps-dev')
		expect(key).toMatch(/^[0-9a-f]{64}$/)
		expect(await sandboxHostKey(keyDeps(w), 'apps-dev')).toBe(key)
		const ref = await w.db.registry.getNamespaceSandboxKeyRef('apps-dev')
		expect(await w.vault.getSecretForPurpose(ref ?? '', sandboxHostKeyPurpose('apps-dev'))).toBe(key)
		expect(queryRows(w.sqlite, "SELECT label FROM vault WHERE label LIKE 'platform:sandbox-host-key:%'")).toEqual([
			{ label: 'platform:sandbox-host-key:apps-dev' },
		])
	})

	test('a workspace proxy secret that was never recorded is deleted with its reference', async () => {
		const w = await world()
		const workspaceId = uuidv7()
		const { ref } = await devSandboxProxySecret(keyDeps(w), { appId: 'notes', env: 'dev', workspaceId })
		await deleteDevSandboxProxySecret(keyDeps(w), ref)
		expect(queryRows(w.sqlite, 'SELECT id FROM vault')).toEqual([])
	})

	test("revoking a workspace's source keys leaves the other workspace's and the environment's", async () => {
		const w = await world()
		const first = await readySandbox(w)
		const second = await readySandbox(w)
		const transport = new VaultPlatformTransport(w.db.platformTransportKeys, () => Promise.resolve(w.vault))
		const a = await transport.issue('notes', 'dev', 'source', { workspaceId: first })
		const b = await transport.issue('notes', 'dev', 'source', { workspaceId: second })
		const shared = await transport.issue('notes', 'dev', 'source')
		expect(new Set([a, b, shared]).size).toBe(3)
		// The newest key of each workspace is reused while it is fresh.
		expect(await transport.issue('notes', 'dev', 'source', { workspaceId: first })).toBe(a)

		await transport.revokeWorkspaceSourceKeys('notes', 'dev', first)
		const left = await w.db.platformTransportKeys.listForAppEnv('notes', 'dev')
		expect(left.map((row) => row.workspace_id).sort()).toEqual([null, second].sort())
		expect(await transport.issue('notes', 'dev', 'source', { workspaceId: second })).toBe(b)
		expect(await transport.issue('notes', 'dev', 'source')).toBe(shared)
	})
})

describe('the return origins of a dev environment', () => {
	test("are its ready sandboxes' origins, and are left alone once none is left", async () => {
		const w = await world()
		expect(await projectedReturnOrigins(w.db, 'notes', 'dev')).toBeUndefined()
		const workspaceId = await readySandbox(w)
		const appEnv = await w.db.registry.getAppEnv('notes', 'dev')
		if (appEnv === null) throw new Error('no environment')
		expect(await projectedReturnOrigins(w.db, 'notes', 'dev')).toEqual([devSandboxOrigin(appEnv, workspaceId)])
		await w.db.devSandboxes.markRemoving(workspaceId)
		expect(await projectedReturnOrigins(w.db, 'notes', 'dev')).toBeUndefined()
	})
})

/** A run of `appId`'s `dev` environment, in `lane` or none. */
async function deployRun(w: World, appId: string, lane: string | null, runDeps: RunDeps, dryRun = false): Promise<{ runId: string; status: string }> {
	const runId = uuidv7()
	await w.db.runs.createRun({ id: runId, appId, env: 'dev', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test', lane })
	return executeDeploy(runDeps, { runId, dryRun })
}

/** `crm`, a standard environment in the same namespace as the dev environment. */
async function seedCrm(w: World): Promise<void> {
	await w.db.registry.createApp({ id: 'crm', repoUrl: 'github.com/acme/crm' })
	await w.db.registry.upsertAppEnv({
		appId: 'crm',
		env: 'dev',
		domain: 'crm.test',
		namespaceId: 'apps-dev',
		provider: 'harbor',
		providerTargetJson: ENVELOPE,
		providerArtifactJson: ENVELOPE,
	})
}

describe('a dev bootstrap beside the rest of the namespace', () => {
	let quiet: Array<{ mockRestore(): void }> = []
	const printed: string[] = []

	beforeEach(() => {
		printed.length = 0
		const capture = (...args: unknown[]): void => void printed.push(args.map(String).join(' '))
		quiet = [spyOn(console, 'info').mockImplementation(capture), spyOn(console, 'error').mockImplementation(capture)]
	})

	afterEach(() => {
		for (const spy of quiet) spy.mockRestore()
	})

	test('a dev environment without sandboxes is published as before, and a standard deploy opens no vault and hands no host key', async () => {
		const w = await world()
		await seedCrm(w)
		// The dev environment published by a provider that predates sandboxes.
		expect((await deployRun(w, 'notes', null, { ...deps(w), provider: provider(w, false) })).status).toBe('succeeded')
		let opened = 0
		const counted: RunDeps = {
			...deps(w),
			vault: () => {
				opened++
				return Promise.resolve(w.vault)
			},
		}
		expect((await deployRun(w, 'crm', null, counted)).status).toBe('succeeded')
		const last = w.republished.at(-1)
		expect(last?.sandboxKey).toBeUndefined()
		expect(opened).toBe(0)
		expect(await w.db.registry.getNamespaceSandboxKeyRef('apps-dev')).toBeNull()
		const notes = last?.members.find((member) => member.appId === 'notes')
		expect(notes?.devSandboxes).toBeUndefined()
		expect(notes?.domain).toBe(DOMAIN)
		expect(typeof notes?.proxySecret).toBe('string')
		expect(notes?.access?.contractDigest).toMatch(/^sha256:/)
	})

	test('a dev member routed by sandboxes carries neither the environment secret nor its access', async () => {
		const w = await world()
		const workspaceId = await readySandbox(w)
		expect((await bootstrap(w, workspaceId)).status).toBe('succeeded')
		const notes = w.republished.at(-1)?.members.find((member) => member.appId === 'notes')
		expect(notes?.proxySecret).toBeUndefined()
		expect(notes?.access).toBeUndefined()
		expect(notes?.devSandboxes?.map((sandbox) => sandbox.workspaceId)).toEqual([workspaceId])
		expect(queryRows(w.sqlite, "SELECT label FROM vault WHERE label = 'platform:proxy-secret:notes@dev'")).toEqual([])
	})

	test('a dev run without a workspace is refused before any effect, and the deploy trigger refuses the environment', async () => {
		const w = await world()
		expect((await deployRun(w, 'notes', null, deps(w))).status).toBe('failed')
		expect(w.deploys).toEqual([])
		expect([...w.logs.values()].join('\n')).toContain(`deploy failed: ${DEV_RUN_NEEDS_WORKSPACE}`)
		expect((await w.db.registry.getAppEnv('notes', 'dev'))?.generation).toBe(0)
		expect(await w.db.platformTransportKeys.listForAppEnv('notes', 'dev')).toEqual([])

		const context = {
			repositories: w.db,
			queue: { send: () => Promise.resolve() },
			logs: { get: () => Promise.resolve(null) },
			cancel: () => Promise.resolve(),
			auth: allowAllAuth(),
		}
		const refused = await triggerDeployUseCase({ ...context, devSandboxes: true }, { appId: 'notes', env: 'dev' }).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(ControlApiError)
		expect(refused instanceof ControlApiError ? [refused.httpStatus, refused.message] : []).toEqual([409, DEV_RUN_NEEDS_WORKSPACE])
		expect((await triggerDeployUseCase(context, { appId: 'notes', env: 'dev' })).status).toBe('pending')
	})

	test('a dry run of a workspace bootstrap is refused in one line', async () => {
		const w = await world()
		const workspaceId = await readySandbox(w)
		expect((await deployRun(w, 'notes', workspaceId, deps(w), true)).status).toBe('failed')
		expect(w.deploys).toEqual([])
		expect([...w.logs.values()].join('\n')).toContain(`a dev bootstrap has no dry run: workspace ${workspaceId}`)
	})

	test("a workspace bootstrap keeps the environment's keys that other sandboxes hold; a standard deploy reconciles as before", async () => {
		const w = await world()
		await seedCrm(w)
		const transport = new VaultPlatformTransport(w.db.platformTransportKeys, () => Promise.resolve(w.vault))
		await transport.issue('notes', 'dev', 'mail')
		await transport.issue('crm', 'dev', 'mail')
		const asked: Array<{ appId: string; workload?: boolean; membership?: boolean }> = []
		const recording: RunDeps = {
			...deps(w),
			workloadCredentials: {
				reconcile: (appId, _env, _contract, options) =>
					Promise.resolve(void asked.push({ appId, workload: options?.additive === true })).then(() => ({})),
			},
			membershipTransport: {
				reconcile: (appId, _env, _needed, options) =>
					Promise.resolve(void asked.push({ appId, membership: options?.additive === true })).then(() => null),
			},
		}
		const workspaceId = await readySandbox(w)
		expect((await bootstrap(w, workspaceId, recording)).status).toBe('succeeded')
		expect((await deployRun(w, 'crm', null, recording)).status).toBe('succeeded')
		expect(asked).toEqual([
			{ appId: 'notes', workload: true },
			{ appId: 'notes', membership: true },
			{ appId: 'crm', workload: false },
			{ appId: 'crm', membership: false },
		])
		// Neither version relays mail: only the standard deploy revokes its environment's relay key.
		expect((await w.db.platformTransportKeys.listForAppEnv('notes', 'dev')).filter((row) => row.receiver === 'mail')).toHaveLength(1)
		expect(await w.db.platformTransportKeys.listForAppEnv('crm', 'dev')).toEqual([])
	})

	test('a sandbox whose secret cannot be opened is not routed, and the others still are', async () => {
		const w = await world()
		const broken = await readySandbox(w)
		const healthy = await readySandbox(w)
		expect((await bootstrap(w, broken)).status).toBe('succeeded')
		const other = (await w.db.devSandboxes.get(healthy))?.proxy_secret_ref ?? null
		w.sqlite.run('UPDATE dev_sandboxes SET proxy_secret_ref = ? WHERE workspace_id = ?', [other, broken])
		expect((await bootstrap(w, healthy)).status).toBe('succeeded')
		const notes = w.republished.at(-1)?.members.find((member) => member.appId === 'notes')
		expect(notes?.devSandboxes?.map((sandbox) => sandbox.workspaceId)).toEqual([healthy])
		expect(printed.join('\n')).toContain(
			`dev sandbox of workspace ${broken}: its proxy secret or published snapshot cannot be read, so it is not routed`,
		)
	})

	test('a sandbox follows only a published run of its own workspace and environment', async () => {
		const w = await world()
		const first = await readySandbox(w)
		const second = await readySandbox(w)
		const { runId } = await bootstrap(w, first)
		const row = await w.db.devSandboxes.get(second)
		if (row === null) throw new Error('no sandbox')
		expect(await workspacePublication(w.db, { ...row, published_run_id: runId })).toBeNull()
		expect(await workspacePublication(w.db, { ...row, workspace_id: first, published_run_id: runId })).not.toBeNull()
	})
})

describe('the dev sandbox record', () => {
	test("records a published run only under the run's lease, and never for a sandbox being removed", async () => {
		const w = await world()
		const workspaceId = await readySandbox(w)
		const runId = uuidv7()
		await w.db.runs.createRun({
			id: runId,
			appId: 'notes',
			env: 'dev',
			ref: 'refs/heads/main',
			trigger: 'manual',
			actor: 'user:test',
			lane: workspaceId,
		})
		expect(await w.db.devSandboxes.recordPublishedRunUnderLease(workspaceId, runId, { holder: 'nobody', nowMs: Date.now() })).toBe(false)
		await w.db.devSandboxes.markRemoving(workspaceId)
		expect(await w.db.devSandboxes.recordPublishedRun(workspaceId, runId)).toBe(false)
		expect((await w.db.devSandboxes.get(workspaceId))?.published_run_id).toBeNull()
	})

	test('a second markReady keeps the proxy secret the sandbox already records', async () => {
		const w = await world()
		const workspaceId = await readySandbox(w)
		const recorded = (await w.db.devSandboxes.get(workspaceId))?.proxy_secret_ref
		const again = await w.db.devSandboxes.markReady({
			workspaceId,
			sandboxId: `sbx-${workspaceId}`,
			baseDigest: 'sha256:base',
			upstreamHost: 'h',
			proxySecretRef: 'vault:other',
		})
		expect(again?.proxy_secret_ref).toBe(recorded ?? 'missing')
	})
})
