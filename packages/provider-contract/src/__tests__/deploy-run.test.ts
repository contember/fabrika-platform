import { describe, expect, test } from 'bun:test'
import {
	awaitSettlement,
	cancelRun,
	type DeployRunContext,
	type JsonValue,
	type ProviderEnvironment,
	ProviderInvocationAbort,
	type ProviderRunEvents,
	reconcileRun,
	type RunAttempt,
	runDeploy,
	type RunObservation,
} from '..'

// A cloud whose build does not activate anything and whose service update does: the shape of a container cloud's run
// (build an image, register a revision, update the service, wait for the rollout), unlike Zerops', where one build
// request also activates. Its checkpoint names a caller-chosen token first, then each id the cloud answered.
interface Checkpoint {
	readonly buildToken: string
	readonly buildId?: string
	readonly taskDefinitionArn?: string
	readonly serviceUpdateRequested?: true
	readonly deploymentArn?: string
}

type DeploymentStatus = 'IN_PROGRESS' | 'SUCCESSFUL' | 'FAILED'

class FakeCloud {
	/** Every call, in order, beside every checkpoint write (see `Recorder`). */
	readonly timeline: string[] = []
	readonly deployments = new Map<string, DeploymentStatus>()
	readonly stoppedBuilds: string[] = []
	readonly stoppedDeployments: string[] = []
	failStopBuild = false
	failDescribe = false

	startBuild(token: string): string {
		this.timeline.push(`StartBuild ${token}`)
		return `build-${token}`
	}

	registerTaskDefinition(): string {
		this.timeline.push('RegisterTaskDefinition')
		return 'arn:task-definition:7'
	}

	updateService(taskDefinitionArn: string): string {
		this.timeline.push(`UpdateService ${taskDefinitionArn}`)
		const arn = 'arn:deployment:1'
		this.deployments.set(arn, 'IN_PROGRESS')
		return arn
	}
}

const attemptOver = (cloud: FakeCloud): RunAttempt<Checkpoint> => ({
	parse: (state) => {
		if (state === null || typeof state !== 'object' || Array.isArray(state) || typeof state['buildToken'] !== 'string') return null
		const { buildToken, buildId, taskDefinitionArn, serviceUpdateRequested, deploymentArn } = state
		return {
			buildToken,
			...(typeof buildId === 'string' ? { buildId } : {}),
			...(typeof taskDefinitionArn === 'string' ? { taskDefinitionArn } : {}),
			...(serviceUpdateRequested === true ? { serviceUpdateRequested } : {}),
			...(typeof deploymentArn === 'string' ? { deploymentArn } : {}),
		}
	},
	encode: (checkpoint) => ({ ...checkpoint }),
	externalId: (checkpoint) => checkpoint.buildToken,
	submitted: (checkpoint) => checkpoint.serviceUpdateRequested === true,
	discard: async (checkpoint) => {
		if (cloud.failStopBuild) throw new Error('StopBuild refused')
		if (checkpoint.buildId !== undefined) cloud.stoppedBuilds.push(checkpoint.buildId)
	},
	observe: async (checkpoint): Promise<RunObservation> => {
		if (cloud.failDescribe) return { state: 'unobservable', cause: new Error('DescribeServices timed out') }
		const status = checkpoint.deploymentArn === undefined ? undefined : cloud.deployments.get(checkpoint.deploymentArn)
		if (status === undefined) return { state: 'absent' }
		if (status === 'SUCCESSFUL') return { state: 'active' }
		if (status === 'FAILED') return { state: 'failed', reason: `deployment ${checkpoint.deploymentArn} rolled back` }
		return { state: 'pending', status }
	},
	stop: async (checkpoint) => {
		if (checkpoint.deploymentArn !== undefined) cloud.stoppedDeployments.push(checkpoint.deploymentArn)
	},
	deadlineMs: 60_000,
	words: {
		provider: 'cloud',
		candidate: (checkpoint) => `build ${checkpoint.buildId ?? checkpoint.buildToken}`,
		discarded: 'stopped',
		notDiscarded: 'could not be stopped; the service was never updated',
		submission: 'updated the service',
	},
})

/** Control's side of a run: the stored checkpoint, the external id, the run log and the boundaries. */
class Recorder implements ProviderRunEvents {
	readonly logs: string[] = []
	externalIdValue: string | undefined
	state: JsonValue | undefined
	failWrites = 0
	onBoundary: () => Promise<void> = async () => {}

	constructor(private readonly cloud: FakeCloud) {}

	log(line: string): void {
		this.logs.push(line)
	}

	async externalId(id: string, state?: JsonValue): Promise<void> {
		this.write(`externalId ${id}`)
		this.externalIdValue = id
		this.state = state
	}

	async checkpoint(state: JsonValue): Promise<void> {
		this.write(`checkpoint ${JSON.stringify(state)}`)
		this.state = state
	}

	boundary(): Promise<void> {
		return this.onBoundary()
	}

	private write(entry: string): void {
		if (this.failWrites > 0) {
			this.failWrites--
			throw new Error('the run row is fenced')
		}
		this.cloud.timeline.push(entry)
	}
}

const step = (id: string) => ({ id, description: `Run ${id}` })
const STEPS = ['resolve', 'upload', 'build', 'register', 'update', 'wait'].map(step)

interface RunSetup {
	readonly cloud: FakeCloud
	readonly events: Recorder
	readonly controller: AbortController
	readonly failAt?: string
	/** The step at which the run loses its lease, as on a Control restart. */
	readonly crashAt?: string
}

/** The cloud's steps over the neutral run: each records what the next call needs before it sends that call. */
const deploy = (setup: RunSetup) => {
	const { cloud, events, controller } = setup
	const attempt = attemptOver(cloud)
	return runDeploy({
		attempt,
		steps: STEPS,
		options: { appId: 'shop', env: 'prod', dryRun: false, signal: controller.signal, log: (line) => events.log(line) },
		events,
		runOne: async (current, run: DeployRunContext<Checkpoint>) => {
			if (current.id === setup.failAt) throw new Error(`${current.id} failed`)
			if (current.id === setup.crashAt) {
				const lost = new ProviderInvocationAbort('lease_lost')
				controller.abort(lost)
				throw lost
			}
			const checkpoint = run.checkpoint
			switch (current.id) {
				case 'resolve':
					return run.record({ buildToken: 'tok1' })
				case 'upload':
					cloud.timeline.push('PutObject')
					return
				case 'build': {
					if (checkpoint === undefined) throw new Error('no checkpoint')
					const buildId = cloud.startBuild(checkpoint.buildToken)
					return run.record({ ...checkpoint, buildId })
				}
				case 'register': {
					if (checkpoint === undefined) throw new Error('no checkpoint')
					return run.record({ ...checkpoint, taskDefinitionArn: cloud.registerTaskDefinition() })
				}
				case 'update': {
					if (checkpoint?.taskDefinitionArn === undefined) throw new Error('no task definition')
					const requested: Checkpoint = { ...checkpoint, serviceUpdateRequested: true }
					await run.record(requested)
					const deploymentArn = cloud.updateService(checkpoint.taskDefinitionArn)
					return run.record({ ...requested, deploymentArn })
				}
				case 'wait': {
					if (checkpoint === undefined) throw new Error('no checkpoint')
					return awaitSettlement({
						attempt,
						checkpoint,
						events,
						signal: controller.signal,
						deadlineMs: Date.now() + 60_000,
						intervalMs: 1,
						sleep: async () => {},
						observe: (signal) => attempt.observe(checkpoint, signal),
					})
				}
			}
		},
	})
}

const environment: ProviderEnvironment = {
	appId: 'shop',
	env: 'prod',
	target: { provider: 'cloud', version: 1, payload: {} },
	artifact: { provider: 'cloud', version: 1, payload: {} },
}

/** The run reference Control hands a reconcile or a cancel, from what the recorder stored. */
const reference = (events: Recorder, startedAtMs = Date.now()) => ({
	runId: 'run-1',
	externalId: events.externalIdValue ?? '',
	environment,
	...(events.state === undefined ? {} : { providerState: events.state }),
	startedAtMs,
	signal: new AbortController().signal,
})

const setupRun = (): RunSetup => {
	const cloud = new FakeCloud()
	return { cloud, events: new Recorder(cloud), controller: new AbortController() }
}

describe('runDeploy', () => {
	test('records each id before the call that needs it, and succeeds once the deployment does', async () => {
		const setup = setupRun()
		let polls = 0
		setup.events.onBoundary = async () => {
			if (++polls === 2) setup.cloud.deployments.set('arn:deployment:1', 'SUCCESSFUL')
		}

		const result = await deploy(setup)

		expect(result.status).toBe('succeeded')
		expect(setup.cloud.timeline).toEqual([
			'externalId tok1',
			'PutObject',
			'StartBuild tok1',
			'checkpoint {"buildToken":"tok1","buildId":"build-tok1"}',
			'RegisterTaskDefinition',
			'checkpoint {"buildToken":"tok1","buildId":"build-tok1","taskDefinitionArn":"arn:task-definition:7"}',
			'checkpoint {"buildToken":"tok1","buildId":"build-tok1","taskDefinitionArn":"arn:task-definition:7","serviceUpdateRequested":true}',
			'UpdateService arn:task-definition:7',
			'checkpoint {"buildToken":"tok1","buildId":"build-tok1","taskDefinitionArn":"arn:task-definition:7","serviceUpdateRequested":true,"deploymentArn":"arn:deployment:1"}',
		])
		expect(setup.cloud.stoppedBuilds).toEqual([])
	})

	test('a failure before the activating call discards the exact candidate', async () => {
		const setup = { ...setupRun(), failAt: 'register' }

		const result = await deploy(setup)

		expect(result.status).toBe('failed')
		expect(result.steps.map((entry) => entry.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'failed', 'skipped', 'skipped'])
		expect(setup.cloud.stoppedBuilds).toEqual(['build-tok1'])
		expect(setup.events.logs).toContain('  stopped build build-tok1')
	})

	test('a failed discard is a warning, never the outcome', async () => {
		const setup = { ...setupRun(), failAt: 'register' }
		setup.cloud.failStopBuild = true

		const result = await deploy(setup)

		expect(result.status).toBe('failed')
		expect(setup.events.logs).toContain('  [warn] build build-tok1 could not be stopped; the service was never updated')
	})

	test('a failed deployment fails the run and discards nothing: a submitted candidate is settled only by polling', async () => {
		const setup = setupRun()
		setup.events.onBoundary = async () => {
			setup.cloud.deployments.set('arn:deployment:1', 'FAILED')
		}

		const result = await deploy(setup)

		expect(result.status).toBe('failed')
		expect(result.steps.at(-1)).toMatchObject({ id: 'wait', status: 'failed', error: 'deployment arn:deployment:1 rolled back' })
		expect(setup.cloud.stoppedBuilds).toEqual([])
		expect(setup.cloud.stoppedDeployments).toEqual([])
	})

	test('an unsubmitted checkpoint counts before its write; a submitted one only after, so its call is never sent', async () => {
		const unrecorded = { ...setupRun() }
		unrecorded.events.failWrites = 1

		const first = await deploy(unrecorded)

		// The token names no build yet: discarding it stops nothing, and nothing was sent.
		expect(first.status).toBe('failed')
		expect(first.checkpoint).toEqual({ buildToken: 'tok1' })
		expect(unrecorded.cloud.timeline).toEqual([])

		const setup = setupRun()
		const events = setup.events
		const checkpoint = events.checkpoint.bind(events)
		events.checkpoint = async (state) => {
			if (typeof state === 'object' && state !== null && !Array.isArray(state) && state['serviceUpdateRequested'] === true) {
				throw new Error('the run row is fenced')
			}
			await checkpoint(state)
		}

		const second = await deploy(setup)

		expect(second.status).toBe('failed')
		expect(setup.cloud.timeline).not.toContain('UpdateService arn:task-definition:7')
		expect(second.checkpoint?.serviceUpdateRequested).toBeUndefined()
		expect(setup.cloud.stoppedBuilds).toEqual(['build-tok1'])
	})

	test('a cancelled run leaves its candidate to cancelRun', async () => {
		const setup = setupRun()
		setup.controller.abort(new ProviderInvocationAbort('cancel_requested'))

		const result = await deploy({ ...setup, failAt: 'resolve' })

		expect(result.status).toBe('failed')
		expect(setup.cloud.stoppedBuilds).toEqual([])
	})
})

describe('awaitSettlement', () => {
	const waiting = async (setup: RunSetup, deadlineMs = Date.now() + 60_000) => {
		const attempt = attemptOver(setup.cloud)
		setup.cloud.deployments.set('arn:deployment:1', 'IN_PROGRESS')
		const checkpoint: Checkpoint = { buildToken: 'tok1', serviceUpdateRequested: true, deploymentArn: 'arn:deployment:1' }
		return awaitSettlement({
			attempt,
			checkpoint,
			events: setup.events,
			signal: setup.controller.signal,
			deadlineMs,
			intervalMs: 1,
			sleep: async () => {},
			observe: (signal) => attempt.observe(checkpoint, signal),
		})
	}

	test('a lease lost at a boundary stops nothing', async () => {
		const setup = setupRun()
		const lost = new ProviderInvocationAbort('lease_lost')
		setup.events.onBoundary = async () => {
			setup.controller.abort(lost)
			throw lost
		}

		await expect(waiting(setup)).rejects.toBe(lost)
		expect(setup.cloud.stoppedDeployments).toEqual([])
	})

	test('a cancel read at a boundary stops the candidate and reports the cancel', async () => {
		const setup = setupRun()
		setup.events.onBoundary = async () => {
			setup.controller.abort(new ProviderInvocationAbort('cancel_requested'))
			throw setup.controller.signal.reason
		}

		await expect(waiting(setup)).rejects.toMatchObject({ kind: 'cancel_requested' })
		expect(setup.cloud.stoppedDeployments).toEqual(['arn:deployment:1'])
	})

	test('the deadline stops the candidate and fails the wait, also while it stays unobservable', async () => {
		const pending = setupRun()
		await expect(waiting(pending, Date.now() - 1)).rejects.toThrow('cloud: gave up waiting for build tok1 at the run deadline')
		expect(pending.cloud.stoppedDeployments).toEqual(['arn:deployment:1'])

		const unobservable = setupRun()
		unobservable.cloud.failDescribe = true
		await expect(waiting(unobservable, Date.now() - 1)).rejects.toThrow('at the run deadline')
		expect(unobservable.cloud.stoppedDeployments).toEqual(['arn:deployment:1'])
	})
})

describe('recovery through the checkpoint', () => {
	/** Run until the run loses its lease before `step`; its own failure path then leaves the candidate to a successor. */
	const crash = async (step: 'register' | 'wait') => {
		const setup = setupRun()
		const result = await deploy({ ...setup, crashAt: step })
		expect(result.status).toBe('failed')
		return { setup, result }
	}

	test('a successor discards a candidate whose activating call was never recorded, and fails the run', async () => {
		const { setup } = await crash('register')
		expect(setup.cloud.stoppedBuilds).toEqual([])
		const logs: string[] = []

		const outcome = await reconcileRun(attemptOver(setup.cloud), { ...reference(setup.events), log: async (line) => void logs.push(line) })

		expect(outcome).toEqual({ state: 'failed' })
		expect(setup.cloud.stoppedBuilds).toEqual(['build-tok1'])
		expect(logs).toEqual(['deploy interrupted: Control stopped before it updated the service; stopped build build-tok1; run the deploy again'])
	})

	test('a successor polls a submitted candidate to its end, discards nothing, and a success wins', async () => {
		const { setup } = await crash('wait')
		const attempt = attemptOver(setup.cloud)
		expect(setup.events.state).toMatchObject({ serviceUpdateRequested: true, deploymentArn: 'arn:deployment:1' })

		expect(await reconcileRun(attempt, reference(setup.events))).toEqual({ state: 'running' })
		setup.cloud.deployments.set('arn:deployment:1', 'SUCCESSFUL')
		expect(await reconcileRun(attempt, reference(setup.events))).toEqual({ state: 'succeeded' })
		expect(setup.cloud.stoppedBuilds).toEqual([])
		expect(setup.cloud.stoppedDeployments).toEqual([])
	})

	test('a submitted candidate still pending past the deadline is stopped and abandoned', async () => {
		const { setup } = await crash('wait')
		const logs: string[] = []
		const long = Date.now() - 120_000

		const outcome = await reconcileRun(attemptOver(setup.cloud), { ...reference(setup.events, long), log: async (line) => void logs.push(line) })

		expect(outcome).toEqual({ state: 'failed' })
		expect(setup.cloud.stoppedDeployments).toEqual(['arn:deployment:1'])
		expect(logs).toEqual(['abandoned non-terminal build build-tok1 (IN_PROGRESS)'])
	})

	test('an unobservable candidate keeps the run running until the deadline, then is abandoned', async () => {
		const { setup } = await crash('wait')
		setup.cloud.failDescribe = true
		const attempt = attemptOver(setup.cloud)
		const logs: string[] = []

		expect(await reconcileRun(attempt, reference(setup.events))).toEqual({ state: 'running' })
		const outcome = await reconcileRun(attempt, { ...reference(setup.events, Date.now() - 120_000), log: async (line) => void logs.push(line) })

		expect(outcome).toEqual({ state: 'failed' })
		expect(logs).toEqual(['abandoned build build-tok1: its status stayed unobservable past the run deadline'])
	})

	test('a discard that fails keeps the run running for the next pass', async () => {
		const { setup } = await crash('register')
		setup.cloud.failStopBuild = true

		await expect(reconcileRun(attemptOver(setup.cloud), reference(setup.events))).rejects.toThrow('StopBuild refused')
	})

	test('an unrecognised or foreign checkpoint fails the run without a cloud call', async () => {
		const cloud = new FakeCloud()
		const events = new Recorder(cloud)
		const logs: string[] = []
		const log = async (line: string) => void logs.push(line)

		expect(await reconcileRun(attemptOver(cloud), { ...reference(events), externalId: 'tok1', providerState: { appVersionId: 'v1' }, log }))
			.toEqual({ state: 'failed' })
		expect(await reconcileRun(attemptOver(cloud), { ...reference(events), externalId: 'tok2', providerState: { buildToken: 'tok1' }, log }))
			.toEqual({ state: 'failed' })
		expect(logs).toEqual(['unrecognised checkpoint; failing without platform calls', 'unrecognised checkpoint; failing without platform calls'])
		expect(cloud.stoppedBuilds).toEqual([])
		expect(cloud.timeline).toEqual([])
	})
})

describe('cancelRun', () => {
	const stored = (cloud: FakeCloud, checkpoint: Checkpoint, startedAtMs = Date.now()) => ({
		runId: 'run-1',
		externalId: checkpoint.buildToken,
		environment,
		providerState: attemptOver(cloud).encode(checkpoint),
		startedAtMs,
		signal: new AbortController().signal,
	})
	const built: Checkpoint = { buildToken: 'tok1', buildId: 'build-tok1' }
	const updated: Checkpoint = { ...built, taskDefinitionArn: 'arn:task-definition:7', serviceUpdateRequested: true, deploymentArn: 'arn:deployment:1' }

	test('an unsubmitted candidate is discarded and the run fails; a failed discard stays pending', async () => {
		const cloud = new FakeCloud()
		expect(await cancelRun(attemptOver(cloud), stored(cloud, built))).toEqual({ state: 'settled', outcome: 'failed' })
		expect(cloud.stoppedBuilds).toEqual(['build-tok1'])

		cloud.failStopBuild = true
		expect(await cancelRun(attemptOver(cloud), stored(cloud, built))).toEqual({ state: 'pending' })
	})

	test('a submitted candidate is asked to stop and stays pending; activation winning makes it a success', async () => {
		const cloud = new FakeCloud()
		cloud.deployments.set('arn:deployment:1', 'IN_PROGRESS')

		expect(await cancelRun(attemptOver(cloud), stored(cloud, updated))).toEqual({ state: 'pending' })
		expect(cloud.stoppedDeployments).toEqual(['arn:deployment:1'])
		expect(cloud.stoppedBuilds).toEqual([])

		cloud.deployments.set('arn:deployment:1', 'SUCCESSFUL')
		expect(await cancelRun(attemptOver(cloud), stored(cloud, updated))).toEqual({ state: 'settled', outcome: 'succeeded' })
	})

	test('a submitted candidate settles failed when it failed or at the deadline, and an unreadable one throws', async () => {
		const cloud = new FakeCloud()
		cloud.deployments.set('arn:deployment:1', 'IN_PROGRESS')
		expect(await cancelRun(attemptOver(cloud), stored(cloud, updated, Date.now() - 120_000))).toEqual({ state: 'settled', outcome: 'failed' })

		cloud.deployments.set('arn:deployment:1', 'FAILED')
		expect(await cancelRun(attemptOver(cloud), stored(cloud, updated))).toEqual({ state: 'settled', outcome: 'failed' })

		cloud.failDescribe = true
		await expect(cancelRun(attemptOver(cloud), stored(cloud, updated))).rejects.toThrow('DescribeServices timed out')
	})

	test('a checkpoint of another run settles failed without a cloud call', async () => {
		const cloud = new FakeCloud()
		expect(await cancelRun(attemptOver(cloud), { ...stored(cloud, built), externalId: 'tok2' })).toEqual({ state: 'settled', outcome: 'failed' })
		expect(cloud.stoppedBuilds).toEqual([])
	})
})
