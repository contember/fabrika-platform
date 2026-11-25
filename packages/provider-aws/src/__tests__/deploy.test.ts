// The deploy of one application environment over fakes of its AWS calls: every step in order with the checkpoint
// recorded before the call that needs it, the source URL's parameter written and deleted, the build's log relayed and
// drained, the init commands run once each, a throttled call sent again and a lost answer settled the way ADR-0044 asks,
// a cancel and the deadline, and the failures that stop the run (the build, an init command, the rollout) with what the
// shared run then does about the candidate.

import type { DeployStepResult, JsonValue, ProviderRunEvents } from '@fabrika/provider-contract'
import { describe, expect, setSystemTime, test } from 'bun:test'
import type { CodeBuildStatus } from '../aws/codebuild'
import type { EcsNetwork, EcsService, EcsServiceConnect, EcsServiceDeploymentStatus } from '../aws/ecs'
import type { S3PartWriter } from '../aws/s3'
import { AwsError } from '../aws/transport'
import { awsDeploy, type AwsDeployInput } from '../deploy'
import { AWS_BUILD_QUEUED_TIMEOUT_MINUTES, AWS_RUN_DEADLINE_MS, AWS_SOURCE_URL_SECONDS } from '../run-attempt'

const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const BUILD_ID = 'fabrika-apps-build:5b0c9a8e-7d6f-4e3d-9c2b-1a0f9e8d7c6b'
const REVISION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:42'
const INIT_REVISION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod-init:42'
const DEPLOYMENT = 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/notes-prod/r2ZTbPmlNM0uqVbg2nTT4'
const SERVICE_REVISION = 'arn:aws:ecs:eu-central-1:123456789012:service-revision/fabrika-apps/notes-prod/4980306466373577095'
const SERVICE_ARN = 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/notes-prod'
const REPOSITORY_URI = '123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/notes-prod'
const DIGEST = `sha256:${'a'.repeat(64)}`
const TASK = (n: number) => `arn:aws:ecs:eu-central-1:123456789012:task/fabrika-apps/${String(n).repeat(32)}`
const NETWORK = { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'], publicIp: false }
const CONNECT = {
	namespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-abcdefghij123456',
	discoveryName: 'e5-notes-prod',
	port: 3000,
}
const PARAMETER = `/fabrika/main/builds/${TOKEN}/source-url`

const throttled = (operation: string) => new AwsError(operation, 'ThrottlingException', 400, null, true)
const lost = (operation: string) => new AwsError(operation, 'timeout', 0, null, true)

/** A fake of every AWS call the deploy makes, recording each, answering what the test sets. */
class FakeAws {
	readonly calls: string[] = []
	readonly parameters = new Map<string, string>()
	builds: CodeBuildStatus[] = ['in_progress', 'succeeded']
	exits: number[] = [0, 0]
	rollout: EcsServiceDeploymentStatus[] = ['in_progress', 'successful']
	/** Errors each call throws, first to last, before it answers. */
	readonly failures: Record<string, AwsError[]> = {}
	/** A hook run on a call, e.g. to cancel the run there. */
	readonly on: Record<string, () => void> = {}
	findLost = true
	/** The environment's service as ECS reads it: `null` while it does not exist. */
	serviceState: EcsService['status'] | null = 'active'
	/** The deployment a create answers, and how many reads after a create still answer MISSING. */
	createDeployment: string | null = DEPLOYMENT
	lagAfterCreate = 0
	/** The networks a create, an update and each init task were sent. */
	readonly networks: EcsNetwork[] = []
	/** The Service Connect configurations a create and an update were sent. */
	readonly connects: EcsServiceConnect[] = []
	logPages: { readonly message: string; readonly cursor: string; readonly atEnd: boolean }[] = [
		{ message: 'Step 1/9 : FROM oven/bun\nStep 2/9 : RUN bun install\n', cursor: 'f/2', atEnd: false },
	]
	private registered = 0
	private tasks = 0

	private hit(name: string, line: string): void {
		this.calls.push(line)
		this.on[name]?.()
		const failure = this.failures[name]?.shift()
		if (failure !== undefined) throw failure
	}

	readonly clients: AwsDeployInput['clients'] = {
		ecr: {
			ensureRepository: async (name) => {
				this.hit('ensureRepository', `ensureRepository ${name}`)
				return { name, uri: REPOSITORY_URI, arn: 'arn:aws:ecr:eu-central-1:123456789012:repository/fabrika/notes-prod' }
			},
			keepNewestImages: async (name, keep) => this.hit('keepNewestImages', `keepNewestImages ${name} ${keep}`),
			findImage: async (name, reference) => {
				this.hit('findImage', `findImage ${name} ${'tag' in reference ? reference.tag : reference.digest}`)
				return { digest: DIGEST, tags: [`run-${TOKEN}`], pushedAt: new Date() }
			},
		},
		codeBuild: {
			startBuild: async (start) => {
				this.hit('startBuild', `startBuild ${start.token}`)
				return { id: BUILD_ID, status: 'in_progress', phase: 'QUEUED', log: null }
			},
			findBuild: async (project, token) => {
				this.hit('findBuild', `findBuild ${project} ${token}`)
				return this.findLost ? { id: BUILD_ID, status: 'in_progress', phase: 'BUILD', log: null } : null
			},
			getBuild: async (id) => {
				this.hit('getBuild', `getBuild ${id}`)
				const status = this.builds.shift() ?? 'succeeded'
				return { id, status, phase: 'BUILD', log: { group: '/aws/codebuild/fabrika-apps-build', stream: 'stream-1' } }
			},
			stopBuild: async (id) => {
				this.hit('stopBuild', `stopBuild ${id}`)
				return null
			},
		},
		ecs: {
			registerTaskDefinition: async (definition) => {
				this.hit('registerTaskDefinition', `registerTaskDefinition ${definition.family}`)
				this.registered += 1
				return { arn: this.registered === 1 ? REVISION : INIT_REVISION, family: definition.family, revision: 42 }
			},
			createService: async (create) => {
				this.connects.push(create.serviceConnect)
				this.hit('createService', `createService ${create.clientToken} ${create.taskDefinitionArn} ${create.desiredCount}`)
				this.networks.push(create.network)
				this.serviceState = 'active'
				return { ...this.service(), taskDefinitionArn: create.taskDefinitionArn, currentDeploymentArn: this.createDeployment }
			},
			updateService: async (_address, taskDefinitionArn, network, serviceConnect) => {
				this.connects.push(serviceConnect)
				this.hit('updateService', `updateService ${taskDefinitionArn}`)
				this.networks.push(network)
				return { ...this.service(), taskDefinitionArn, currentDeploymentArn: DEPLOYMENT }
			},
			describeService: async () => {
				this.hit('describeService', 'describeService')
				if (this.serviceState !== null && this.lagAfterCreate > 0) {
					this.lagAfterCreate -= 1
					return null
				}
				return this.serviceState === null ? null : { ...this.service(), status: this.serviceState }
			},
			describeServiceDeployment: async (arn) => {
				this.hit('describeServiceDeployment', `describeServiceDeployment ${arn}`)
				return { arn, serviceArn: SERVICE_ARN, status: this.rollout.shift() ?? 'successful', statusReason: null, targetRevisionArn: SERVICE_REVISION }
			},
			describeServiceRevision: async (arn) => {
				this.hit('describeServiceRevision', `describeServiceRevision ${arn}`)
				return { arn, taskDefinitionArn: REVISION }
			},
			runTask: async (start) => {
				this.networks.push(start.network)
				this.hit('runTask', `runTask ${start.clientToken} ${start.command.join(' ')}`)
				this.tasks += 1
				return { arn: TASK(this.tasks), status: 'pending', exitCode: null, stopCode: null, reason: null }
			},
			describeTask: async (_cluster, arn) => {
				this.hit('describeTask', `describeTask ${arn}`)
				const index = arn === TASK(1) ? 0 : 1
				return { arn, status: 'stopped', exitCode: this.exits[index] ?? 0, stopCode: 'EssentialContainerExited', reason: null }
			},
		},
		logs: {
			readForward: async (_group, _stream, cursor) => {
				this.hit('readForward', `readForward ${cursor ?? 'head'}`)
				const page = this.logPages.shift()
				if (page === undefined) return { events: [], cursor: cursor ?? 'f/1', atEnd: true }
				return { events: [{ at: new Date(), message: page.message }], cursor: page.cursor, atEnd: page.atEnd }
			},
		},
		ssm: {
			putSecret: async (name, value) => {
				this.hit('putSecret', `putSecret ${name}`)
				this.parameters.set(name, value)
				return 1
			},
			deleteSecret: async (name) => {
				this.hit('deleteSecret', `deleteSecret ${name}`)
				return this.parameters.delete(name)
			},
		},
		s3PartWriter: (address): S3PartWriter => {
			this.calls.push(`s3PartWriter ${address.bucket} ${address.key}`)
			return { partBytes: 8 * 1024 * 1024, writePart: async () => {}, complete: async () => void this.calls.push('complete'), abort: async () => {} }
		},
		credentials: { current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session' }) },
	}

	private service(): EcsService {
		return {
			name: 'notes-prod',
			arn: SERVICE_ARN,
			status: 'active',
			taskDefinitionArn: REVISION,
			deployments: [],
			currentDeploymentArn: DEPLOYMENT,
			network: NETWORK,
			events: [],
		}
	}
}

/** The events the shared run writes through: the external id, every checkpoint, the log. */
class Recorder implements ProviderRunEvents {
	readonly lines: string[] = []
	readonly checkpoints: JsonValue[] = []
	externalIdValue: string | undefined
	/** A checkpoint write that fails, by a field it holds. */
	refuse: string | null = null
	log(line: string): void {
		this.lines.push(line)
	}
	async externalId(id: string, state?: JsonValue): Promise<void> {
		this.externalIdValue = id
		if (state !== undefined) this.checkpoints.push(state)
	}
	async checkpoint(state: JsonValue): Promise<void> {
		if (this.refuse !== null && JSON.stringify(state).includes(this.refuse)) throw new Error('the store refused the checkpoint')
		this.checkpoints.push(state)
	}
	/** Called at every boundary, e.g. to see the wait reach the one after a cancel. */
	onBoundary: () => void = () => {}
	async boundary(): Promise<void> {
		this.onBoundary()
	}
}

const deploy = (aws: FakeAws, events: Recorder, change: Partial<AwsDeployInput> = {}) =>
	awsDeploy({
		appId: 'notes',
		env: 'prod',
		target: { accountId: '123456789012', region: 'eu-central-1', cluster: 'fabrika-apps', service: 'notes-prod' },
		sourcesBucket: 'fabrika-apps-sources',
		build: {
			project: 'fabrika-apps-build',
			repositoryName: 'fabrika/notes-prod',
			repositoryUri: REPOSITORY_URI,
			repositoryTags: { 'fabrika:app': 'notes' },
			keepImages: 20,
			urlParameterPath: '/fabrika/main/builds',
		},
		image: {
			dockerfile: '# Generated\nFROM oven/bun\n',
			init: [['sh', '/app/fabrika/migrate.generated.sh'], ['sh', '/app/fabrika/verify.generated.sh']],
			start: ['sh', '/app/fabrika/start.generated.sh'],
		},
		sourceMapKeyParameter: null,
		task: {
			family: 'notes-prod',
			healthPath: '/__fabrika/health',
			environment: { FABRIKA_APP_ID: 'notes' },
			secrets: {},
			initSecrets: {},
			taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika-apps-notes-prod',
			executionRoleArn: 'arn:aws:iam::123456789012:role/fabrika-apps-notes-prod-execution',
			cpu: 512,
			memory: 1024,
			log: { group: '/fabrika/apps/notes-prod', region: 'eu-central-1' },
			tags: { 'fabrika:app': 'notes' },
		},
		network: NETWORK,
		serviceConnect: CONNECT,
		clients: aws.clients,
		source: { upload: async (parts) => parts.complete({ last: new Uint8Array([1]), parts: 1, bytes: 1 }, new AbortController().signal) },
		events,
		signal: new AbortController().signal,
		dryRun: false,
		startedAtMs: Date.now(),
		sleep: async () => {},
		newToken: () => TOKEN,
		...change,
	})

const stepOf = (result: { readonly steps: readonly DeployStepResult[] }, id: string) => result.steps.find((step) => step.id === id)

describe('awsDeploy', () => {
	test('runs every step in order, each checkpoint recorded before the call that needs it', async () => {
		const aws = new FakeAws()
		const events = new Recorder()
		const result = await deploy(aws, events)
		expect(result.status).toBe('succeeded')
		expect(result.steps.map((step) => [step.id, step.status])).toEqual([
			['repository', 'succeeded'],
			['upload', 'succeeded'],
			['build', 'succeeded'],
			['register', 'succeeded'],
			['init', 'succeeded'],
			['update', 'succeeded'],
			['rollout', 'succeeded'],
		])
		expect(events.externalIdValue).toBe(TOKEN)
		expect(events.checkpoints).toEqual([
			{ buildToken: TOKEN },
			{ buildToken: TOKEN, buildId: BUILD_ID },
			{ buildToken: TOKEN, buildId: BUILD_ID, taskDefinitionArn: REVISION },
			{ buildToken: TOKEN, buildId: BUILD_ID, taskDefinitionArn: REVISION, serviceUpdateRequested: true },
			{ buildToken: TOKEN, buildId: BUILD_ID, taskDefinitionArn: REVISION, serviceUpdateRequested: true, deploymentArn: DEPLOYMENT },
		])
		expect(aws.calls).toEqual([
			'ensureRepository fabrika/notes-prod',
			'keepNewestImages fabrika/notes-prod 20',
			`s3PartWriter fabrika-apps-sources sources/notes/prod/${TOKEN}.tar.gz`,
			'complete',
			`putSecret ${PARAMETER}`,
			`startBuild ${TOKEN}`,
			`getBuild ${BUILD_ID}`,
			'readForward head',
			`getBuild ${BUILD_ID}`,
			'readForward f/2',
			// Drained once the build ended, until the stream says it is at its end.
			'readForward f/2',
			`deleteSecret ${PARAMETER}`,
			`findImage fabrika/notes-prod run-${TOKEN}`,
			'registerTaskDefinition notes-prod',
			'registerTaskDefinition notes-prod-init',
			`runTask ${TOKEN}-init-1 sh /app/fabrika/migrate.generated.sh`,
			`describeTask ${TASK(1)}`,
			`runTask ${TOKEN}-init-2 sh /app/fabrika/verify.generated.sh`,
			`describeTask ${TASK(2)}`,
			'describeService',
			`updateService ${REVISION}`,
			`describeServiceDeployment ${DEPLOYMENT}`,
			`describeServiceDeployment ${DEPLOYMENT}`,
		])
		// The init tasks and the update run in the network the deploy was handed, never one read back from the service.
		expect(aws.networks).toEqual([NETWORK, NETWORK, NETWORK])
		// The update publishes the service in its namespace's Service Connect namespace, as the create does.
		expect(aws.connects).toEqual([CONNECT])
		// The source URL went to its parameter, and the parameter is gone again.
		expect(aws.parameters.size).toBe(0)
		expect(events.lines).toContain('  │ Step 1/9 : FROM oven/bun')
		expect(events.lines).toContain('  │ Step 2/9 : RUN bun install')
	})

	test("an environment's first run migrates, then creates its service on its revision under the run's token", async () => {
		const aws = new FakeAws()
		aws.serviceState = null
		const events = new Recorder()
		const result = await deploy(aws, events)
		expect(result.status).toBe('succeeded')
		const after = aws.calls.slice(aws.calls.indexOf('registerTaskDefinition notes-prod-init') + 1)
		expect(after).toEqual([
			`runTask ${TOKEN}-init-1 sh /app/fabrika/migrate.generated.sh`,
			`describeTask ${TASK(1)}`,
			`runTask ${TOKEN}-init-2 sh /app/fabrika/verify.generated.sh`,
			`describeTask ${TASK(2)}`,
			'describeService',
			`createService ${TOKEN} ${REVISION} 1`,
			`describeServiceDeployment ${DEPLOYMENT}`,
			`describeServiceDeployment ${DEPLOYMENT}`,
		])
		expect(aws.networks).toEqual([NETWORK, NETWORK, NETWORK])
		expect(aws.connects).toEqual([CONNECT])
		// Recorded before the create as before an update, and marked a create: from there the run is settled by polling.
		expect(events.checkpoints.at(-2)).toEqual({
			buildToken: TOKEN,
			buildId: BUILD_ID,
			taskDefinitionArn: REVISION,
			serviceUpdateRequested: true,
			serviceCreateRequested: true,
		})
		expect(result.checkpoint).toMatchObject({ deploymentArn: DEPLOYMENT })
		expect(events.lines).toContain('  created the service notes-prod')
		// A service ECS keeps as deleted is created again under its name.
		const deleted = new FakeAws()
		deleted.serviceState = 'inactive'
		expect((await deploy(deleted, new Recorder())).status).toBe('succeeded')
		expect(deleted.calls).toContain(`createService ${TOKEN} ${REVISION} 1`)
	})

	test('a created service ECS does not show yet is waited for, not a verdict', async () => {
		const aws = new FakeAws()
		aws.serviceState = null
		// The create answers no deployment, and the first reads after it still answer MISSING.
		aws.createDeployment = null
		aws.lagAfterCreate = 2
		// Settled at the first read that finds the deployment: two reads answer MISSING, the third the service.
		aws.rollout = ['successful']
		const result = await deploy(aws, new Recorder())
		expect(result.status).toBe('succeeded')
		expect(result.checkpoint).not.toHaveProperty('deploymentArn')
		const after = aws.calls.slice(aws.calls.indexOf(`createService ${TOKEN} ${REVISION} 1`) + 1)
		expect(after.filter((call) => call === 'describeService').length).toBe(3)
		expect(after).toContain(`describeServiceRevision ${SERVICE_REVISION}`)
	})

	test('a lost create is sent again under its client token; one never answered waits for the deadline', async () => {
		const aws = new FakeAws()
		aws.serviceState = null
		aws.failures['createService'] = [lost('CreateService')]
		expect((await deploy(aws, new Recorder())).status).toBe('succeeded')
		expect(aws.calls.filter((call) => call === `createService ${TOKEN} ${REVISION} 1`).length).toBe(2)

		const never = new FakeAws()
		never.serviceState = null
		never.failures['createService'] = Array.from({ length: 4 }, () => lost('CreateService'))
		// Once the rollout reads the service (the update step read it first), the clock passes the run's deadline.
		const sleep = async (): Promise<void> => {
			if (never.calls.filter((call) => call === 'describeService').length >= 2) setSystemTime(new Date(Date.now() + AWS_RUN_DEADLINE_MS))
		}
		let result: Awaited<ReturnType<typeof deploy>>
		try {
			result = await deploy(never, new Recorder(), { sleep })
		} finally {
			setSystemTime()
		}
		expect(stepOf(result, 'update')).toMatchObject({ status: 'succeeded' })
		// No verdict from MISSING: the rollout waited until the deadline, more than one read.
		expect(stepOf(result, 'rollout')).toMatchObject({ status: 'failed' })
		expect(stepOf(result, 'rollout')?.error ?? '').toContain('gave up waiting')
		expect(never.calls.filter((call) => call.startsWith('createService')).length).toBe(4)

		const refused = new FakeAws()
		refused.serviceState = null
		refused.failures['createService'] = [new AwsError('CreateService', 'InvalidParameterException', 400, null, false)]
		expect(stepOf(await deploy(refused, new Recorder()), 'update')).toMatchObject({ status: 'failed' })
	})

	test('a service being deleted is neither updated nor created: the run fails before it asks for either', async () => {
		const aws = new FakeAws()
		aws.serviceState = 'draining'
		const result = await deploy(aws, new Recorder())
		expect(stepOf(result, 'update')).toMatchObject({
			status: 'failed',
			error: 'aws: the service notes-prod is being deleted; deploy again once it is gone',
		})
		expect(aws.calls.some((call) => call.startsWith('updateService') || call.startsWith('createService'))).toBe(false)
		expect(result.checkpoint).not.toHaveProperty('serviceUpdateRequested')
	})

	test('the source URL stays valid for the whole queue allowance and the provisioning', async () => {
		expect(AWS_SOURCE_URL_SECONDS).toBeGreaterThan(AWS_BUILD_QUEUED_TIMEOUT_MINUTES * 60)
		expect(AWS_SOURCE_URL_SECONDS).toBeLessThanOrEqual(3600)
		const aws = new FakeAws()
		let stored = ''
		aws.on['startBuild'] = () => {
			stored = aws.parameters.get(PARAMETER) ?? ''
		}
		await deploy(aws, new Recorder())
		expect(new URL(stored).searchParams.get('X-Amz-Expires')).toBe(String(AWS_SOURCE_URL_SECONDS))
	})

	test('the tail of a failed build reaches the run log after the build ended', async () => {
		const aws = new FakeAws()
		aws.builds = ['failed']
		aws.logPages = [
			{ message: 'Step 7/9 : RUN bun test\n', cursor: 'f/2', atEnd: false },
			{ message: 'error: 3 tests failed\n', cursor: 'f/3', atEnd: false },
			{ message: '', cursor: 'f/3', atEnd: true },
		]
		const events = new Recorder()
		await deploy(aws, events)
		expect(events.lines).toContain('  │ error: 3 tests failed')
	})

	test('a failed build fails the run before anything registers, and the build is stopped', async () => {
		const aws = new FakeAws()
		aws.builds = ['failed']
		const result = await deploy(aws, new Recorder())
		expect(result.status).toBe('failed')
		expect(stepOf(result, 'build')).toMatchObject({ status: 'failed', error: `aws: build ${BUILD_ID} is failed` })
		expect(result.steps.slice(3).every((step) => step.status === 'skipped')).toBe(true)
		expect(aws.calls).toContain(`stopBuild ${BUILD_ID}`)
		expect(aws.parameters.size).toBe(0)
		expect(aws.calls.some((call) => call.startsWith('updateService') || call.startsWith('registerTaskDefinition'))).toBe(false)
	})

	test('an init command that exits non-zero fails the run, and the service is never updated', async () => {
		const aws = new FakeAws()
		aws.exits = [1]
		const result = await deploy(aws, new Recorder())
		expect(result.status).toBe('failed')
		expect(stepOf(result, 'init')).toMatchObject({ status: 'failed', error: 'aws: init command 1 exited 1' })
		expect(aws.calls.some((call) => call.startsWith('updateService'))).toBe(false)
		expect(aws.calls.filter((call) => call.startsWith('runTask')).length).toBe(1)
	})

	test('a throttled start is sent again under the same token; a lost one is found by the token, never repeated', async () => {
		const refused = new FakeAws()
		refused.failures['startBuild'] = [throttled('StartBuild')]
		expect((await deploy(refused, new Recorder())).status).toBe('succeeded')
		expect(refused.calls.filter((call) => call === `startBuild ${TOKEN}`).length).toBe(2)
		expect(refused.calls.some((call) => call.startsWith('findBuild'))).toBe(false)

		const answerLost = new FakeAws()
		answerLost.failures['startBuild'] = [lost('StartBuild')]
		expect((await deploy(answerLost, new Recorder())).status).toBe('succeeded')
		expect(answerLost.calls.filter((call) => call.startsWith('startBuild')).length).toBe(1)
		expect(answerLost.calls).toContain(`findBuild fabrika-apps-build ${TOKEN}`)

		const none = new FakeAws()
		none.failures['startBuild'] = [lost('StartBuild')]
		none.findLost = false
		expect(stepOf(await deploy(none, new Recorder()), 'build')).toMatchObject({ status: 'failed' })
	})

	test('a throttled or lost RunTask is sent again under its client token, and starts one task', async () => {
		for (const failure of [throttled('RunTask'), lost('RunTask')]) {
			const aws = new FakeAws()
			aws.failures['runTask'] = [failure]
			expect((await deploy(aws, new Recorder())).status).toBe('succeeded')
			expect(aws.calls.filter((call) => call.startsWith(`runTask ${TOKEN}-init-1 `)).length).toBe(2)
		}
	})

	test('a throttled update is sent again; a lost one is settled by the rollout through the service', async () => {
		const refused = new FakeAws()
		refused.failures['updateService'] = [throttled('UpdateService')]
		expect((await deploy(refused, new Recorder())).status).toBe('succeeded')
		expect(refused.calls.filter((call) => call.startsWith('updateService')).length).toBe(2)

		const answerLost = new FakeAws()
		answerLost.failures['updateService'] = [lost('UpdateService')]
		const events = new Recorder()
		const result = await deploy(answerLost, events)
		expect(result.status).toBe('succeeded')
		expect(answerLost.calls.filter((call) => call.startsWith('updateService')).length).toBe(1)
		// No deployment ARN came back: the rollout reads the service's current deployment and checks its revision.
		expect(result.checkpoint).not.toHaveProperty('deploymentArn')
		expect(answerLost.calls).toContain(`describeServiceRevision ${SERVICE_REVISION}`)
	})

	test('an update answer the client could not read is settled by the rollout; a definite refusal fails the step', async () => {
		const unread = new FakeAws()
		unread.failures['updateService'] = [new AwsError('UpdateService', 'invalid_answer', 200, null, false)]
		const settled = await deploy(unread, new Recorder())
		expect(settled.status).toBe('succeeded')
		expect(unread.calls).toContain(`describeServiceRevision ${SERVICE_REVISION}`)
		for (
			const failure of [new AwsError('UpdateService', 'answer_too_large', 200, null, false), new AwsError('UpdateService', 'unknown', 502, null, true)]
		) {
			const aws = new FakeAws()
			aws.failures['updateService'] = [failure]
			expect((await deploy(aws, new Recorder())).status).toBe('succeeded')
		}

		for (
			const failure of [
				new AwsError('UpdateService', 'InvalidParameterException', 400, null, false),
				new AwsError('UpdateService', 'credentials', 0, null, true),
			]
		) {
			const refused = new FakeAws()
			refused.failures['updateService'] = [failure]
			const result = await deploy(refused, new Recorder())
			expect(stepOf(result, 'update')).toMatchObject({ status: 'failed' })
			expect(refused.calls.some((call) => call.startsWith('describeServiceDeployment'))).toBe(false)
		}
	})

	test("a failed write of the deployment's ARN leaves the rollout to the service read", async () => {
		const aws = new FakeAws()
		const events = new Recorder()
		events.refuse = 'deploymentArn'
		const result = await deploy(aws, events)
		expect(result.status).toBe('succeeded')
		expect(events.lines.some((line) => line.includes('could not be recorded'))).toBe(true)
		expect(aws.calls).toContain(`describeServiceRevision ${SERVICE_REVISION}`)
	})

	test('an unobservable read of the build is waited out, not a verdict', async () => {
		const aws = new FakeAws()
		aws.failures['getBuild'] = [throttled('BatchGetBuilds')]
		expect((await deploy(aws, new Recorder())).status).toBe('succeeded')
	})

	test('a cancel during the build stops it, deletes the source URL and records nothing after', async () => {
		const aws = new FakeAws()
		const controller = new AbortController()
		aws.on['getBuild'] = () => controller.abort()
		// A cancelled step ends in the background after the run returned (`runSteps` stops waiting at once): its last act
		// is the deletion of the source URL's parameter, after the build was stopped.
		const cleaned = new Promise<void>((resolve) => {
			aws.on['deleteSecret'] = resolve
		})
		const events = new Recorder()
		const result = await deploy(aws, events, { signal: controller.signal })
		await cleaned
		expect(result.status).toBe('failed')
		expect(aws.calls).toContain(`stopBuild ${BUILD_ID}`)
		expect(aws.parameters.size).toBe(0)
		expect(events.checkpoints.at(-1)).toEqual({ buildToken: TOKEN, buildId: BUILD_ID })
	})

	test('a cancel during the rollout stops nothing: the update was sent', async () => {
		const aws = new FakeAws()
		const controller = new AbortController()
		aws.on['describeServiceDeployment'] = () => controller.abort()
		// The wait meets the cancel at its next boundary; from there it calls nothing of AWS for a submitted run.
		const events = new Recorder()
		const reached = new Promise<void>((resolve) => {
			events.onBoundary = () => {
				if (controller.signal.aborted) resolve()
			}
		})
		const result = await deploy(aws, events, { signal: controller.signal })
		await reached
		expect(result.status).toBe('failed')
		expect(aws.calls.some((call) => call.startsWith('stopBuild'))).toBe(false)
		expect(result.checkpoint).toMatchObject({ serviceUpdateRequested: true })
	})

	test('past the deadline the wait gives up, naming what it waited for', async () => {
		const aws = new FakeAws()
		aws.builds = ['in_progress', 'in_progress']
		const result = await deploy(aws, new Recorder(), { startedAtMs: Date.now() - AWS_RUN_DEADLINE_MS - 1000 })
		expect(stepOf(result, 'build')).toMatchObject({ status: 'failed' })
		expect(stepOf(result, 'build')?.error ?? '').toContain('gave up waiting')
		expect(aws.calls).toContain(`stopBuild ${BUILD_ID}`)
	})

	test('a rolled-back deployment fails the run, and nothing is stopped after the update', async () => {
		const aws = new FakeAws()
		aws.rollout = ['rollback_in_progress', 'rollback_successful']
		const result = await deploy(aws, new Recorder())
		expect(result.status).toBe('failed')
		expect(stepOf(result, 'rollout')).toMatchObject({ status: 'failed' })
		expect(aws.calls.some((call) => call.startsWith('stopBuild'))).toBe(false)
		expect(result.checkpoint).toMatchObject({ serviceUpdateRequested: true, deploymentArn: DEPLOYMENT })
	})

	test('a run handed no Service Connect namespace fails its update before it records the submission', async () => {
		const aws = new FakeAws()
		const result = await deploy(aws, new Recorder(), { serviceConnect: null })
		expect(stepOf(result, 'update')).toMatchObject({ status: 'failed', error: 'aws: the deploy has no Service Connect namespace for its service' })
		expect(aws.calls.some((call) => call.startsWith('updateService') || call.startsWith('createService'))).toBe(false)
		expect(result.checkpoint).not.toHaveProperty('serviceUpdateRequested')
	})

	test('a dry run calls nothing', async () => {
		const aws = new FakeAws()
		const events = new Recorder()
		const result = await deploy(aws, events, { dryRun: true })
		expect(result.status).toBe('succeeded')
		expect(aws.calls).toEqual([])
		expect(events.checkpoints).toEqual([])
		expect(events.lines).toContain('  dry run: would build and push the image')
	})
})
