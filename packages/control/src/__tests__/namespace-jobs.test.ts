// Namespace provisioning as a QUEUED job (backlog 74). The request used to run the whole provider
// mutation — minutes of project import, proxy build and subdomain publication — inside the HTTP call,
// so the caller always received a gateway timeout and the row was left `failed` whenever control's own
// wait was cut short, even though the provider had checkpointed real progress.
//
// What is proven here: the request answers before the provider is touched, the work finishes with
// nobody attached, and a redelivered message never re-runs finished work.

import type { AuthContext } from '@fabrika/auth'
import { SqlDeployLocks } from '@fabrika/platform'
import type { ControlProvider, ProviderDeploymentNamespace, ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { type NamespaceJobDeps, runNamespaceJob } from '../api/namespaces'
import type { ApiDeps } from '../api/router'
import { handleApi } from '../api/router'
import { decodeControlJobMessage, runControlJob } from '../consumer'
import type { Env } from '../env'
import { FakeRepoSource } from '../repo-source'
import type { ControlJobMessage, NamespaceJobMessage } from '../run-lifecycle'
import { createHarness, type Harness } from './helpers/harness'
import { makeFakeLock } from './helpers/lock'

const target = (phase: string): ProviderEnvelope => ({ provider: 'harbor', version: 1, payload: { phase } })

const withTarget = (namespace: ProviderDeploymentNamespace, nextTarget: ProviderEnvelope): ProviderDeploymentNamespace => ({
	id: namespace.id,
	env: namespace.env,
	...(namespace.exclusiveAppId === undefined ? {} : { exclusiveAppId: namespace.exclusiveAppId }),
	target: nextTarget,
})

interface Recording {
	provisions: string[]
	reconciles: string[]
	/** The signal each provider call received — a request's signal would be aborted by a lost caller. */
	signals: AbortSignal[]
	/** The target each provider call started from, so a resumed job can be told from a fresh one. */
	seen: ProviderEnvelope[]
	/** Held open to keep a mutation in flight while the test looks at the world around it. */
	gate: Promise<void> | null
	entered: () => void
	fail: boolean
}

function recording(): Recording {
	return { provisions: [], reconciles: [], signals: [], seen: [], gate: null, entered: () => {}, fail: false }
}

function namespacedProvider(record: Recording): ControlProvider {
	const run = async (
		input: { namespace: ProviderDeploymentNamespace; signal: AbortSignal; events: { checkpoint(n: ProviderDeploymentNamespace): Promise<void> } },
	): Promise<ProviderDeploymentNamespace> => {
		record.signals.push(input.signal)
		record.seen.push(input.namespace.target)
		record.entered()
		const checkpoint = withTarget(input.namespace, target('checkpoint'))
		await input.events.checkpoint(checkpoint)
		if (record.gate !== null) await record.gate
		if (record.fail) throw new Error('provider details must not escape')
		return withTarget(checkpoint, target('ready'))
	}
	return {
		id: 'harbor',
		normalizeRegistration: (input) => input,
		deploy: () => Promise.resolve({ state: 'succeeded' }),
		namespaces: {
			normalize: (namespace) => namespace,
			namespaceResourceClaims: () => ['service:proxy'],
			registrationResourceClaims: (registration) => [`service:${registration.app.id}`],
			provision(input) {
				record.provisions.push(input.namespace.id)
				return run(input)
			},
			reconcile(input) {
				record.reconciles.push(input.namespace.id)
				return run(input)
			},
		},
	}
}

const auth = (): AuthContext => ({
	ok: true,
	principal: { id: 'operator', type: 'user', label: 'operator@test' },
	can: () => true,
	scopedTo: () => null,
	audit: () => Promise.resolve(),
})

function apiDeps(harness: Harness, provider: ControlProvider, sent: ControlJobMessage[]): ApiDeps {
	return {
		repositories: harness.repositories,
		auth: auth(),
		queue: {
			send(message) {
				sent.push(message)
				return Promise.resolve()
			},
		},
		logs: { get: () => Promise.resolve(null) },
		repoSource: new FakeRepoSource(),
		provider,
		cancelRun: () => Promise.resolve(),
	}
}

/** The runtime bag `runControlJob` composes from — enough of it for a job that never assembles a deploy. */
function jobEnv(harness: Harness, sent: ControlJobMessage[]): Env {
	return {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: {
			send(message) {
				sent.push(message)
				return Promise.resolve()
			},
		},
		WAIT_UNTIL: () => {},
		REPO_EVENTS: new FakeRepoSource(),
		ENVIRONMENT: 'local',
	}
}

function jobDeps(harness: Harness, provider: ControlProvider): NamespaceJobDeps {
	return { repositories: harness.repositories, provider, lock: makeFakeLock() }
}

const provisionJob = (namespaceId: string): NamespaceJobMessage => ({ kind: 'namespace', namespaceId, mutation: 'provision' })

/** Round-trip the message through the wire so the decode boundary is part of every dispatch here. */
function decoded(message: ControlJobMessage): NamespaceJobMessage {
	const parsed: unknown = JSON.parse(JSON.stringify(message))
	const control = decodeControlJobMessage(parsed)
	if (control.kind !== 'namespace') throw new Error('expected a namespace job')
	return control
}

const createRequest = (signal: AbortSignal): Request =>
	new Request('https://control.test/api/namespaces', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id: 'apps-prod', env: 'prod', target: target('requested') }),
		signal,
	})

describe('namespace provisioning outlives the request that asked for it', () => {
	test('create answers while provisioning is still running, and finishes with no caller attached', async () => {
		const record = recording()
		let release = (): void => {}
		record.gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let entered = (): void => {}
		const provisionEntered = new Promise<void>((resolve) => {
			entered = resolve
		})
		record.entered = entered
		const harness = createHarness()
		const provider = namespacedProvider(record)
		const sent: ControlJobMessage[] = []
		const deps = apiDeps(harness, provider, sent)
		const caller = new AbortController()

		const created = await handleApi(createRequest(caller.signal), deps)

		// Answered inside the request, with the provider not yet asked for anything.
		expect(created.status).toBe(201)
		const body: { id: string; state: string } = await created.json()
		expect(body).toEqual(expect.objectContaining({ id: 'apps-prod', state: 'pending' }))
		expect(record.provisions).toEqual([])
		expect(sent).toEqual([provisionJob('apps-prod')])

		// The caller goes away: the tab closes, the CLI is killed, the balancer gives up.
		caller.abort()

		const job = runNamespaceJob(jobDeps(harness, provider), decoded(sent[0] ?? provisionJob('apps-prod')))
		await provisionEntered
		expect((await harness.repositories.registry.getDeploymentNamespace('apps-prod'))?.state).toBe('provisioning')
		release()

		expect(await job).toEqual({ namespaceId: 'apps-prod', status: 'ready' })
		// The worker owns the signal, so a lost caller cannot cancel the mutation it started.
		expect(record.signals[0]?.aborted).toBe(false)
		const row = await harness.repositories.registry.getDeploymentNamespace('apps-prod')
		expect(row?.state).toBe('ready')
		expect(row?.last_error).toBeNull()
		expect(JSON.parse(row?.provider_target_json ?? '{}')).toEqual(target('ready'))
	})

	test('a redelivered job never re-runs a namespace that already settled', async () => {
		const record = recording()
		const harness = createHarness()
		const provider = namespacedProvider(record)
		const deps = jobDeps(harness, provider)
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('requested')),
		})

		expect(await runNamespaceJob(deps, provisionJob('apps-prod'))).toEqual({ namespaceId: 'apps-prod', status: 'ready' })
		expect(await runNamespaceJob(deps, provisionJob('apps-prod'))).toEqual({ namespaceId: 'apps-prod', status: 'skipped' })

		expect(record.provisions).toEqual(['apps-prod'])
	})

	test('a job for a failed, foreign, or vanished namespace is a no-op', async () => {
		const record = recording()
		const harness = createHarness()
		const deps = jobDeps(harness, namespacedProvider(record))
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'failed-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('checkpoint')),
			state: 'failed',
			lastError: 'namespace provision failed',
		})
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'foreign-prod',
			env: 'prod',
			provider: 'other',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
		})

		expect(await runNamespaceJob(deps, provisionJob('failed-prod'))).toEqual({ namespaceId: 'failed-prod', status: 'skipped' })
		expect(await runNamespaceJob(deps, provisionJob('foreign-prod'))).toEqual({ namespaceId: 'foreign-prod', status: 'skipped' })
		expect(await runNamespaceJob(deps, provisionJob('missing'))).toEqual({ namespaceId: 'missing', status: 'skipped' })

		expect(record.provisions).toEqual([])
		// A failure stays a failure: only an explicit reconcile re-enqueues it.
		expect((await harness.repositories.registry.getDeploymentNamespace('failed-prod'))?.last_error).toBe('namespace provision failed')
	})

	test('a namespace left provisioning by a crashed worker resumes from its checkpoint', async () => {
		const record = recording()
		const harness = createHarness()
		const provider = namespacedProvider(record)
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('checkpoint')),
			state: 'provisioning',
		})

		expect(await runNamespaceJob(jobDeps(harness, provider), provisionJob('apps-prod'))).toEqual({
			namespaceId: 'apps-prod',
			status: 'ready',
		})

		// The provider is handed the CHECKPOINT, which is what lets it resume instead of starting over.
		expect(record.seen).toEqual([target('checkpoint')])
		expect((await harness.repositories.registry.getDeploymentNamespace('apps-prod'))?.state).toBe('ready')
	})

	test('a provider refusal is a handled job, recorded on the row rather than thrown', async () => {
		const record = recording()
		record.fail = true
		const harness = createHarness()
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('requested')),
		})

		expect(await runNamespaceJob(jobDeps(harness, namespacedProvider(record)), provisionJob('apps-prod'))).toEqual({
			namespaceId: 'apps-prod',
			status: 'failed',
		})

		const row = await harness.repositories.registry.getDeploymentNamespace('apps-prod')
		expect(row?.state).toBe('failed')
		expect(row?.last_error).toBe('namespace provision failed')
		expect(JSON.parse(row?.provider_target_json ?? '{}')).toEqual(target('checkpoint'))
	})

	test('a reconcile of a settling namespace only enqueues, and never rewrites the checkpoint', async () => {
		const record = recording()
		const harness = createHarness()
		const provider = namespacedProvider(record)
		const sent: ControlJobMessage[] = []
		const deps = apiDeps(harness, provider, sent)
		// The state a worker leaves behind mid-flight: `provisioning`, with a checkpoint the job just wrote.
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('checkpoint')),
			state: 'provisioning',
		})

		const response = await handleApi(new Request('https://control.test/api/namespaces/apps-prod/reconcile', { method: 'POST' }), deps)

		expect(response.status).toBe(200)
		const body: { state: string; target: ProviderEnvelope } = await response.json()
		expect(body.state).toBe('provisioning')
		// The request left the row alone: rewriting it here would roll back the in-flight job's checkpoint.
		const row = await harness.repositories.registry.getDeploymentNamespace('apps-prod')
		expect(row?.state).toBe('provisioning')
		expect(JSON.parse(row?.provider_target_json ?? '{}')).toEqual(target('checkpoint'))
		expect(body.target).toEqual(target('checkpoint'))
		expect(sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
	})

	test('a reconcile of a settled namespace re-queues it without touching its target', async () => {
		const record = recording()
		const harness = createHarness()
		const provider = namespacedProvider(record)
		const sent: ControlJobMessage[] = []
		const deps = apiDeps(harness, provider, sent)
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('ready')),
			state: 'failed',
			lastError: 'namespace provision failed',
		})

		const response = await handleApi(new Request('https://control.test/api/namespaces/apps-prod/reconcile', { method: 'POST' }), deps)

		expect(response.status).toBe(200)
		const row = await harness.repositories.registry.getDeploymentNamespace('apps-prod')
		expect(row?.state).toBe('pending')
		expect(row?.last_error).toBeNull()
		expect(JSON.parse(row?.provider_target_json ?? '{}')).toEqual(target('ready'))
		expect(sent).toEqual([{ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' }])
	})

	test('a namespace that settles between the first read and the lease is skipped', async () => {
		const record = recording()
		const harness = createHarness()
		const provider = namespacedProvider(record)
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('requested')),
		})
		const lock = makeFakeLock()
		const deps: NamespaceJobDeps = {
			repositories: harness.repositories,
			provider,
			lock: {
				async acquire(key, holder) {
					const acquired = await lock.acquire(key, holder)
					// Another worker finished this namespace while we were waiting for the lease.
					await harness.repositories.registry.updateDeploymentNamespace({
						id: 'apps-prod',
						providerTargetJson: JSON.stringify(target('ready')),
						state: 'ready',
						lastError: null,
					})
					return acquired
				},
				release: (key, holder) => lock.release(key, holder),
			},
		}

		expect(await runNamespaceJob(deps, provisionJob('apps-prod'))).toEqual({ namespaceId: 'apps-prod', status: 'skipped' })

		expect(record.provisions).toEqual([])
		// The lease is still released, so the namespace is not wedged for the next job.
		expect(lock.held.size).toBe(0)
	})

	test('a contended namespace defers and comes back as a fresh message', async () => {
		const record = recording()
		const harness = createHarness()
		const provider = namespacedProvider(record)
		const sent: ControlJobMessage[] = []
		const env = jobEnv(harness, sent)
		await harness.repositories.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify(target('requested')),
		})
		// Another worker holds the namespace's lease, in the real lock table under the real key.
		expect(await new SqlDeployLocks(harness.d1).acquire('namespace:apps-prod', 'other-worker', 60_000)).toBe(true)

		const result = await runControlJob(env, provider, provisionJob('apps-prod'))

		expect(result).toEqual({ kind: 'namespace', namespaceId: 'apps-prod', status: 'deferred' })
		expect(sent).toEqual([provisionJob('apps-prod')])
		expect(record.provisions).toEqual([])
		expect((await harness.repositories.registry.getDeploymentNamespace('apps-prod'))?.state).toBe('pending')
	})

	test('one queue, two kinds: a payload without a kind still takes the deploy path', async () => {
		const harness = createHarness()
		const sent: ControlJobMessage[] = []

		expect(decodeControlJobMessage({ runId: 'run-1' })).toEqual({ runId: 'run-1' })
		expect(decodeControlJobMessage({ runId: 'run-1', dryRun: true })).toEqual({ runId: 'run-1', dryRun: true })
		expect(decodeControlJobMessage({ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'reconcile' })).toEqual({
			kind: 'namespace',
			namespaceId: 'apps-prod',
			mutation: 'reconcile',
		})
		expect(() => decodeControlJobMessage({ kind: 'sweep' })).toThrow('unknown kind')
		expect(() => decodeControlJobMessage({ kind: 'namespace', mutation: 'provision' })).toThrow('no namespaceId')
		expect(() => decodeControlJobMessage({ kind: 'namespace', namespaceId: 'apps-prod' })).toThrow('no mutation')
		expect(() => decodeControlJobMessage({ kind: 'namespace', namespaceId: 'apps-prod', mutation: 'delete' })).toThrow('no mutation')

		expect(await runControlJob(jobEnv(harness, sent), namespacedProvider(recording()), { runId: 'missing' })).toEqual({
			kind: 'deploy',
			runId: 'missing',
			status: 'skipped',
		})
	})
})
