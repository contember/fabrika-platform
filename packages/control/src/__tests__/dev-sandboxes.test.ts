// One dev sandbox per workspace: `bind_dev` creates the workspace's sandbox and bootstraps it in its own lane, each
// workspace's launcher authenticates with its own source key and follows only its own record, maintenance parks idle
// sandboxes and removes stale ones, and abandoning a workspace removes its sandbox. The provider is a recording fake;
// the SQL runs against the real SQLite schema. No credential reaches a log line, an error or an audit record.

import { type DevReport, type DevWaitAnswer, encodeDevReport, encodeDevWaitRequest, parseDevWaitAnswer } from '@fabrika/app/dev/wire'
import { hashPlatformKey } from '@fabrika/email/platform'
import {
	type ControlProvider,
	PROVIDER_DEV_CAPACITY,
	PROVIDER_DEV_HOST_PENDING,
	type ProviderDevSandboxes,
	type ProviderDevSandboxInput,
	type ProviderDevSandboxRemoveInput,
	ProviderNamespaceError,
} from '@fabrika/provider-contract'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	bindDevUseCase,
	DEV_SANDBOX_CAPACITY,
	DEV_SANDBOX_HOST_PENDING,
	devSandboxRemoval,
	type DevUseCaseContext,
	followDevCommit,
	getDevStatusUseCase,
	listDevTargetsUseCase,
	resetDevUseCase,
	runChecksUseCase,
} from '../api/dev-environments'
import { ControlApiError } from '../api/domain'
import { NamespaceProxyBusyError } from '../api/namespaces'
import { deleteAppUseCase } from '../api/registry/apps'
import { deleteAppEnvUseCase, putAppEnvUseCase } from '../api/registry/environments'
import { abandonWorkspaceUseCase, createWorkspaceUseCase } from '../api/workspaces'
import { approvedAccess, parseSnapshot } from '../approval/snapshot'
import { acceptDevReport, acceptDevWait, type DevReceiverDeps } from '../dev/receiver'
import { DEV_SANDBOX_VAULT_REQUIRED } from '../dev/sandbox-keys'
import { DEV_IDLE_STOP_SECONDS, DEV_SANDBOX_STALE_SECONDS, type DevSandboxDeps, maintainDevSandboxes, removeDevSandbox } from '../dev/service'
import { DevSignals } from '../dev/signals'
import { VaultPlatformTransport } from '../platform-transport'
import { Vault } from '../vault'
import { createHarness, type Harness } from './helpers/harness'
import { testVaultKey } from './helpers/vault'
import {
	AUTHOR_ACTIONS,
	oauthUser,
	registryContext,
	seedWorkspaceWorld,
	sha,
	type WorkspaceWorld,
	zeropsEnvelopes,
	zeropsProvider,
} from './helpers/workspaces'

const DOMAIN = 'dev.shop.test'
const NAMESPACE = 'apps-dev'
const ENVELOPE = JSON.stringify({ provider: 'zerops', version: 1, payload: {} })

/** A sandbox host double: it records every call and keeps the sandboxes it holds, by workspace. */
class FakeSandboxHost implements ProviderDevSandboxes {
	readonly calls: string[] = []
	readonly keys = new Set<string>()
	/** Workspace → the sandbox Box holds for it. */
	readonly held = new Map<string, string>()
	full = false
	/** The namespace has no sandbox host yet: `ensure` says so until a republish created it. */
	hostPending = false
	failRemove = false
	/** The namespace's placement cannot serve sandboxes: `admit` refuses with this. */
	refusal: string | null = null
	/** Held until resolved: Box is still creating the sandbox. */
	creating: Promise<void> | null = null
	private readonly lost = new Set<string>()

	admit() {
		if (this.refusal !== null) throw new ProviderNamespaceError(this.refusal, 'proxySandboxesUnsupported', false)
	}

	async ensure(input: { workspaceId: string; sandboxKey: string }) {
		this.keys.add(input.sandboxKey)
		this.calls.push(`ensure ${input.workspaceId}`)
		if (this.full) throw new ProviderNamespaceError('the sandbox host is full', PROVIDER_DEV_CAPACITY, true)
		if (this.hostPending) throw new ProviderNamespaceError('no sandbox host yet', PROVIDER_DEV_HOST_PENDING, true)
		await this.creating
		const sandboxId = this.held.get(input.workspaceId)
			?? (this.lost.has(input.workspaceId) ? `sbx-${input.workspaceId}-again` : `sbx-${input.workspaceId}`)
		this.held.set(input.workspaceId, sandboxId)
		return { sandboxId, baseDigest: 'sha256:base', upstreamHost: `3000-${sandboxId}.box.test` }
	}

	/** Box lost the workspace's sandbox: the next `ensure` creates another. */
	lose(workspaceId: string): void {
		this.held.delete(workspaceId)
		this.lost.add(workspaceId)
	}

	park(input: ProviderDevSandboxInput) {
		return this.record('park', input)
	}

	wake(input: ProviderDevSandboxInput) {
		return this.record('wake', input)
	}

	remove(input: ProviderDevSandboxRemoveInput) {
		this.keys.add(input.sandboxKey)
		this.calls.push(`remove ${input.sandbox?.sandboxId ?? `workspace ${input.workspaceId}`}`)
		if (this.failRemove) return Promise.reject(new Error('box answered 500'))
		this.held.delete(input.workspaceId)
		return Promise.resolve()
	}

	private record(kind: string, input: ProviderDevSandboxInput): Promise<void> {
		this.keys.add(input.sandboxKey)
		this.calls.push(`${kind} ${input.sandbox.sandboxId}`)
		if (![...this.held.values()].includes(input.sandbox.sandboxId)) return Promise.reject(new Error('sandboxNotFound'))
		return Promise.resolve()
	}
}

interface World extends WorkspaceWorld {
	harness: Harness
	vault: Vault
	host: FakeSandboxHost
	deps: DevSandboxDeps
	signals: DevSignals
	transport: VaultPlatformTransport
	republished: string[]
	/** Every audit record the use cases wrote, as JSON. */
	audits: string[]
	dev(auth?: ReturnType<typeof oauthUser>, deps?: DevSandboxDeps): DevUseCaseContext
	receiver(): DevReceiverDeps
	workspace(title: string): Promise<string>
}

let harness: Harness | null = null
const printed: string[] = []
let spies: Array<{ mockRestore(): void }> = []

beforeEach(() => {
	printed.length = 0
	const capture = (...args: unknown[]): void => void printed.push(args.map(String).join(' '))
	spies = (['info', 'error', 'warn', 'log'] as const).map((level) => spyOn(console, level).mockImplementation(capture))
})

afterEach(() => {
	for (const spy of spies) spy.mockRestore()
	harness?.sqlite.close()
	harness = null
})

async function world(): Promise<World> {
	const opened = createHarness()
	harness = opened
	const { repositories, d1 } = opened
	const seeded = await seedWorkspaceWorld(repositories, d1)
	const vault = await Vault.create(d1, testVaultKey())
	await repositories.registry.createDeploymentNamespaceWithResourceClaims({
		id: NAMESPACE,
		env: 'dev',
		provider: 'zerops',
		exclusiveAppId: null,
		providerTargetJson: ENVELOPE,
		state: 'ready',
	}, [])
	await repositories.registry.upsertAppEnv({
		appId: 'shop',
		env: 'dev',
		kind: 'dev',
		domain: DOMAIN,
		namespaceId: NAMESPACE,
		provider: 'zerops',
		providerTargetJson: ENVELOPE,
		providerArtifactJson: ENVELOPE,
	})
	const host = new FakeSandboxHost()
	const republished: string[] = []
	const audits: string[] = []
	const transport = new VaultPlatformTransport(repositories.platformTransportKeys, () => Promise.resolve(vault))
	const deps: DevSandboxDeps = {
		repositories,
		provider: { devSandboxes: host },
		vault: () => Promise.resolve(vault),
		platformTransport: transport,
		namespaceProxyChanged: (namespaceId) => {
			republished.push(namespaceId)
			return Promise.resolve()
		},
	}
	const signals = new DevSignals()
	const dev = (auth = oauthUser(AUTHOR_ACTIONS), sandboxes = deps): DevUseCaseContext => ({
		...seeded.context({
			...auth,
			audit: (entry) => {
				audits.push(JSON.stringify(entry))
				return Promise.resolve()
			},
		}),
		devSandboxRemoval: devSandboxRemoval(sandboxes),
		dev: { signals, sandboxes, now: () => Math.floor(Date.now() / 1000) },
	})
	const receiver = (): DevReceiverDeps => ({
		keys: repositories.platformTransportKeys,
		devSandboxes: repositories.devSandboxes,
		sourceTarget: () => Promise.resolve({ connectionId: 'conn-acme', installationId: 45, owner: 'acme', repository: 'shop' }),
		source: seeded.source,
		signals,
		now: () => Math.floor(Date.now() / 1000),
		waitMs: 2_000,
		run: (runId) => repositories.runs.getRun(runId),
	})
	const workspace = async (title: string) => (await createWorkspaceUseCase(dev(), { appId: 'shop', env: 'stage', title })).id
	return { ...seeded, harness: opened, vault, host, deps, signals, transport, republished, audits, dev, receiver, workspace }
}

async function succeed(w: World, runId: string | undefined): Promise<void> {
	await w.harness.d1.prepare("UPDATE runs SET status = 'succeeded', finished_at = ? WHERE id = ?").bind(Math.floor(Date.now() / 1000), runId ?? '')
		.run()
}

/** The workspace's own source key, as its bootstrap hands it to the launcher. */
function sourceKey(w: World, workspaceId: string): Promise<string> {
	return w.transport.issue('shop', 'dev', 'source', { workspaceId })
}

function receiverRequest(kind: 'wait' | 'report', body: string, key: string): Request {
	return new Request(`https://control.example/platform/source/${kind}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body,
	})
}

async function wait(w: World, key: string, body: { bootstrap: string; head: string; reset: number | null; checks: number | null; hold: boolean }) {
	const response = await acceptDevWait(w.receiver(), receiverRequest('wait', encodeDevWaitRequest(body), key))
	return { status: response.status, answer: response.ok ? answerOf(await response.json()) : null }
}

function report(w: World, key: string, fields: Partial<DevReport> & { bootstrap: string; head: string; status: DevReport['status'] }) {
	const body = encodeDevReport({ target: null, message: null, log: [], reset: 0, checks: null, ...fields })
	return acceptDevReport(w.receiver(), receiverRequest('report', body, key))
}

function answerOf(json: unknown): DevWaitAnswer {
	const parsed = parseDevWaitAnswer(json)
	if (!parsed.ok) throw new Error('the receiver answered a body the launcher does not read')
	return parsed.value
}

const status = (w: World, workspaceId: string) => getDevStatusUseCase(w.dev(), { workspaceId, log: { lines: 10, failuresOnly: false } })

/** A workspace bound at `head`, its bootstrap succeeded and its launcher serving it. */
async function serving(w: World, title: string, head: string): Promise<{ workspaceId: string; key: string }> {
	const workspaceId = await w.workspace(title)
	w.source.branches.set(`fabrika/${workspaceId}`, head)
	await succeed(w, (await bindDevUseCase(w.dev(), { workspaceId })).bootstrapRun?.id)
	const key = await sourceKey(w, workspaceId)
	expect((await report(w, key, { bootstrap: head, head, status: 'serving' })).status).toBe(204)
	return { workspaceId, key }
}

const credentialsOf = async (w: World): Promise<string[]> => [
	...w.host.keys,
	...await Promise.all(
		(await w.repositories.devSandboxes.listStale(Number.MAX_SAFE_INTEGER)).map(async (row) =>
			row.proxy_secret_ref === null ? '' : await w.vault.getSecret(row.proxy_secret_ref)
		),
	),
]

describe('dev sandboxes', () => {
	test('a dev environment with workspace sandboxes is registered only with a wildcard domain', async () => {
		const w = await world()
		const provider: ControlProvider = { ...zeropsProvider, devSandboxes: w.host }
		const put = (env: string, extra: object) =>
			putAppEnvUseCase(registryContext(w.repositories, provider), 'shop', env, { ...zeropsEnvelopes(), kind: 'dev', ...extra })
				.then(() => null, (cause: unknown) => cause instanceof ControlApiError ? cause.message : 'unexpected')
		await w.repositories.registry.deleteAppEnv('shop', 'dev', (await w.repositories.registry.getAppEnv('shop', 'dev'))?.generation ?? 0)
		expect(await put('dev', {})).toContain('it needs a domain: the wildcard base')
		expect(await put('dev', { domain: 'dev.example.com' })).toBeNull()
	})

	test('a dev environment, or its app, is not deleted while a workspace sandbox is left; once removed, it is', async () => {
		const w = await world()
		const { workspaceId } = await serving(w, 'Kept', sha('b'))
		const registry = registryContext(w.repositories, { ...zeropsProvider, devSandboxes: w.host })
		const refusal = (cause: unknown) => cause instanceof ControlApiError ? [cause.httpStatus, cause.message] : null
		const deletingEnv = refusal(await deleteAppEnvUseCase(registry, 'shop', 'dev').catch((cause: unknown) => cause))
		expect(deletingEnv?.[0]).toBe(409)
		expect(String(deletingEnv?.[1])).toContain(`dev environment shop/dev still has 1 workspace sandbox(es) (workspaces ${workspaceId})`)
		expect(refusal(await deleteAppUseCase(registry, 'shop').catch((cause: unknown) => cause))?.[0]).toBe(409)
		expect(await w.repositories.registry.getAppEnv('shop', 'dev')).not.toBeNull()
		expect((await w.repositories.devSandboxes.get(workspaceId))?.state).toBe('ready')
		expect(w.host.calls.filter((call) => call.startsWith('remove'))).toEqual([])

		await abandonWorkspaceUseCase(w.dev(), { workspaceId })
		expect(await deleteAppEnvUseCase(registry, 'shop', 'dev')).toEqual({ ok: true })
		expect(await w.repositories.registry.getAppEnv('shop', 'dev')).toBeNull()
	})

	test('two workspaces of one app each get their own sandbox, run lane, key, signals and status', async () => {
		const w = await world()
		const first = await w.workspace('First')
		const second = await w.workspace('Second')
		w.source.branches.set(`fabrika/${first}`, sha('b'))
		w.source.branches.set(`fabrika/${second}`, sha('c'))
		const [a, b] = await Promise.all([
			bindDevUseCase(w.dev(), { workspaceId: first }),
			bindDevUseCase(w.dev(), { workspaceId: second }),
		])
		expect([...w.host.calls].sort()).toEqual([`ensure ${first}`, `ensure ${second}`, `wake sbx-${first}`, `wake sbx-${second}`].sort())
		expect({ state: a.state, url: a.url, workspaceId: a.workspaceId, yours: a.yours }).toEqual({
			state: 'bootstrapping',
			url: `https://${first}.${DOMAIN}`,
			workspaceId: first,
			yours: true,
		})
		expect(b.url).toBe(`https://${second}.${DOMAIN}`)
		expect((await w.repositories.runs.getRun(a.bootstrapRun?.id ?? ''))?.lane).toBe(first)
		expect((await w.repositories.runs.getRun(b.bootstrapRun?.id ?? ''))?.lane).toBe(second)
		const rows = new Map((await w.repositories.devSandboxes.listByEnvironment('shop', 'dev')).map((row) => [row.workspace_id, row]))
		const sandboxOf = (workspaceId: string) => {
			const row = rows.get(workspaceId)
			return [row?.state, row?.sandbox_id, row?.target_sha]
		}
		expect(sandboxOf(first)).toEqual(['ready', `sbx-${first}`, sha('b')])
		expect(sandboxOf(second)).toEqual(['ready', `sbx-${second}`, sha('c')])
		expect(rows.get(first)?.proxy_secret_ref).not.toBe(rows.get(second)?.proxy_secret_ref)

		await succeed(w, a.bootstrapRun?.id)
		await succeed(w, b.bootstrapRun?.id)
		const firstKey = await sourceKey(w, first)
		const secondKey = await sourceKey(w, second)
		expect(firstKey).not.toBe(secondKey)
		// Each launcher reads its own record: the first adopts generations, the second is told its own head.
		expect(await wait(w, firstKey, { bootstrap: sha('b'), head: sha('b'), reset: null, checks: null, hold: false })).toEqual({
			status: 200,
			answer: { sync: null, reset: 0, checks: 0 },
		})
		expect((await report(w, secondKey, { bootstrap: sha('c'), head: sha('c'), status: 'serving' })).status).toBe(204)
		expect((await status(w, second)).state).toBe('serving')
		expect((await status(w, first)).state).toBe('pending')

		// A commit to the first workspace wakes only the first launcher.
		const held = wait(w, firstKey, { bootstrap: sha('b'), head: sha('b'), reset: 0, checks: 0, hold: true })
		const other = wait(w, secondKey, { bootstrap: sha('c'), head: sha('c'), reset: 0, checks: 0, hold: true })
		await Bun.sleep(50)
		const written = [{ path: 'src/a.ts', content: 'export {}\n' }]
		const applied = followDevCommit(w.dev(), { workspaceId: first, commitSha: sha('d'), parentSha: sha('b'), written })
		expect((await held).answer?.sync).toEqual({ from: sha('b'), to: sha('d'), files: written })
		expect((await report(w, firstKey, { bootstrap: sha('b'), head: sha('d'), status: 'serving' })).status).toBe(204)
		expect(await applied).toEqual(expect.objectContaining({ head: sha('d'), state: 'serving', url: `https://${first}.${DOMAIN}` }))
		expect((await other).answer).toEqual({ sync: null, reset: 0, checks: 0 })
		expect((await w.repositories.devSandboxes.get(second))?.target_sha).toBe(sha('c'))

		// run_checks and reset_dev advance the first sandbox's generations only.
		const resetting = resetDevUseCase(w.dev(), { workspaceId: first })
		expect((await wait(w, firstKey, { bootstrap: sha('b'), head: sha('d'), reset: 0, checks: 0, hold: true })).answer?.reset).toBe(1)
		await report(w, firstKey, { bootstrap: sha('b'), head: sha('d'), status: 'serving', reset: 1 })
		expect((await resetting).state).toBe('serving')
		expect((await w.repositories.devSandboxes.get(second))?.reset_generation).toBe(0)
		const checking = runChecksUseCase(w.dev(), { workspaceId: second })
		const results = [{ name: 'tsc', ok: true, exitCode: 0, durationMs: 10, output: [] }]
		expect((await wait(w, secondKey, { bootstrap: sha('c'), head: sha('c'), reset: 0, checks: 0, hold: true })).answer?.checks).toBe(1)
		await report(w, secondKey, { bootstrap: sha('c'), head: sha('c'), status: 'serving', checks: { request: 1, head: sha('c'), results } })
		expect((await checking).checks).toEqual({ request: 1, head: sha('c'), results })
		expect((await w.repositories.devSandboxes.get(first))?.checks_generation).toBe(0)

		// A re-bind of a served head reuses the sandbox and bootstraps nothing.
		w.source.branches.set(`fabrika/${first}`, sha('d'))
		const again = await bindDevUseCase(w.dev(), { workspaceId: first })
		expect(again.bootstrapRun?.id).toBe(a.bootstrapRun?.id)
		expect((await w.repositories.devSandboxes.get(first))?.sandbox_id).toBe(`sbx-${first}`)
		expect(w.republished).toEqual([])

		// list_targets names the caller's own most recently active sandbox.
		const [target] = (await listDevTargetsUseCase(w.dev())).items
		expect(target?.dev).toEqual(expect.objectContaining({ state: 'serving', workspaceId: first, yours: true, url: `https://${first}.${DOMAIN}` }))
		const [theirs] = (await listDevTargetsUseCase(w.dev(oauthUser(AUTHOR_ACTIONS, 'stranger@acme.test')))).items
		expect(theirs?.dev).toEqual(expect.objectContaining({ state: 'unbound', workspaceId: null, url: null }))

		for (const credential of [...await credentialsOf(w), firstKey, secondKey]) {
			expect(printed.join('\n')).not.toContain(credential)
			expect(w.audits.join('\n')).not.toContain(credential)
		}
	})

	test('a full sandbox host is a 503 the author can act on, and the sealed proxy secret is not kept', async () => {
		const w = await world()
		const workspaceId = await w.workspace('Full')
		w.source.branches.set(`fabrika/${workspaceId}`, sha('b'))
		w.host.full = true
		const refused = await bindDevUseCase(w.dev(), { workspaceId }).catch((cause: unknown) => cause)
		expect(refused).toBeInstanceOf(ControlApiError)
		expect(refused instanceof ControlApiError ? [refused.httpStatus, refused.message] : null).toEqual([503, DEV_SANDBOX_CAPACITY])
		expect((await w.repositories.devSandboxes.get(workspaceId))?.proxy_secret_ref).toBeNull()
		const labels = await w.harness.d1.prepare('SELECT label FROM vault').all<{ label: string }>()
		expect(labels.results.map((row) => row.label).filter((label) => label.includes(workspaceId))).toEqual([])
		expect(w.queued).toHaveLength(0)

		w.host.full = false
		expect((await bindDevUseCase(w.dev(), { workspaceId })).state).toBe('bootstrapping')
	})

	test("the first bind of a namespace republishes it, which creates the sandbox host, and then creates the workspace's sandbox", async () => {
		const w = await world()
		const workspaceId = await w.workspace('First')
		w.source.branches.set(`fabrika/${workspaceId}`, sha('b'))
		w.host.hostPending = true
		const deps: DevSandboxDeps = {
			...w.deps,
			namespaceProxyChanged: (namespaceId) => {
				w.republished.push(namespaceId)
				w.host.hostPending = false
				return Promise.resolve()
			},
		}
		expect((await bindDevUseCase(w.dev(undefined, deps), { workspaceId })).state).toBe('bootstrapping')
		expect(w.republished).toEqual([NAMESPACE])
		expect(w.host.calls).toEqual([`ensure ${workspaceId}`, `ensure ${workspaceId}`, `wake sbx-${workspaceId}`])
		expect((await w.repositories.devSandboxes.get(workspaceId))?.sandbox_id).toBe(`sbx-${workspaceId}`)
	})

	test('a busy namespace while its sandbox host is created is a 503 to retry, and the sealed proxy secret is not kept', async () => {
		const w = await world()
		const workspaceId = await w.workspace('Busy')
		w.source.branches.set(`fabrika/${workspaceId}`, sha('b'))
		w.host.hostPending = true
		const deps: DevSandboxDeps = {
			...w.deps,
			namespaceProxyChanged: () => Promise.reject(new NamespaceProxyBusyError(`Namespace ${NAMESPACE} proxy is busy; a reconcile is queued`)),
		}
		const refused = await bindDevUseCase(w.dev(undefined, deps), { workspaceId }).catch((cause: unknown) => cause)
		expect(refused instanceof ControlApiError ? [refused.httpStatus, refused.message] : refused).toEqual([503, DEV_SANDBOX_HOST_PENDING])
		const labels = await w.harness.d1.prepare('SELECT label FROM vault').all<{ label: string }>()
		expect(labels.results.map((row) => row.label).filter((label) => label.includes(workspaceId))).toEqual([])
		expect(w.queued).toHaveLength(0)
	})

	test('maintenance parks an idle sandbox; a commit wakes it, and bind_dev wakes it and waits for its launcher', async () => {
		const w = await world()
		const { workspaceId, key } = await serving(w, 'Idle', sha('b'))
		const now = Math.floor(Date.now() / 1000)
		expect(await maintainDevSandboxes(w.deps, now)).toEqual({ parked: 0, removed: 0, failed: 0 })
		expect(await maintainDevSandboxes(w.deps, now + DEV_IDLE_STOP_SECONDS + 60)).toEqual({ parked: 1, removed: 0, failed: 0 })
		expect(w.host.calls).toEqual([`ensure ${workspaceId}`, `wake sbx-${workspaceId}`, `park sbx-${workspaceId}`])
		const parked = await status(w, workspaceId)
		expect({ state: parked.state, summary: parked.summary }).toEqual({
			state: 'stopped',
			summary: 'Parked after an idle period; the next apply_changes or bind_dev wakes it.',
		})

		const following = followDevCommit(w.dev(), { workspaceId, commitSha: sha('c'), parentSha: sha('b'), written: [] })
		await Bun.sleep(50)
		await report(w, key, { bootstrap: sha('b'), head: sha('c'), status: 'serving' })
		expect((await following)?.state).toBe('serving')
		expect(w.host.calls.at(-1)).toBe(`wake sbx-${workspaceId}`)
		expect((await w.repositories.devSandboxes.get(workspaceId))?.parked_at).toBeNull()

		// A failed park keeps the mark, so it is not retried every pass; a launcher that still talks clears it.
		const failing = spyOn(w.host, 'park').mockRejectedValue(new Error('box answered 500'))
		expect(await maintainDevSandboxes(w.deps, now + 2 * DEV_IDLE_STOP_SECONDS)).toEqual({ parked: 0, removed: 0, failed: 1 })
		expect(await maintainDevSandboxes(w.deps, now + 2 * DEV_IDLE_STOP_SECONDS)).toEqual({ parked: 0, removed: 0, failed: 0 })
		failing.mockRestore()
		expect((await wait(w, key, { bootstrap: sha('b'), head: sha('c'), reset: 0, checks: 0, hold: false })).status).toBe(200)
		expect((await w.repositories.devSandboxes.get(workspaceId))?.parked_at).toBeNull()

		await Bun.sleep(1_000)
		expect((await maintainDevSandboxes(w.deps, now + 3 * DEV_IDLE_STOP_SECONDS)).parked).toBe(1)
		w.source.branches.set(`fabrika/${workspaceId}`, sha('c'))
		const binding = bindDevUseCase(w.dev(), { workspaceId })
		await Bun.sleep(100)
		expect((await wait(w, key, { bootstrap: sha('b'), head: sha('c'), reset: 0, checks: 0, hold: false })).status).toBe(200)
		const bound = await binding
		expect(bound.state).toBe('serving')
		expect(w.queued).toHaveLength(1)
	})

	test('maintenance removes a sandbox idle for 14 days, and retries one left removing; the workspace stays', async () => {
		const w = await world()
		const stale = await serving(w, 'Stale', sha('b'))
		const kept = await serving(w, 'Kept', sha('c'))
		const now = Math.floor(Date.now() / 1000)
		await w.harness.d1.prepare('UPDATE dev_sandboxes SET activity_at = ? WHERE workspace_id = ?').bind(
			now - DEV_SANDBOX_STALE_SECONDS - 60,
			stale.workspaceId,
		).run()
		const secretRef = (await w.repositories.devSandboxes.get(stale.workspaceId))?.proxy_secret_ref ?? ''

		w.host.failRemove = true
		expect(await maintainDevSandboxes(w.deps, now)).toEqual({ parked: 0, removed: 0, failed: 1 })
		expect((await w.repositories.devSandboxes.get(stale.workspaceId))?.state).toBe('removing')
		// Box failed, yet the launcher's key is revoked and the proxy republished; the secret stays for the retry.
		expect(await w.repositories.platformTransportKeys.findValidByHash(await hashPlatformKey(stale.key), now)).toBeNull()
		expect(w.republished).toEqual([NAMESPACE])
		expect(await w.vault.getSecret(secretRef).then(() => 'kept', () => 'deleted')).toBe('kept')
		// Marked `removing` is retried whatever its age.
		await w.harness.d1.prepare('UPDATE dev_sandboxes SET activity_at = ? WHERE workspace_id = ?').bind(now, stale.workspaceId).run()
		w.host.failRemove = false
		expect(await maintainDevSandboxes(w.deps, now)).toEqual({ parked: 0, removed: 1, failed: 0 })

		expect(await w.repositories.devSandboxes.get(stale.workspaceId)).toBeNull()
		expect([...w.host.held.values()]).toEqual([`sbx-${kept.workspaceId}`])
		expect(await w.repositories.platformTransportKeys.findValidByHash(await hashPlatformKey(stale.key), now)).toBeNull()
		expect(await w.repositories.platformTransportKeys.findValidByHash(await hashPlatformKey(kept.key), now)).not.toBeNull()
		expect(await w.vault.getSecret(secretRef).then(() => 'kept', () => 'deleted')).toBe('deleted')
		expect(w.republished).toEqual([NAMESPACE, NAMESPACE])
		expect((await w.repositories.workspaces.getWorkspace(stale.workspaceId))?.abandoned_at).toBeNull()
		expect((await status(w, stale.workspaceId)).state).toBe('unbound')
		// Its launcher's key is gone with it.
		expect((await wait(w, stale.key, { bootstrap: sha('b'), head: sha('b'), reset: 0, checks: 0, hold: false })).status).toBe(401)
	})

	test('abandoning a workspace removes its sandbox, revokes its key, drops its secret and republishes the proxy', async () => {
		const w = await world()
		const { workspaceId, key } = await serving(w, 'Gone', sha('b'))
		const other = await serving(w, 'Other', sha('c'))
		const secretRef = (await w.repositories.devSandboxes.get(workspaceId))?.proxy_secret_ref ?? ''
		const credentials = [...await credentialsOf(w), key]

		expect(await abandonWorkspaceUseCase(w.dev(), { workspaceId })).toEqual({ workspaceId, branchDeleted: true })
		expect(w.host.calls.at(-1)).toBe(`remove sbx-${workspaceId}`)
		expect(await w.repositories.devSandboxes.get(workspaceId)).toBeNull()
		expect(await w.repositories.devSandboxes.get(other.workspaceId)).not.toBeNull()
		expect(await w.repositories.platformTransportKeys.findValidByHash(await hashPlatformKey(key), Math.floor(Date.now() / 1000))).toBeNull()
		expect(await w.vault.getSecret(secretRef).then(() => 'kept', () => 'deleted')).toBe('deleted')
		expect(w.republished).toEqual([NAMESPACE])
		expect((await w.repositories.workspaces.getWorkspace(workspaceId))?.abandoned_at).not.toBeNull()

		// A failed removal still abandons the workspace; the sandbox is left `removing` for maintenance.
		const failing = await serving(w, 'Failing', sha('d'))
		w.host.failRemove = true
		const failingSecret = (await w.repositories.devSandboxes.get(failing.workspaceId))?.proxy_secret_ref ?? ''
		await abandonWorkspaceUseCase(w.dev(), { workspaceId: failing.workspaceId })
		expect((await w.repositories.devSandboxes.get(failing.workspaceId))?.state).toBe('removing')
		expect((await w.repositories.workspaces.getWorkspace(failing.workspaceId))?.abandoned_at).not.toBeNull()
		// Routing stops anyway: the key is revoked and the proxy republished without it; the secret waits for the retry.
		expect(await w.repositories.platformTransportKeys.findValidByHash(await hashPlatformKey(failing.key), Math.floor(Date.now() / 1000))).toBeNull()
		expect(w.republished).toEqual([NAMESPACE, NAMESPACE])
		expect(await w.vault.getSecret(failingSecret).then(() => 'kept', () => 'deleted')).toBe('kept')

		for (const credential of credentials) {
			expect(printed.join('\n')).not.toContain(credential)
			expect(w.audits.join('\n')).not.toContain(credential)
		}
	})

	test('abandoning a workspace with a sandbox needs the vault', async () => {
		const w = await world()
		const { workspaceId } = await serving(w, 'Vaultless', sha('b'))
		const { vault: _vault, ...vaultless } = w.deps
		const refused = await abandonWorkspaceUseCase(w.dev(undefined, vaultless), { workspaceId }).catch((cause: unknown) => cause)
		expect(refused instanceof ControlApiError ? [refused.httpStatus, refused.message] : null).toEqual([503, DEV_SANDBOX_VAULT_REQUIRED])
		expect((await w.repositories.devSandboxes.get(workspaceId))?.state).toBe('ready')
		expect((await w.repositories.workspaces.getWorkspace(workspaceId))?.abandoned_at).toBeNull()
		// Refused before anything changed: the branch is still there.
		expect(w.source.branches.has(`fabrika/${workspaceId}`)).toBe(true)
		// A workspace without a sandbox abandons without one.
		const plain = await w.workspace('Plain')
		expect((await abandonWorkspaceUseCase(w.dev(undefined, vaultless), { workspaceId: plain })).workspaceId).toBe(plain)
	})

	test('the receiver refuses a key without a workspace, and a key of one workspace reaches only that one', async () => {
		const w = await world()
		const first = await serving(w, 'First', sha('b'))
		const second = await serving(w, 'Second', sha('c'))
		await w.repositories.platformTransportKeys.insert({
			app_id: 'shop',
			env: 'dev',
			receiver: 'source',
			key_id: 'environment-key',
			key_hash: await hashPlatformKey('px_environment-key'),
			value_ref: 'vault:unused',
			expires_at: Math.floor(Date.now() / 1000) + 3600,
			created_at: Math.floor(Date.now() / 1000),
		})
		expect((await wait(w, 'px_environment-key', { bootstrap: sha('b'), head: sha('b'), reset: 0, checks: 0, hold: false })).status).toBe(401)
		// A key that names a workspace of another environment.
		await w.repositories.platformTransportKeys.insert({
			app_id: 'shop',
			env: 'stage',
			receiver: 'source',
			key_id: 'foreign-key',
			key_hash: await hashPlatformKey('px_foreign-key'),
			value_ref: 'vault:unused',
			expires_at: Math.floor(Date.now() / 1000) + 3600,
			created_at: Math.floor(Date.now() / 1000),
			workspace_id: first.workspaceId,
		})
		expect((await wait(w, 'px_foreign-key', { bootstrap: sha('b'), head: sha('b'), reset: 0, checks: 0, hold: false })).status).toBe(401)

		// The second workspace's launcher, claiming the first one's bootstrap, is superseded by its own record.
		expect((await report(w, second.key, { bootstrap: sha('b'), head: sha('b'), status: 'failed', message: 'boom' })).status).toBe(409)
		expect((await w.repositories.devSandboxes.get(first.workspaceId))?.status).toBe('serving')
		expect((await w.repositories.devSandboxes.get(second.workspaceId))?.head_sha).toBe(sha('c'))
		// A report with the first workspace's own key records on the first only.
		expect((await report(w, first.key, { bootstrap: sha('b'), head: sha('b'), status: 'failed', message: 'boom' })).status).toBe(204)
		expect((await status(w, first.workspaceId)).state).toBe('failed')
		expect((await status(w, second.workspaceId)).state).toBe('serving')
	})

	test("get_dev_status says when IAM holds another workspace's contract, and bind_dev bootstraps to refresh it", async () => {
		const w = await world()
		const { workspaceId } = await serving(w, 'Digest', sha('b'))
		const snapshot = JSON.stringify({ version: 1, contract: notesArtifact, migrations: [], checker: '0.9.0' })
		const runId = (await w.repositories.devSandboxes.get(workspaceId))?.bootstrap_run_id ?? ''
		await w.harness.d1.prepare('UPDATE runs SET snapshot_json = ? WHERE id = ?').bind(snapshot, runId).run()
		await w.repositories.devSandboxes.recordPublishedRun(workspaceId, runId)
		const digest = approvedAccess(parseSnapshot(snapshot))?.contractDigest ?? ''

		await w.repositories.registry.recordAppEnvIamDigest('shop', 'dev', digest)
		expect((await status(w, workspaceId)).summary).toBe(`Serving ${sha('b')}.`)
		expect((await bindDevUseCase(w.dev(), { workspaceId })).bootstrapRun?.id).toBe(runId)

		await w.repositories.registry.recordAppEnvIamDigest('shop', 'dev', 'sha256:another-workspace')
		const differs = await status(w, workspaceId)
		expect(differs.state).toBe('serving')
		expect(differs.summary).toBe(
			`Serving ${sha('b')}. Roles and actions follow the most recently bootstrapped workspace, whose contract differs from this one's; `
				+ 'call bind_dev to refresh them.',
		)
		const rebound = await bindDevUseCase(w.dev(), { workspaceId })
		expect(rebound.bootstrapRun?.id).not.toBe(runId)
		expect(rebound.bootstrapRun?.commitSha).toBe(sha('b'))
	})
	test('a sandbox Box lost is created again by bind_dev, republished and bootstrapped; a commit or check asks for bind_dev', async () => {
		const w = await world()
		const { workspaceId } = await serving(w, 'Lost', sha('b'))
		const before = await w.repositories.devSandboxes.get(workspaceId)
		w.host.lose(workspaceId)

		const refused = await runChecksUseCase(w.dev(), { workspaceId }).catch((cause: unknown) => cause)
		expect(refused instanceof ControlApiError ? refused.httpStatus : null).toBe(503)
		expect(refused instanceof ControlApiError ? refused.message : '').toContain('call bind_dev, which replaces a sandbox that is gone')

		const rebound = await bindDevUseCase(w.dev(), { workspaceId })
		const after = await w.repositories.devSandboxes.get(workspaceId)
		expect({ sandbox: after?.sandbox_id, upstream: after?.upstream_host }).toEqual({
			sandbox: `sbx-${workspaceId}-again`,
			upstream: `3000-sbx-${workspaceId}-again.box.test`,
		})
		expect(after?.proxy_secret_ref).toBe(before?.proxy_secret_ref ?? '')
		expect(w.republished).toEqual([NAMESPACE])
		expect(rebound.state).toBe('bootstrapping')
		expect(rebound.bootstrapRun?.id).not.toBe(before?.bootstrap_run_id)
		expect(w.queued).toHaveLength(2)
	})

	test('maintenance does not retry parking a sandbox Box lost', async () => {
		const w = await world()
		const { workspaceId } = await serving(w, 'Lost', sha('b'))
		w.host.lose(workspaceId)
		const idle = Math.floor(Date.now() / 1000) + DEV_IDLE_STOP_SECONDS + 60
		expect(await maintainDevSandboxes(w.deps, idle)).toEqual({ parked: 0, removed: 0, failed: 1 })
		expect(await maintainDevSandboxes(w.deps, idle + 600)).toEqual({ parked: 0, removed: 0, failed: 0 })
		expect(w.host.calls.filter((call) => call.startsWith('park'))).toHaveLength(1)
	})

	test('a commit wakes the sandbox even when the record says it runs: a launcher request may have raced a park', async () => {
		const w = await world()
		const { workspaceId, key } = await serving(w, 'Raced', sha('b'))
		const calls = w.host.calls.length
		const following = followDevCommit(w.dev(), { workspaceId, commitSha: sha('c'), parentSha: sha('b'), written: [] })
		await Bun.sleep(50)
		await report(w, key, { bootstrap: sha('b'), head: sha('c'), status: 'serving' })
		expect((await following)?.state).toBe('serving')
		expect(w.host.calls.slice(calls)).toEqual([`wake sbx-${workspaceId}`])
	})

	test('two concurrent binds of one workspace keep one proxy secret', async () => {
		const w = await world()
		const workspaceId = await w.workspace('Twice')
		w.source.branches.set(`fabrika/${workspaceId}`, sha('b'))
		await Promise.all([bindDevUseCase(w.dev(), { workspaceId }), bindDevUseCase(w.dev(), { workspaceId })])
		const labels = (await w.harness.d1.prepare('SELECT id, label FROM vault').all<{ id: string; label: string }>()).results
		const sealed = labels.filter((row) => row.label.endsWith(`:${workspaceId}`) && row.label.includes('proxy'))
		expect(sealed).toHaveLength(1)
		expect((await w.repositories.devSandboxes.get(workspaceId))?.proxy_secret_ref).toBe(`vault:${sealed[0]?.id ?? ''}`)
	})

	test("a Box sandbox Control never recorded is removed by the workspace's name", async () => {
		const w = await world()
		const workspaceId = await w.workspace('Unrecorded')
		await w.repositories.devSandboxes.insertCreating({ workspaceId, appId: 'shop', env: 'dev', now: Math.floor(Date.now() / 1000) })
		w.host.held.set(workspaceId, 'sbx-unrecorded')
		await abandonWorkspaceUseCase(w.dev(), { workspaceId })
		expect(w.host.calls).toEqual([`remove workspace ${workspaceId}`])
		expect(w.host.held.size).toBe(0)
		expect(await w.repositories.devSandboxes.get(workspaceId)).toBeNull()
	})

	test('maintenance leaves a sandbox a bind made active, and removes one of an abandoned workspace; an abandoned workspace gets none', async () => {
		const w = await world()
		const active = await serving(w, 'Active', sha('b'))
		const abandoned = await serving(w, 'Abandoned', sha('c'))
		const now = Math.floor(Date.now() / 1000)
		// Listed as stale a moment ago, bound since: maintenance's conditional mark leaves it.
		expect(await removeDevSandbox(w.deps, active.workspaceId, AbortSignal.timeout(1_000), now - DEV_SANDBOX_STALE_SECONDS)).toBe('absent')
		expect((await w.repositories.devSandboxes.get(active.workspaceId))?.state).toBe('ready')

		// An abandon that raced a bind left a sandbox behind.
		await w.repositories.workspaces.markAbandoned(abandoned.workspaceId)
		expect(await maintainDevSandboxes(w.deps, now)).toEqual({ parked: 0, removed: 1, failed: 0 })
		expect(await w.repositories.devSandboxes.get(abandoned.workspaceId)).toBeNull()
		expect(await w.repositories.devSandboxes.get(active.workspaceId)).not.toBeNull()
		expect(await w.repositories.devSandboxes.insertCreating({ workspaceId: abandoned.workspaceId, appId: 'shop', env: 'dev', now })).toBeNull()
	})

	test('a sandbox Box finishes creating after the workspace was removed is removed too, and the bind says so', async () => {
		const w = await world()
		const workspaceId = await w.workspace('Raced')
		w.source.branches.set(`fabrika/${workspaceId}`, sha('b'))
		let created = (): void => {}
		w.host.creating = new Promise((resolve) => {
			created = resolve
		})
		const binding = bindDevUseCase(w.dev(), { workspaceId }).catch((cause: unknown) => cause)
		while (!w.host.calls.includes(`ensure ${workspaceId}`)) await Bun.sleep(1)
		await abandonWorkspaceUseCase(w.dev(), { workspaceId })
		expect(await w.repositories.devSandboxes.get(workspaceId)).toBeNull()
		created()
		const refused = await binding
		expect(refused instanceof ControlApiError ? refused.httpStatus : refused).toBe(409)
		expect(w.host.calls).toEqual([`ensure ${workspaceId}`, `remove workspace ${workspaceId}`, `remove sbx-${workspaceId}`])
		expect(w.host.held.size).toBe(0)
		const labels = await w.harness.d1.prepare('SELECT label FROM vault').all<{ label: string }>()
		expect(labels.results.map((row) => row.label).filter((label) => label.includes(workspaceId))).toEqual([])
	})

	test("a bind on a placement that cannot serve sandboxes is refused before its row exists, so the namespace's other members still publish", async () => {
		const w = await world()
		const workspaceId = await w.workspace('Unmarked')
		w.source.branches.set(`fabrika/${workspaceId}`, sha('b'))
		w.host.refusal = 'the proxy of deployment namespace `apps-dev` is pinned to a source that cannot serve dev sandboxes; re-pin it'
		const refused = await bindDevUseCase(w.dev(), { workspaceId }).catch((cause: unknown) => cause)
		expect(refused instanceof ControlApiError ? [refused.httpStatus, refused.message] : refused).toEqual([409, w.host.refusal])
		expect(await w.repositories.devSandboxes.get(workspaceId)).toBeNull()
		expect(w.host.calls).toEqual([])
		expect(w.republished).toEqual([])
		expect(await w.repositories.registry.getNamespaceSandboxKeyRef(NAMESPACE)).toBeNull()
	})
})
