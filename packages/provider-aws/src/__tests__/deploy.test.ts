// The deploy of one application environment over fakes of its AWS calls: every step in order with the checkpoint
// recorded before the call that needs it, the source URL's parameter written and deleted, the build's log relayed, the
// init commands run once each, a lost start found by its token, and the failures that stop the run (the build, an init
// command, the rollout) with what the shared run then does about the candidate.

import type { JsonValue, ProviderRunEvents } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { CodeBuildStatus } from '../aws/codebuild'
import type { EcsService, EcsServiceDeploymentStatus } from '../aws/ecs'
import type { S3PartWriter } from '../aws/s3'
import { AwsError } from '../aws/transport'
import { awsDeploy, type AwsDeployInput } from '../deploy'

const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const BUILD_ID = 'fabrika-apps-build:5b0c9a8e-7d6f-4e3d-9c2b-1a0f9e8d7c6b'
const REVISION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:42'
const INIT_REVISION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod-init:42'
const DEPLOYMENT = 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/notes-prod/r2ZTbPmlNM0uqVbg2nTT4'
const SERVICE_ARN = 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/notes-prod'
const REPOSITORY_URI = '123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/notes-prod'
const DIGEST = `sha256:${'a'.repeat(64)}`
const TASK = (n: number) => `arn:aws:ecs:eu-central-1:123456789012:task/fabrika-apps/${String(n).repeat(32)}`
const NETWORK = { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'], publicIp: false }

/** A fake of every AWS call the deploy makes, recording each, answering what the test sets. */
class FakeAws {
	readonly calls: string[] = []
	readonly parameters = new Map<string, string>()
	builds: CodeBuildStatus[] = ['in_progress', 'succeeded']
	exits: number[] = [0, 0]
	rollout: EcsServiceDeploymentStatus[] = ['in_progress', 'successful']
	loseStart = false
	findLost = true
	private registered = 0
	private tasks = 0

	readonly clients: AwsDeployInput['clients'] = {
		ecr: {
			ensureRepository: async (name) => {
				this.calls.push(`ensureRepository ${name}`)
				return { name, uri: REPOSITORY_URI, arn: 'arn:aws:ecr:eu-central-1:123456789012:repository/fabrika/notes-prod' }
			},
			keepNewestImages: async (name, keep) => void this.calls.push(`keepNewestImages ${name} ${keep}`),
			findImage: async (name, reference) => {
				this.calls.push(`findImage ${name} ${'tag' in reference ? reference.tag : reference.digest}`)
				return { digest: DIGEST, tags: [`run-${TOKEN}`], pushedAt: new Date() }
			},
		},
		codeBuild: {
			startBuild: async (start) => {
				this.calls.push(`startBuild ${start.token}`)
				if (this.loseStart) throw new AwsError('StartBuild', 'timeout', 0, null, true)
				return { id: BUILD_ID, status: 'in_progress', phase: 'QUEUED', log: null }
			},
			findBuild: async (project, token) => {
				this.calls.push(`findBuild ${project} ${token}`)
				return this.findLost ? { id: BUILD_ID, status: 'in_progress', phase: 'BUILD', log: null } : null
			},
			getBuild: async (id) => {
				this.calls.push(`getBuild ${id}`)
				const status = this.builds.shift() ?? 'succeeded'
				return { id, status, phase: 'BUILD', log: { group: '/aws/codebuild/fabrika-apps-build', stream: 'stream-1' } }
			},
			stopBuild: async (id) => {
				this.calls.push(`stopBuild ${id}`)
				return null
			},
		},
		ecs: {
			registerTaskDefinition: async (definition) => {
				this.calls.push(`registerTaskDefinition ${definition.family}`)
				this.registered += 1
				return { arn: this.registered === 1 ? REVISION : INIT_REVISION, family: definition.family, revision: 42 }
			},
			updateService: async (_address, taskDefinitionArn) => {
				this.calls.push(`updateService ${taskDefinitionArn}`)
				return { ...this.service(), taskDefinitionArn, currentDeploymentArn: DEPLOYMENT }
			},
			describeService: async () => {
				this.calls.push('describeService')
				return this.service()
			},
			describeServiceDeployment: async (arn) => {
				this.calls.push(`describeServiceDeployment ${arn}`)
				return {
					arn,
					serviceArn: SERVICE_ARN,
					status: this.rollout.shift() ?? 'successful',
					statusReason: 'tasks failed to start',
					targetRevisionArn: null,
				}
			},
			describeServiceRevision: async () => null,
			runTask: async (start) => {
				this.calls.push(`runTask ${start.clientToken} ${start.command.join(' ')}`)
				this.tasks += 1
				return { arn: TASK(this.tasks), status: 'pending', exitCode: null, stopCode: null, reason: null }
			},
			describeTask: async (_cluster, arn) => {
				this.calls.push(`describeTask ${arn}`)
				const index = arn === TASK(1) ? 0 : 1
				return { arn, status: 'stopped', exitCode: this.exits[index] ?? 0, stopCode: 'EssentialContainerExited', reason: null }
			},
		},
		logs: {
			readForward: async (_group, _stream, cursor) => {
				this.calls.push(`readForward ${cursor ?? 'head'}`)
				return cursor === undefined
					? { events: [{ at: new Date(), message: 'Step 1/9 : FROM oven/bun\nStep 2/9 : RUN bun install\n' }], cursor: 'f/2', atEnd: false }
					: { events: [], cursor, atEnd: true }
			},
		},
		ssm: {
			putSecret: async (name, value) => {
				this.calls.push(`putSecret ${name}`)
				this.parameters.set(name, value)
				return 1
			},
			deleteSecret: async (name) => {
				this.calls.push(`deleteSecret ${name}`)
				return this.parameters.delete(name)
			},
		},
		s3PartWriter: (address): S3PartWriter => {
			this.calls.push(`s3PartWriter ${address.bucket} ${address.key}`)
			return {
				partBytes: 8 * 1024 * 1024,
				writePart: async () => {},
				complete: async () => void this.calls.push('complete'),
				abort: async () => {},
			}
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
	log(line: string): void {
		this.lines.push(line)
	}
	async externalId(id: string, state?: JsonValue): Promise<void> {
		this.externalIdValue = id
		if (state !== undefined) this.checkpoints.push(state)
	}
	async checkpoint(state: JsonValue): Promise<void> {
		this.checkpoints.push(state)
	}
	async boundary(): Promise<void> {}
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
		clients: aws.clients,
		source: { upload: async (parts) => parts.complete({ last: new Uint8Array([1]), parts: 1, bytes: 1 }, new AbortController().signal) },
		events,
		signal: new AbortController().signal,
		dryRun: false,
		sleep: async () => {},
		newToken: () => TOKEN,
		...change,
	})

const PARAMETER = `/fabrika/main/builds/${TOKEN}/source-url`

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
			`deleteSecret ${PARAMETER}`,
			`findImage fabrika/notes-prod run-${TOKEN}`,
			'registerTaskDefinition notes-prod',
			'registerTaskDefinition notes-prod-init',
			'describeService',
			`runTask ${TOKEN}-init-1 sh /app/fabrika/migrate.generated.sh`,
			`describeTask ${TASK(1)}`,
			`runTask ${TOKEN}-init-2 sh /app/fabrika/verify.generated.sh`,
			`describeTask ${TASK(2)}`,
			`updateService ${REVISION}`,
			`describeServiceDeployment ${DEPLOYMENT}`,
			`describeServiceDeployment ${DEPLOYMENT}`,
		])
		// The source URL went to its parameter, and the parameter is gone again.
		expect(aws.parameters.size).toBe(0)
		// The build's log reached the run log.
		expect(events.lines).toContain('  │ Step 1/9 : FROM oven/bun')
		expect(events.lines).toContain('  │ Step 2/9 : RUN bun install')
	})

	test('a failed build fails the run before anything registers, and the build is stopped', async () => {
		const aws = new FakeAws()
		aws.builds = ['failed']
		const result = await deploy(aws, new Recorder())
		expect(result.status).toBe('failed')
		expect(result.steps.find((step) => step.id === 'build')).toMatchObject({ status: 'failed', error: `aws: build ${BUILD_ID} is failed` })
		expect(result.steps.slice(3).every((step) => step.status === 'skipped')).toBe(true)
		expect(aws.calls).toContain(`stopBuild ${BUILD_ID}`)
		expect(aws.calls).toContain(`deleteSecret ${PARAMETER}`)
		expect(aws.calls.some((call) => call.startsWith('updateService') || call.startsWith('registerTaskDefinition'))).toBe(false)
	})

	test('an init command that exits non-zero fails the run, and the service is never updated', async () => {
		const aws = new FakeAws()
		aws.exits = [1]
		const result = await deploy(aws, new Recorder())
		expect(result.status).toBe('failed')
		expect(result.steps.find((step) => step.id === 'init')).toMatchObject({ status: 'failed', error: 'aws: init command 1 exited 1' })
		expect(aws.calls.some((call) => call.startsWith('updateService'))).toBe(false)
		expect(aws.calls.filter((call) => call.startsWith('runTask')).length).toBe(1)
	})

	test("a start whose answer was lost is found by the run's token, never repeated", async () => {
		const aws = new FakeAws()
		aws.loseStart = true
		expect((await deploy(aws, new Recorder())).status).toBe('succeeded')
		expect(aws.calls.filter((call) => call.startsWith('startBuild')).length).toBe(1)
		expect(aws.calls).toContain(`findBuild fabrika-apps-build ${TOKEN}`)

		const none = new FakeAws()
		none.loseStart = true
		none.findLost = false
		const failed = await deploy(none, new Recorder())
		expect(failed.steps.find((step) => step.id === 'build')).toMatchObject({ status: 'failed' })
	})

	test('a rolled-back deployment fails the run, and nothing is stopped after the update', async () => {
		const aws = new FakeAws()
		aws.rollout = ['rollback_in_progress', 'rollback_successful']
		const result = await deploy(aws, new Recorder())
		expect(result.status).toBe('failed')
		expect(result.steps.find((step) => step.id === 'rollout')).toMatchObject({ status: 'failed' })
		expect(aws.calls.some((call) => call.startsWith('stopBuild'))).toBe(false)
		expect(result.checkpoint).toMatchObject({ serviceUpdateRequested: true, deploymentArn: DEPLOYMENT })
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
