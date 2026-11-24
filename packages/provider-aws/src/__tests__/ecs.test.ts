// The ECS client against the fake endpoint: the task definition it registers, the service update with the circuit
// breaker, the service it reads back, and that a value of another form, a missing answer or a state ECS may add later is
// refused rather than guessed.

import { describe, expect, test } from 'bun:test'
import { ecsClient, type EcsContainer, type EcsService, type EcsTaskDefinition } from '../aws/ecs'
import { ECS } from '../aws/json'
import { awsError, fakeAws } from './helpers/fake-aws'

const IMAGE = `123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/notes-prod@sha256:${'a'.repeat(64)}`
const TASK_DEFINITION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:42'
const DEPLOYMENT = 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/notes-prod/r2ZTbPmlNM0uqVbg2nTT4'
const log = { group: '/fabrika/apps/notes-prod', region: 'eu-central-1', streamPrefix: 'notes' }
const health = { command: ['CMD', 'bun', 'fabrika/health.ts'], intervalSeconds: 10, timeoutSeconds: 5, retries: 3, startPeriodSeconds: 30 }
const server: EcsContainer = {
	name: 'server',
	image: IMAGE,
	essential: true,
	port: 3000,
	environment: { FABRIKA_APP_ID: 'notes' },
	secrets: { FABRIKA_TOKEN_KEYS: 'arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/main/apps/notes/prod/FABRIKA_TOKEN_KEYS' },
	healthCheck: health,
	dependsOn: [{ container: 'migrate', condition: 'SUCCESS' }],
	log,
}
const migrate: EcsContainer = { name: 'migrate', image: IMAGE, essential: false, command: ['sh', 'fabrika/migrate.generated.sh'], log }
const definition: EcsTaskDefinition = {
	family: 'notes-prod',
	taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika-apps-notes-prod',
	// The application environment's own execution role, never one shared by applications.
	executionRoleArn: 'arn:aws:iam::123456789012:role/fabrika-apps-notes-prod-execution',
	cpu: 512,
	memory: 1024,
	containers: [migrate, server],
	tags: { 'fabrika:app': 'notes' },
}
const service = {
	serviceName: 'notes-prod',
	serviceArn: 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/notes-prod',
	status: 'ACTIVE',
	taskDefinition: TASK_DEFINITION,
	deployments: [
		{ id: 'ecs-svc/1', status: 'PRIMARY', taskDefinition: TASK_DEFINITION, rolloutState: 'IN_PROGRESS', runningCount: 0, desiredCount: 1 },
		{
			id: 'ecs-svc/0',
			status: 'ACTIVE',
			taskDefinition: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:41',
			rolloutState: 'COMPLETED',
			runningCount: 1,
			desiredCount: 1,
			failedTasks: 2,
		},
	],
	events: [{ id: 'e-1', createdAt: 1_768_478_400.25, message: '(service notes-prod) has started 1 tasks.' }],
	currentServiceDeployment: DEPLOYMENT,
}
const read: EcsService = {
	name: 'notes-prod',
	arn: service.serviceArn,
	status: 'active',
	taskDefinitionArn: TASK_DEFINITION,
	deployments: [
		{
			id: 'ecs-svc/1',
			status: 'primary',
			taskDefinitionArn: TASK_DEFINITION,
			rolloutState: 'in_progress',
			runningCount: 0,
			desiredCount: 1,
			failedTasks: 0,
		},
		{
			id: 'ecs-svc/0',
			status: 'active',
			taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:41',
			rolloutState: 'completed',
			runningCount: 1,
			desiredCount: 1,
			failedTasks: 2,
		},
	],
	currentDeploymentArn: DEPLOYMENT,
	events: [{ id: 'e-1', at: new Date(1_768_478_400_250), message: '(service notes-prod) has started 1 tasks.' }],
}
const address = { cluster: 'fabrika-apps', service: 'notes-prod' }
const REVISION = 'arn:aws:ecs:eu-central-1:123456789012:service-revision/fabrika-apps/notes-prod/4980306466373577095'

describe('ecsClient', () => {
	test('registers a Fargate ARM64 task definition with the image by digest and secrets by reference', async () => {
		const { options, calls } = fakeAws(ECS, {
			RegisterTaskDefinition: () => ({ taskDefinition: { taskDefinitionArn: TASK_DEFINITION, family: 'notes-prod', revision: 42 } }),
		})
		expect(await ecsClient(options).registerTaskDefinition(definition)).toEqual({ arn: TASK_DEFINITION, family: 'notes-prod', revision: 42 })
		const awslogs = {
			logDriver: 'awslogs',
			options: { 'awslogs-group': log.group, 'awslogs-region': log.region, 'awslogs-stream-prefix': log.streamPrefix },
		}
		expect(calls).toEqual([
			{
				operation: 'RegisterTaskDefinition',
				target: 'AmazonEC2ContainerServiceV20141113.RegisterTaskDefinition',
				body: {
					family: 'notes-prod',
					taskRoleArn: definition.taskRoleArn,
					executionRoleArn: definition.executionRoleArn,
					networkMode: 'awsvpc',
					requiresCompatibilities: ['FARGATE'],
					cpu: '512',
					memory: '1024',
					runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
					containerDefinitions: [
						{
							name: 'migrate',
							image: IMAGE,
							essential: false,
							command: ['sh', 'fabrika/migrate.generated.sh'],
							environment: [],
							secrets: [],
							logConfiguration: awslogs,
						},
						{
							name: 'server',
							image: IMAGE,
							essential: true,
							portMappings: [{ containerPort: 3000, protocol: 'tcp' }],
							environment: [{ name: 'FABRIKA_APP_ID', value: 'notes' }],
							secrets: [{ name: 'FABRIKA_TOKEN_KEYS', valueFrom: server.secrets?.['FABRIKA_TOKEN_KEYS'] }],
							healthCheck: { command: ['CMD', 'bun', 'fabrika/health.ts'], interval: 10, timeout: 5, retries: 3, startPeriod: 30 },
							dependsOn: [{ containerName: 'migrate', condition: 'SUCCESS' }],
							logConfiguration: awslogs,
						},
					],
					tags: [{ key: 'fabrika:app', value: 'notes' }],
				},
			},
		])
	})

	test('a registration answered for another family is an invalid answer', async () => {
		const { options } = fakeAws(ECS, {
			RegisterTaskDefinition: () => ({
				taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/other:1', family: 'other', revision: 1 },
			}),
		})
		await expect(ecsClient(options).registerTaskDefinition(definition)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('updates the service to the revision with the circuit breaker on, and reads the service it answers', async () => {
		const { options, calls } = fakeAws(ECS, { UpdateService: () => ({ service }) })
		expect(await ecsClient(options).updateService(address, TASK_DEFINITION)).toEqual(read)
		expect(calls[0]?.body).toEqual({
			cluster: 'fabrika-apps',
			service: 'notes-prod',
			taskDefinition: TASK_DEFINITION,
			deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true } },
		})
	})

	test('an update answered for another service or another revision is an invalid answer', async () => {
		for (const change of [{ serviceName: 'other' }, { taskDefinition: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:41' }]) {
			const { options } = fakeAws(ECS, { UpdateService: () => ({ service: { ...service, ...change } }) })
			await expect(ecsClient(options).updateService(address, TASK_DEFINITION)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
	})

	test('describes a service, answers null only for MISSING, and refuses any other empty answer', async () => {
		const found = fakeAws(ECS, { DescribeServices: () => ({ services: [service], failures: [] }) })
		expect(await ecsClient(found.options).describeService(address)).toEqual(read)
		expect(found.calls[0]?.body).toEqual({ cluster: 'fabrika-apps', services: ['notes-prod'] })
		const missing = fakeAws(ECS, { DescribeServices: () => ({ services: [], failures: [{ arn: 'x', reason: 'MISSING' }] }) })
		expect(await ecsClient(missing.options).describeService(address)).toBeNull()
		const empty = fakeAws(ECS, { DescribeServices: () => ({ services: [], failures: [] }) })
		await expect(ecsClient(empty.options).describeService(address)).rejects.toMatchObject({ code: 'invalid_answer' })
		const cluster = fakeAws(ECS, { DescribeServices: () => awsError('ClusterNotFoundException') })
		await expect(ecsClient(cluster.options).describeService(address)).rejects.toMatchObject({ code: 'ClusterNotFoundException' })
	})

	test('describes a service deployment and its revision, and answers null only for an explicit MISSING', async () => {
		const deployment = {
			serviceDeploymentArn: DEPLOYMENT,
			serviceArn: service.serviceArn,
			status: 'ROLLBACK_SUCCESSFUL',
			statusReason: 'ECS deployment circuit breaker: tasks failed to start.',
			targetServiceRevision: { arn: REVISION, runningTaskCount: 0 },
			createdAt: 1_768_478_400.5,
		}
		const { options, calls } = fakeAws(ECS, {
			DescribeServiceDeployments: () => ({ serviceDeployments: [deployment], failures: [] }),
			DescribeServiceRevisions: () => ({ serviceRevisions: [{ serviceRevisionArn: REVISION, taskDefinition: TASK_DEFINITION }], failures: [] }),
		})
		const ecs = ecsClient(options)
		expect(await ecs.describeServiceDeployment(DEPLOYMENT)).toEqual({
			arn: DEPLOYMENT,
			serviceArn: service.serviceArn,
			status: 'rollback_successful',
			statusReason: 'ECS deployment circuit breaker: tasks failed to start.',
			targetRevisionArn: REVISION,
		})
		expect(await ecs.describeServiceRevision(REVISION)).toEqual({ arn: REVISION, taskDefinitionArn: TASK_DEFINITION })
		expect(calls.map((call) => call.body)).toEqual([{ serviceDeploymentArns: [DEPLOYMENT] }, { serviceRevisionArns: [REVISION] }])

		const missing = fakeAws(ECS, {
			DescribeServiceDeployments: () => ({ serviceDeployments: [], failures: [{ arn: DEPLOYMENT, reason: 'MISSING' }] }),
			// An answer that leaves the empty list out still reaches the MISSING.
			DescribeServiceRevisions: () => ({ failures: [{ arn: REVISION, reason: 'MISSING' }] }),
		})
		expect(await ecsClient(missing.options).describeServiceDeployment(DEPLOYMENT)).toBeNull()
		expect(await ecsClient(missing.options).describeServiceRevision(REVISION)).toBeNull()

		// A MISSING for another ARN, an empty answer and a state ECS may add later are no answer.
		for (
			const answer of [
				{ serviceDeployments: [], failures: [{ arn: 'other', reason: 'MISSING' }] },
				{ serviceDeployments: [] },
				{ serviceDeployments: [{ ...deployment, status: 'PAUSED' }] },
			]
		) {
			const odd = fakeAws(ECS, { DescribeServiceDeployments: () => answer })
			await expect(ecsClient(odd.options).describeServiceDeployment(DEPLOYMENT)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
		await expect(ecs.describeServiceDeployment('ecs-svc/1')).rejects.toThrow('the service deployment')
		await expect(ecs.describeServiceRevision(DEPLOYMENT)).rejects.toThrow('the service revision')
	})

	test('a state ECS may add later is an invalid answer, never a guess', async () => {
		for (const change of [{ status: 'PAUSED' }, { deployments: [{ ...service.deployments[0], rolloutState: 'PAUSED' }] }]) {
			const { options } = fakeAws(ECS, { DescribeServices: () => ({ services: [{ ...service, ...change }] }) })
			await expect(ecsClient(options).describeService(address)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
	})

	test('refuses a value of another form before anything is sent', async () => {
		const { options, calls } = fakeAws(ECS, {})
		const ecs = ecsClient(options)
		const refusals: readonly [Partial<EcsTaskDefinition>, string][] = [
			[{ family: 'notes prod' }, 'the family'],
			[{ taskRoleArn: 'arn:aws:iam::123:role/x' }, 'a role'],
			// The task role is the execution role, also under another path or letter case.
			[{ taskRoleArn: definition.executionRoleArn }, 'the task role'],
			[{ taskRoleArn: 'arn:aws:iam::123456789012:role/apps/Fabrika-Apps-Notes-Prod-Execution' }, 'the task role'],
			[{ containers: [{ ...server, secrets: { KEY: 'arn:aws:ssm:eu-central-1:123456789012:parameter//fabrika/KEY' } }, migrate] }, 'a secret reference'],
			[{ containers: [{ ...server, secrets: { KEY: 'arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/KEY/' } }, migrate] }, 'a secret reference'],
			[{ containers: [{ ...server, healthCheck: { ...health, command: ['bun', 'fabrika/health.ts'] } }, migrate] }, 'the health check'],
			[{ containers: [{ ...server, healthCheck: { ...health, command: ['CMD'] } }, migrate] }, 'the health check'],
			// A container waited on for HEALTHY must have a health check.
			[{ containers: [server, migrate, { ...migrate, name: 'worker', dependsOn: [{ container: 'migrate', condition: 'HEALTHY' }] }] }, 'a dependency'],
			[{ cpu: 300 }, 'the CPU'],
			[{ memory: 256 }, 'the memory'],
			[{ containers: [] }, 'the containers'],
			[{ containers: [server, server] }, 'the containers'],
			[{ containers: [{ ...migrate, essential: false }] }, 'the containers'],
			[{ containers: [{ ...server, image: IMAGE.replace(/@sha256:.*/, ':latest') }, migrate] }, 'an image (by digest)'],
			[{ containers: [{ ...server, secrets: { KEY: 'plain-value' } }, migrate] }, 'a secret reference'],
			[
				{ containers: [{ ...server, environment: { KEY: 'a' }, secrets: { KEY: server.secrets?.['FABRIKA_TOKEN_KEYS'] ?? '' } }, migrate] },
				'a variable name',
			],
			[{ containers: [{ ...server, dependsOn: [{ container: 'absent', condition: 'START' }] }, migrate] }, 'a dependency'],
			// A container waited on for SUCCESS must be allowed to exit.
			[{ containers: [server, { ...migrate, essential: true }] }, 'a dependency'],
			[{ containers: [{ ...server, port: 70_000 }, migrate] }, 'a port'],
			[{ containers: [{ ...server, log: { ...log, region: 'Frankfurt' } }, migrate] }, 'the log'],
			[{ tags: { 'AWS:x': 'y' } }, 'a tag'],
		]
		for (const [change, message] of refusals) await expect(ecs.registerTaskDefinition({ ...definition, ...change })).rejects.toThrow(message)
		await expect(ecs.updateService({ cluster: 'a/b', service: 'notes' }, TASK_DEFINITION)).rejects.toThrow('the cluster name')
		await expect(ecs.updateService(address, 'notes-prod:42')).rejects.toThrow('the task definition')
		await expect(ecs.describeService({ cluster: 'fabrika-apps', service: '' })).rejects.toThrow('the service name')
		expect(calls).toEqual([])
	})
})
