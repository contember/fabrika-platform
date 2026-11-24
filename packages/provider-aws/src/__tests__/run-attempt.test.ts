// The AWS candidate of a deploy run: the checkpoint it parses, the build it stops, the service deployment it reads the
// verdict from (also when the update's answer was lost), and the shared contract's cancel and recovery over it.

import { cancelRun, type JsonValue, type ProviderEnvironment, reconcileRun, type RunObservation } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { CodeBuildBuild } from '../aws/codebuild'
import type { EcsService, EcsServiceDeployment, EcsServiceRevision } from '../aws/ecs'
import { AWS_RUN_DEADLINE_MS, awsRunAttempt, parseAwsCheckpoint } from '../run-attempt'

const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const BUILD_ID = 'fabrika-apps-build:5b0c9a8e-7d6f-4e3d-9c2b-1a0f9e8d7c6b'
const TASK_DEFINITION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:42'
const DEPLOYMENT = 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/notes-prod/r2ZTbPmlNM0uqVbg2nTT4'
const REVISION = 'arn:aws:ecs:eu-central-1:123456789012:service-revision/fabrika-apps/notes-prod/4980306466373577095'
const SERVICE_ARN = 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/notes-prod'
const address = { cluster: 'fabrika-apps', service: 'notes-prod' }

const started = { buildToken: TOKEN }
const built = { buildToken: TOKEN, buildId: BUILD_ID }
const registered = { ...built, taskDefinitionArn: TASK_DEFINITION }
const requested = { ...registered, serviceUpdateRequested: true }
const answered = { ...requested, deploymentArn: DEPLOYMENT }

/** A fake of the reads and stops the attempt makes, recording each call. */
class FakeAws {
	readonly calls: string[] = []
	found: CodeBuildBuild | null = null
	service: EcsService | null = null
	deployment: EcsServiceDeployment | null = null
	revision: EcsServiceRevision | null = { arn: REVISION, taskDefinitionArn: TASK_DEFINITION }
	failure: Error | null = null

	readonly attempt = awsRunAttempt({
		buildProject: 'fabrika-apps-build',
		service: address,
		codeBuild: {
			findBuild: async (project, token) => {
				this.calls.push(`findBuild ${project} ${token}`)
				return this.found
			},
			stopBuild: async (id) => {
				this.calls.push(`stopBuild ${id}`)
				return null
			},
		},
		ecs: {
			describeService: async () => {
				this.calls.push('describeService')
				if (this.failure !== null) throw this.failure
				return this.service
			},
			describeServiceDeployment: async (arn) => {
				this.calls.push(`describeServiceDeployment ${arn}`)
				if (this.failure !== null) throw this.failure
				return this.deployment
			},
			describeServiceRevision: async (arn) => {
				this.calls.push(`describeServiceRevision ${arn}`)
				return this.revision
			},
		},
	})
}

const deployment = (status: EcsServiceDeployment['status'], statusReason: string | null = null): EcsServiceDeployment => ({
	arn: DEPLOYMENT,
	serviceArn: SERVICE_ARN,
	status,
	statusReason,
	targetRevisionArn: REVISION,
})

const service = (currentDeploymentArn: string | null): EcsService => ({
	name: 'notes-prod',
	arn: SERVICE_ARN,
	status: 'active',
	taskDefinitionArn: TASK_DEFINITION,
	deployments: [],
	currentDeploymentArn,
	events: [],
})

const signal = new AbortController().signal

describe('parseAwsCheckpoint', () => {
	test('reads each checkpoint a run records, in order', () => {
		for (const checkpoint of [started, built, registered, requested, answered]) expect(parseAwsCheckpoint(checkpoint)).toEqual(checkpoint)
	})

	test('refuses a checkpoint no run could have recorded', () => {
		const states: readonly (JsonValue | undefined)[] = [
			undefined,
			{},
			{ buildId: BUILD_ID },
			{ ...started, extra: 'x' },
			{ ...started, taskDefinitionArn: TASK_DEFINITION },
			{ ...built, serviceUpdateRequested: true },
			{ ...registered, deploymentArn: DEPLOYMENT },
			{ ...started, buildToken: 'not-a-token' },
		]
		for (const state of states) expect(parseAwsCheckpoint(state)).toBeNull()
	})
})

describe('awsRunAttempt', () => {
	test('names the token as the external id and the service update as the submission', () => {
		const { attempt } = new FakeAws()
		const checkpoint = parseAwsCheckpoint(answered)
		if (checkpoint === null) throw new Error('the checkpoint should parse')
		expect(attempt.externalId(checkpoint)).toBe(TOKEN)
		expect(attempt.submitted(checkpoint)).toBe(true)
		expect(attempt.encode(checkpoint)).toEqual(answered)
		expect(attempt.parse(attempt.encode(checkpoint))).toEqual(checkpoint)
		expect(attempt.deadlineMs).toBe(AWS_RUN_DEADLINE_MS)
		const before = parseAwsCheckpoint(registered)
		if (before === null) throw new Error('the checkpoint should parse')
		expect(attempt.submitted(before)).toBe(false)
	})

	test('discards an unsubmitted run by stopping its build, found by the token when its id was lost', async () => {
		const known = new FakeAws()
		await known.attempt.discard({ ...built }, signal)
		expect(known.calls).toEqual([`stopBuild ${BUILD_ID}`])

		const lost = new FakeAws()
		lost.found = { id: BUILD_ID, status: 'in_progress', phase: 'BUILD', log: null }
		await lost.attempt.discard({ ...started }, signal)
		expect(lost.calls).toEqual([`findBuild fabrika-apps-build ${TOKEN}`, `stopBuild ${BUILD_ID}`])

		// A start that never landed left nothing to stop.
		const never = new FakeAws()
		await never.attempt.discard({ ...started }, signal)
		expect(never.calls).toEqual([`findBuild fabrika-apps-build ${TOKEN}`])
	})

	test('reads the verdict from the recorded service deployment', async () => {
		const cases: readonly [EcsServiceDeployment['status'], RunObservation][] = [
			['successful', { state: 'active' }],
			['pending', { state: 'pending', status: 'pending' }],
			['in_progress', { state: 'pending', status: 'in_progress' }],
			// A rollback in progress has failed the candidate, but the run settles once the service is back.
			['rollback_in_progress', { state: 'pending', status: 'rollback_in_progress' }],
			['rollback_successful', { state: 'failed', reason: `aws: service deployment ${DEPLOYMENT} is rollback_successful: tasks failed to start` }],
			['rollback_failed', { state: 'failed', reason: `aws: service deployment ${DEPLOYMENT} is rollback_failed: tasks failed to start` }],
			['stopped', { state: 'failed', reason: `aws: service deployment ${DEPLOYMENT} is stopped: tasks failed to start` }],
		]
		for (const [status, observed] of cases) {
			const aws = new FakeAws()
			aws.deployment = deployment(status, 'tasks failed to start')
			expect(await aws.attempt.observe({ ...answered, serviceUpdateRequested: true }, signal)).toEqual(observed)
			expect(aws.calls).toEqual([`describeServiceDeployment ${DEPLOYMENT}`])
		}
		const long = new FakeAws()
		long.deployment = deployment('stopped', 'x'.repeat(1000))
		const failed = await long.attempt.observe({ ...answered, serviceUpdateRequested: true }, signal)
		// The reason is cut at 300 characters.
		expect(failed.state === 'failed' && failed.reason.endsWith(`is stopped: ${'x'.repeat(300)}`)).toBe(true)
	})

	test('a lost update answer is read through the service, and counts only when the deployment deploys this revision', async () => {
		const ours = new FakeAws()
		ours.service = service(DEPLOYMENT)
		ours.deployment = deployment('successful')
		expect(await ours.attempt.observe({ ...requested, serviceUpdateRequested: true }, signal)).toEqual({ state: 'active' })
		expect(ours.calls).toEqual(['describeService', `describeServiceDeployment ${DEPLOYMENT}`, `describeServiceRevision ${REVISION}`])

		// The service's current deployment deploys another revision: this run's update never landed.
		const other = new FakeAws()
		other.service = service(DEPLOYMENT)
		other.deployment = deployment('successful')
		other.revision = { arn: REVISION, taskDefinitionArn: TASK_DEFINITION.replace(':42', ':41') }
		expect(await other.attempt.observe({ ...requested, serviceUpdateRequested: true }, signal)).toEqual({ state: 'absent' })

		const none = new FakeAws()
		none.service = service(null)
		expect(await none.attempt.observe({ ...requested, serviceUpdateRequested: true }, signal)).toEqual({ state: 'absent' })
		const gone = new FakeAws()
		expect(await gone.attempt.observe({ ...requested, serviceUpdateRequested: true }, signal)).toEqual({ state: 'absent' })
	})

	test('a failed read or an answer about another service is unobservable, never a verdict', async () => {
		const failing = new FakeAws()
		failing.failure = new Error('throttled')
		expect(await failing.attempt.observe({ ...answered, serviceUpdateRequested: true }, signal)).toMatchObject({ state: 'unobservable' })
		const elsewhere = new FakeAws()
		elsewhere.deployment = { ...deployment('successful'), serviceArn: 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/other' }
		expect(await elsewhere.attempt.observe({ ...answered, serviceUpdateRequested: true }, signal)).toMatchObject({ state: 'unobservable' })
	})

	test('stops a build before the update, and never a service deployment after it', async () => {
		const before = new FakeAws()
		await before.attempt.stop({ ...built }, signal)
		expect(before.calls).toEqual([`stopBuild ${BUILD_ID}`])
		const after = new FakeAws()
		await after.attempt.stop({ ...answered, serviceUpdateRequested: true }, signal)
		expect(after.calls).toEqual([])
	})
})

describe('the shared deploy run over the AWS candidate', () => {
	const environment: ProviderEnvironment = {
		appId: 'notes',
		env: 'prod',
		target: { provider: 'aws', version: 1, payload: {} },
		artifact: { provider: 'aws', version: 1, payload: {} },
	}
	const reference = (providerState: JsonValue) => ({
		runId: 'run-1',
		externalId: TOKEN,
		environment,
		providerState,
		startedAtMs: Date.now(),
		signal,
	})

	test('a cancel before the update stops the build and fails the run', async () => {
		const aws = new FakeAws()
		expect(await cancelRun(aws.attempt, reference(built))).toEqual({ state: 'settled', outcome: 'failed' })
		expect(aws.calls).toEqual([`stopBuild ${BUILD_ID}`])
	})

	test('a recovery after the update polls the service deployment and never updates again', async () => {
		const aws = new FakeAws()
		aws.deployment = deployment('in_progress')
		expect(await reconcileRun(aws.attempt, reference(answered))).toEqual({ state: 'running' })
		aws.deployment = deployment('successful')
		expect(await reconcileRun(aws.attempt, reference(answered))).toEqual({ state: 'succeeded' })
		aws.deployment = deployment('rollback_successful')
		expect(await reconcileRun(aws.attempt, reference(answered))).toEqual({ state: 'failed' })
		expect(aws.calls.every((call) => call.startsWith('describeServiceDeployment'))).toBe(true)
	})

	test('a recovery before the update stops the build and fails the run', async () => {
		const aws = new FakeAws()
		const logs: string[] = []
		expect(await reconcileRun(aws.attempt, { ...reference(registered), log: async (line) => void logs.push(line) })).toEqual({ state: 'failed' })
		expect(aws.calls).toEqual([`stopBuild ${BUILD_ID}`])
		expect(logs).toEqual([
			`deploy interrupted: Control stopped before it updated the service; stopped the work of task definition ${TASK_DEFINITION}; run the deploy again`,
		])
	})
})
