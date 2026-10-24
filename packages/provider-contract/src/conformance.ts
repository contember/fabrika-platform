// The cases every `ControlProvider` passes, whatever cloud it deploys to. A provider's own test file calls
// `describeControlProviderConformance` once with a harness over its fake cloud: the harness builds the provider and a
// deploy its cloud accepts, and reports what the cloud was asked to change and to stop.

import { describe, expect, test } from 'bun:test'
import {
	type ControlProvider,
	type ProviderDeployInput,
	type ProviderDeployOutcome,
	ProviderInvocationAbort,
	type ProviderRunEvents,
} from './control'
import type { JsonValue } from './json'

/** What the suite hands a fake cloud: `accepted` is called once the cloud has taken the deploy's operation. */
export interface ConformanceCloudHooks {
	accepted(): void
}

/** One provider over one fresh fake cloud. */
export interface ConformanceCloud {
	readonly provider: ControlProvider
	/** A deploy the fake cloud accepts and lets succeed. Each case sets `dryRun`, `signal` and `events` itself. */
	readonly input: Omit<ProviderDeployInput, 'dryRun' | 'signal' | 'events'>
	/** The credentials the provider holds itself (a cloud token, a signed URL); no event may carry one. */
	readonly credentials: readonly string[]
	/** Every request that changed the cloud: a write, a created resource, started work. A preview the cloud runs is none. */
	mutations(): readonly string[]
	/** Every request to stop or remove the deploy's work: a cancelled build or job, a deleted version. */
	stops(): readonly string[]
}

export interface ControlProviderConformanceHarness {
	/** Called once per case, and once per event in the lease-loss sweep. */
	create(hooks: ConformanceCloudHooks): ConformanceCloud
}

/** A secret the suite adds to every deploy; no event may carry it. */
const SECRET_NAME = 'CONFORMANCE_SECRET'
const SECRET_VALUE = 'conformance-secret-value-7f3a9c'

/** What a deploy reported through its events, as Control would have persisted it. */
interface Recorded {
	readonly logs: string[]
	readonly externalIds: Array<{ readonly id: string; readonly state?: JsonValue }>
	readonly checkpoints: JsonValue[]
	/** Events that hold the lease: `boundary`, `externalId` and `checkpoint`, in order. */
	events: number
	/** A state Control could not store as given; collected, because a provider may swallow what an event throws. */
	readonly violations: string[]
}

interface Invocation {
	readonly input: ProviderDeployInput
	readonly recorded: Recorded
	/** Lose the lease as Control does: the signal aborts, and every later event rejects with the same reason. */
	loseLease(): void
	readonly signal: AbortSignal
}

const LEASE_LOST = new ProviderInvocationAbort('lease_lost')

/** `lostAt`: the lease goes at this event (1-based), which rejects like every one after it. */
function invocation(cloud: ConformanceCloud, dryRun: boolean, options: { readonly lostAt?: number } = {}): Invocation {
	const controller = new AbortController()
	const recorded: Recorded = { logs: [], externalIds: [], checkpoints: [], events: 0, violations: [] }
	const loseLease = (): void => {
		if (!controller.signal.aborted) controller.abort(LEASE_LOST)
	}
	const held = async (): Promise<void> => {
		recorded.events += 1
		if (recorded.events === options.lostAt) loseLease()
		if (controller.signal.aborted) throw controller.signal.reason
	}
	const stored = (kind: string, state: JsonValue): JsonValue => {
		const parsed: JsonValue = JSON.parse(JSON.stringify(state))
		if (!Bun.deepEquals(parsed, state, true)) recorded.violations.push(`${kind} state is not JSON as given`)
		return parsed
	}
	const events: ProviderRunEvents = {
		log: (line) => {
			recorded.logs.push(line)
		},
		externalId: async (id, state) => {
			await held()
			recorded.externalIds.push(state === undefined ? { id } : { id, state: stored('externalId', state) })
		},
		checkpoint: async (state) => {
			await held()
			recorded.checkpoints.push(stored('checkpoint', state))
		},
		boundary: held,
	}
	const input: ProviderDeployInput = {
		...cloud.input,
		secrets: { ...cloud.input.secrets, [SECRET_NAME]: SECRET_VALUE },
		dryRun,
		signal: controller.signal,
		events,
	}
	return { input, recorded, loseLease, signal: controller.signal }
}

/**
 * The deploy's outcome, or the reason it rejected with. A step a provider stops waiting for may still run, so the
 * cloud is read only after the tasks already queued have run.
 */
async function settle(provider: ControlProvider, input: ProviderDeployInput): Promise<ProviderDeployOutcome | { readonly rejected: unknown }> {
	let outcome: ProviderDeployOutcome | { readonly rejected: unknown }
	try {
		outcome = await provider.deploy(input)
	} catch (error) {
		outcome = { rejected: error }
	}
	await new Promise((resolve) => setTimeout(resolve, 0))
	return outcome
}

/** No event carried a credential: the deploy's secrets, its credential managed entries, the upload bearer, the provider's own. */
function expectCredentialFree(cloud: ConformanceCloud, run: Invocation): void {
	const { input } = run
	const managed = Object.values(input.managedEnvironment).flatMap((entry) => entry.credential && entry.value !== null ? [entry.value] : [])
	const bearer = input.artifactUpload === undefined ? [] : [input.artifactUpload.bearer]
	const reported = JSON.stringify({ logs: run.recorded.logs, externalIds: run.recorded.externalIds, checkpoints: run.recorded.checkpoints })
	for (const credential of [...Object.values(input.secrets), ...managed, ...bearer, ...cloud.credentials]) {
		expect(reported).not.toContain(credential)
	}
	expect(run.recorded.violations).toEqual([])
}

export function describeControlProviderConformance(name: string, harness: ControlProviderConformanceHarness): void {
	const quiet = (): ConformanceCloud => harness.create({ accepted: () => {} })

	describe(`${name} conforms to ControlProvider`, () => {
		test('a deploy succeeds, and nothing it reports carries a credential', async () => {
			const cloud = quiet()
			const run = invocation(cloud, false)
			expect(await settle(cloud.provider, run.input)).toMatchObject({ state: 'succeeded' })
			expect(cloud.mutations().length).toBeGreaterThan(0)
			expect(cloud.stops()).toEqual([])
			expectCredentialFree(cloud, run)
		})

		test('a dry run succeeds, changes nothing in the cloud, and reports no credential', async () => {
			const cloud = quiet()
			const run = invocation(cloud, true)
			expect(await settle(cloud.provider, run.input)).toMatchObject({ state: 'succeeded' })
			expect(cloud.mutations()).toEqual([])
			expect(cloud.stops()).toEqual([])
			expectCredentialFree(cloud, run)
		})

		test('an invocation whose lease is gone at its first event changes nothing in the cloud', async () => {
			const cloud = quiet()
			const run = invocation(cloud, false, { lostAt: 1 })
			expect(await settle(cloud.provider, run.input)).not.toMatchObject({ state: 'succeeded' })
			expect(cloud.mutations()).toEqual([])
			expect(cloud.stops()).toEqual([])
		})

		test('a lease lost at any event of a deploy stops nothing, and the deploy claims no success', async () => {
			const cloud = quiet()
			const complete = invocation(cloud, false)
			await settle(cloud.provider, complete.input)
			expect(complete.recorded.events).toBeGreaterThan(0)
			for (let lostAt = 1; lostAt <= complete.recorded.events; lostAt += 1) {
				const lost = quiet()
				const run = invocation(lost, false, { lostAt })
				const outcome = await settle(lost.provider, run.input)
				// The cloud may still finish the work; this invocation may not claim it, and may not stop it.
				expect({ lostAt, outcome }).not.toMatchObject({ outcome: { state: 'succeeded' } })
				expect({ lostAt, stops: lost.stops() }).toEqual({ lostAt, stops: [] })
				expectCredentialFree(lost, run)
			}
		})

		test('a lease lost once the cloud accepted the deploy stops nothing, in the deploy, a reconcile or a cancel', async () => {
			let run: Invocation | undefined
			let accepted = false
			const cloud = harness.create({
				accepted: () => {
					accepted = true
					run?.loseLease()
				},
			})
			run = invocation(cloud, false)
			const outcome = await settle(cloud.provider, run.input)
			expect(accepted).toBe(true)
			expect(outcome).not.toMatchObject({ state: 'succeeded' })
			expect(cloud.stops()).toEqual([])

			// Control reconciles and cancels a run by what its last owner recorded.
			const recordedId = run.recorded.externalIds[0]
			if (recordedId === undefined) throw new Error('the deploy recorded no external id before its operation was accepted')
			const providerState = run.recorded.checkpoints.at(-1) ?? recordedId.state
			const reference = {
				runId: run.input.runId,
				externalId: recordedId.id,
				environment: run.input.environment,
				signal: run.signal,
				...(providerState === undefined ? {} : { providerState }),
			}
			const mutations = cloud.mutations().length
			await cloud.provider.reconcile?.(reference).catch(() => {})
			await cloud.provider.cancel?.(reference).catch(() => {})
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(cloud.stops()).toEqual([])
			expect(cloud.mutations()).toHaveLength(mutations)
		})

		test('a registration normalizes to itself, and its envelopes survive JSON', () => {
			const cloud = quiet()
			const normalize = cloud.provider.normalizeRegistration
			if (normalize === undefined) return
			const once = normalize({ app: cloud.input.app, environment: cloud.input.environment })
			expect(normalize(once)).toEqual(once)
			expect(JSON.parse(JSON.stringify(once.environment.target))).toEqual(once.environment.target)
			expect(JSON.parse(JSON.stringify(once.environment.artifact))).toEqual(once.environment.artifact)
		})
	})
}
