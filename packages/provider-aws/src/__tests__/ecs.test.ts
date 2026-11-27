// The ECS client against the fake endpoint: the task definition it registers, the service it creates and updates with the circuit
// breaker, the service it reads back, and that a value of another form, a missing answer or a state ECS may add later is
// refused rather than guessed.

import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { ecsClient, type EcsContainer, ecsPlatformTasks, type EcsService, type EcsServiceCreate, type EcsTaskDefinition } from '../aws/ecs'
import { AwsError, ECS } from '../aws/json'
import type { AwsFunction } from '../aws/lambda'
import { awsError, fakeAws } from './helpers/fake-aws'

/** A task runner that answers `answer` to every invocation, read with the caller's schema, and records what it was asked. */
function fakeRunner(answer: unknown): { readonly runner: AwsFunction; readonly inputs: unknown[] } {
	const inputs: unknown[] = []
	const runner: AwsFunction = {
		async invoke<T>(input: Readonly<Record<string, unknown>>, schema: z.ZodType<T>): Promise<T> {
			inputs.push(input)
			const read = schema.safeParse(answer)
			if (!read.success) throw new AwsError('Invoke', 'invalid_answer', 200, null, false)
			return read.data
		},
	}
	return { runner, inputs }
}

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
	network: null,
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
const serviceNetwork = { subnets: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'], securityGroups: ['sg-0123456789abcdef0'], publicIp: true }
const awsvpc = {
	awsvpcConfiguration: {
		subnets: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'],
		securityGroups: ['sg-0123456789abcdef0'],
		assignPublicIp: 'ENABLED',
	},
}
const connect = {
	namespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-abcdefghij123456',
	discoveryName: 'e5-notes-prod',
	port: 3000,
}
const connectBody = {
	enabled: true,
	namespace: connect.namespaceArn,
	services: [{ portName: 'http', discoveryName: 'e5-notes-prod', clientAliases: [{ port: 3000, dnsName: 'e5-notes-prod' }] }],
}
const create = {
	serviceConnect: connect,
	...address,
	taskDefinitionArn: TASK_DEFINITION,
	network: serviceNetwork,
	desiredCount: 1,
	clientToken: '0f1e2d3c-4b5a-4968-8776-655443322110',
	tags: { 'fabrika:app': 'notes' },
}
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
							portMappings: [{ name: 'http', containerPort: 3000, protocol: 'tcp' }],
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

	test('a definition that names X86_64 runs on it, and a Service Connect client publishes no service', async () => {
		const registered = fakeAws(ECS, {
			RegisterTaskDefinition: () => ({ taskDefinition: { taskDefinitionArn: TASK_DEFINITION, family: 'notes-prod', revision: 42 } }),
		})
		await ecsClient(registered.options).registerTaskDefinition({ ...definition, architecture: 'X86_64' })
		expect(registered.calls[0]?.body).toMatchObject({ runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' } })

		const client = { namespaceArn: connect.namespaceArn }
		const updated = fakeAws(ECS, { UpdateService: () => ({ service }) })
		await ecsClient(updated.options).updateService(address, TASK_DEFINITION, serviceNetwork, client)
		expect(updated.calls[0]?.body).toMatchObject({ serviceConnectConfiguration: { enabled: true, namespace: connect.namespaceArn } })
		expect(updated.calls[0]?.body).not.toHaveProperty('serviceConnectConfiguration.services')
		const created = fakeAws(ECS, { CreateService: () => ({ service }) })
		await ecsClient(created.options).createService({ ...create, serviceConnect: client })
		expect(created.calls[0]?.body).toMatchObject({ serviceConnectConfiguration: { enabled: true, namespace: connect.namespaceArn } })
		expect(created.calls[0]?.body).not.toHaveProperty('serviceConnectConfiguration.services')
		// A client's namespace is checked as a server's is.
		await expect(ecsClient(updated.options).updateService(address, TASK_DEFINITION, serviceNetwork, { namespaceArn: 'ns-1' })).rejects.toThrow(
			'the Service Connect namespace',
		)
	})

	test('a client with a balancer target registers its tasks in the target group on create and on every update; one of another form is refused unsent', async () => {
		const targetGroupArn = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/fabri-Proxy-1A2B3C4D/0123456789abcdef'
		const client = { namespaceArn: connect.namespaceArn, balancer: { targetGroupArn, container: 'proxy', port: 8080 } }
		const balanced = { loadBalancers: [{ targetGroupArn, containerName: 'proxy', containerPort: 8080 }], healthCheckGracePeriodSeconds: 60 }
		const created = fakeAws(ECS, { CreateService: () => ({ service }) })
		await ecsClient(created.options).createService({ ...create, serviceConnect: client })
		expect(created.calls[0]?.body).toMatchObject(balanced)
		const updated = fakeAws(ECS, { UpdateService: () => ({ service }) })
		await ecsClient(updated.options).updateService(address, TASK_DEFINITION, serviceNetwork, client)
		expect(updated.calls[0]?.body).toMatchObject(balanced)
		// A service with no balancer target is sent none, so an update never drops one set out of band.
		await ecsClient(updated.options).updateService(address, TASK_DEFINITION, serviceNetwork, { namespaceArn: connect.namespaceArn })
		expect(updated.calls[1]?.body).not.toHaveProperty('loadBalancers')

		const refused = fakeAws(ECS, {})
		for (
			const [balancer, field] of [
				[{ targetGroupArn: 'arn:aws:s3:::bucket', container: 'proxy', port: 8080 }, 'the target group'],
				[{ targetGroupArn, container: 'a proxy', port: 8080 }, 'the balanced container'],
				[{ targetGroupArn, container: 'proxy', port: 0 }, 'the balanced port'],
			] satisfies [{ targetGroupArn: string; container: string; port: number }, string][]
		) {
			await expect(ecsClient(refused.options).createService({ ...create, serviceConnect: { namespaceArn: connect.namespaceArn, balancer } })).rejects
				.toThrow(field)
		}
		expect(refused.calls).toEqual([])
	})

	test('updates the service to the revision in the network with the circuit breaker on and ECS Exec off, and reads the service it answers', async () => {
		const { options, calls } = fakeAws(ECS, { UpdateService: () => ({ service }) })
		expect(await ecsClient(options).updateService(address, TASK_DEFINITION, serviceNetwork, connect)).toEqual(read)
		expect(calls[0]?.body).toEqual({
			cluster: 'fabrika-apps',
			service: 'notes-prod',
			taskDefinition: TASK_DEFINITION,
			deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true }, maximumPercent: 200, minimumHealthyPercent: 100 },
			networkConfiguration: awsvpc,
			serviceConnectConfiguration: connectBody,
			enableExecuteCommand: false,
		})
	})

	test('an update answered for another service or another revision is an invalid answer', async () => {
		for (const change of [{ serviceName: 'other' }, { taskDefinition: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:41' }]) {
			const { options } = fakeAws(ECS, { UpdateService: () => ({ service: { ...service, ...change } }) })
			await expect(ecsClient(options).updateService(address, TASK_DEFINITION, serviceNetwork, connect)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
	})

	test('creates a Fargate service on the revision in the network, under its client token, with no ECS Exec', async () => {
		const { options, calls } = fakeAws(ECS, { CreateService: () => ({ service }) })
		expect(await ecsClient(options).createService(create)).toEqual(read)
		expect(calls[0]?.body).toEqual({
			cluster: 'fabrika-apps',
			serviceName: 'notes-prod',
			taskDefinition: TASK_DEFINITION,
			desiredCount: 1,
			launchType: 'FARGATE',
			platformVersion: 'LATEST',
			schedulingStrategy: 'REPLICA',
			deploymentController: { type: 'ECS' },
			deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true }, maximumPercent: 200, minimumHealthyPercent: 100 },
			networkConfiguration: awsvpc,
			serviceConnectConfiguration: connectBody,
			clientToken: '0f1e2d3c-4b5a-4968-8776-655443322110',
			enableExecuteCommand: false,
			enableECSManagedTags: true,
			propagateTags: 'SERVICE',
			tags: [{ key: 'fabrika:app', value: 'notes' }],
		})
	})

	test('a create answered for another service or another revision is an invalid answer; one of another form is refused unsent', async () => {
		for (const change of [{ serviceName: 'other' }, { taskDefinition: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:41' }]) {
			const { options } = fakeAws(ECS, { CreateService: () => ({ service: { ...service, ...change } }) })
			await expect(ecsClient(options).createService(create)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
		const refused = fakeAws(ECS, {})
		const client = ecsClient(refused.options)
		const refusals: [Partial<EcsServiceCreate>, string][] = [
			[{ clientToken: 'x'.repeat(37) }, 'the client token'],
			[{ desiredCount: -1 }, 'the desired count'],
			[{ desiredCount: 1.5 }, 'the desired count'],
			[{ network: { ...serviceNetwork, subnets: [] } }, 'the subnets'],
			[{ network: { ...serviceNetwork, securityGroups: Array.from({ length: 6 }, () => 'sg-0123456789abcdef0') } }, 'the security groups'],
			[{ tags: { 'aws:x': 'y' } }, 'a tag'],
			[{ service: 'a/b' }, 'the service name'],
			[{ serviceConnect: { ...connect, namespaceArn: 'arn:aws:s3:::bucket' } }, 'the Service Connect namespace'],
			[{ serviceConnect: { ...connect, discoveryName: 'notes_prod' } }, 'the discovery name'],
			[{ serviceConnect: { ...connect, discoveryName: 'e5-notes-' } }, 'the discovery name'],
			[{ serviceConnect: { ...connect, port: 0 } }, 'the Service Connect port'],
		]
		for (const [change, message] of refusals) await expect(client.createService({ ...create, ...change })).rejects.toThrow(message)
		expect(refused.calls).toEqual([])
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

	test("reads the service's awsvpc network, which a one-off task reuses", async () => {
		const networked = {
			...service,
			networkConfiguration: {
				awsvpcConfiguration: { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'], assignPublicIp: 'DISABLED' },
			},
		}
		const { options } = fakeAws(ECS, { DescribeServices: () => ({ services: [networked] }) })
		expect((await ecsClient(options).describeService(address))?.network).toEqual({
			subnets: ['subnet-0123456789abcdef0'],
			securityGroups: ['sg-0123456789abcdef0'],
			publicIp: false,
		})
		// A small installation's network gives each task a public address, and a one-off task takes the same.
		const exposed = {
			...networked,
			networkConfiguration: { awsvpcConfiguration: { subnets: ['subnet-0123456789abcdef0'], assignPublicIp: 'ENABLED' } },
		}
		const publicNetwork = fakeAws(ECS, { DescribeServices: () => ({ services: [exposed] }) })
		expect((await ecsClient(publicNetwork.options).describeService(address))?.network).toEqual({
			subnets: ['subnet-0123456789abcdef0'],
			securityGroups: [],
			publicIp: true,
		})
	})

	test('runs one task of a revision with one command overridden through the task runner, never RunTask itself, and reads it back', async () => {
		const TASK = `arn:aws:ecs:eu-central-1:123456789012:task/fabrika-apps/${'a'.repeat(32)}`
		const network = { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'], publicIp: false }
		const placed = fakeRunner({ tasks: [{ taskArn: TASK, lastStatus: 'PROVISIONING', containers: [{ name: 'init' }] }], failures: [] })
		const { options, calls } = fakeAws(ECS, {
			DescribeTasks: () => ({
				tasks: [{
					taskArn: TASK,
					lastStatus: 'STOPPED',
					stopCode: 'EssentialContainerExited',
					stoppedReason: 'Essential container in task exited',
					containers: [{ name: 'init', exitCode: 0, reason: 'x'.repeat(400) }],
				}],
			}),
		})
		const ecs = ecsClient(options, placed.runner)
		const start = {
			cluster: 'fabrika-apps',
			taskDefinitionArn: TASK_DEFINITION,
			container: 'init',
			command: ['sh', '/app/fabrika/migrate.generated.sh'],
			network,
			clientToken: 'token-init-1',
			startedBy: 'fabrika-run-token',
		}
		expect(await ecs.runTask(start)).toEqual({ arn: TASK, status: 'pending', exitCode: null, stopCode: null, reason: null })
		// The runner is asked for the revision, the command, the groups and the tokens; the cluster and the subnets are its own.
		expect(placed.inputs).toEqual([{
			taskDefinition: TASK_DEFINITION,
			container: 'init',
			command: ['sh', '/app/fabrika/migrate.generated.sh'],
			securityGroups: network.securityGroups,
			publicIp: false,
			clientToken: 'token-init-1',
			startedBy: 'fabrika-run-token',
		}])
		// ECS itself is never asked to run a task.
		expect(calls.some((call) => JSON.stringify(call).includes('RunTask'))).toBe(false)
		// Both reasons, each cut at 300 characters.
		expect(await ecs.describeTask('fabrika-apps', TASK, 'init')).toEqual({
			arn: TASK,
			status: 'stopped',
			exitCode: 0,
			stopCode: 'EssentialContainerExited',
			reason: `Essential container in task exited; ${'x'.repeat(300)}`,
		})
		expect(calls[0]?.body).toEqual({ cluster: 'fabrika-apps', tasks: [TASK] })
		// A service with public addresses gives its one-off tasks one too.
		const exposed = fakeRunner({ tasks: [{ taskArn: TASK, lastStatus: 'PENDING' }] })
		await ecsClient(options, exposed.runner).runTask({ ...start, network: { ...network, publicIp: true } })
		expect(JSON.stringify(exposed.inputs[0])).toContain('"publicIp":true')

		const unplaced = fakeRunner({ tasks: [], failures: [{ arn: TASK_DEFINITION, reason: 'RESOURCE:MEMORY' }] })
		await expect(ecsClient(options, unplaced.runner).runTask(start)).rejects.toMatchObject({ code: 'task_not_started' })
		// Without a runner, no task is started at all.
		await expect(ecsClient(options).runTask(start)).rejects.toMatchObject({ code: 'no_task_runner' })
		const missing = fakeAws(ECS, { DescribeTasks: () => ({ tasks: [], failures: [{ arn: TASK, reason: 'MISSING' }] }) })
		expect(await ecsClient(missing.options).describeTask('fabrika-apps', TASK, 'init')).toBeNull()
		// A state ECS may add later, or a stopped task without the container it ran, is no answer.
		for (
			const task of [{ taskArn: TASK, lastStatus: 'PAUSED' }, { taskArn: TASK, lastStatus: 'STOPPED', containers: [{ name: 'other', exitCode: 0 }] }]
		) {
			const odd = fakeAws(ECS, { DescribeTasks: () => ({ tasks: [task] }) })
			await expect(ecsClient(odd.options).describeTask('fabrika-apps', TASK, 'init')).rejects.toMatchObject({ code: 'invalid_answer' })
		}
		const refused = fakeAws(ECS, {})
		const unasked = fakeRunner({ tasks: [] })
		const client = ecsClient(refused.options, unasked.runner)
		for (
			const change of [
				{ clientToken: 'x'.repeat(65) },
				{ startedBy: 'has space' },
				{ command: [] },
				{ network: { subnets: [], securityGroups: [], publicIp: false } },
				{ network: { subnets: ['subnet-x'], securityGroups: [], publicIp: false } },
			]
		) {
			await expect(client.runTask({ ...start, ...change })).rejects.toThrow('ECS')
		}
		await expect(client.describeTask('fabrika-apps', 'not-an-arn', 'init')).rejects.toThrow('the task')
		expect(refused.calls).toEqual([])
		expect(unasked.inputs).toEqual([])
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
		await expect(ecs.updateService({ cluster: 'a/b', service: 'notes' }, TASK_DEFINITION, serviceNetwork, connect)).rejects.toThrow('the cluster name')
		await expect(ecs.updateService(address, 'notes-prod:42', serviceNetwork, connect)).rejects.toThrow('the task definition')
		await expect(ecs.describeService({ cluster: 'fabrika-apps', service: '' })).rejects.toThrow('the service name')
		expect(calls).toEqual([])
	})
})

describe("ecsPlatformTasks, the operator's own", () => {
	const TASK = `arn:aws:ecs:eu-central-1:123456789012:task/fabrika-platform/${'b'.repeat(32)}`
	const start = {
		cluster: 'fabrika-platform',
		taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/fabrika_platform_setup:3',
		container: 'setup',
		network: { subnets: ['subnet-0123456789abcdef4'], securityGroups: ['sg-0123456789abcdef5', 'sg-0123456789abcdef6'], publicIp: true },
		clientToken: '0190a000-0000-7000-8000-000000000000',
		startedBy: 'fabrika-platform-setup',
	}

	test('starts the task by RunTask itself, in the cluster and network it names, its command as defined', async () => {
		const { options, calls } = fakeAws(ECS, { RunTask: () => ({ tasks: [{ taskArn: TASK, lastStatus: 'PROVISIONING' }] }) })
		expect(await ecsPlatformTasks(options).runTask(start)).toEqual({ arn: TASK, status: 'pending', exitCode: null, stopCode: null, reason: null })
		expect(calls).toEqual([{
			operation: 'RunTask',
			target: 'AmazonEC2ContainerServiceV20141113.RunTask',
			body: {
				cluster: 'fabrika-platform',
				taskDefinition: start.taskDefinitionArn,
				launchType: 'FARGATE',
				count: 1,
				networkConfiguration: {
					awsvpcConfiguration: { subnets: start.network.subnets, securityGroups: start.network.securityGroups, assignPublicIp: 'ENABLED' },
				},
				clientToken: start.clientToken,
				startedBy: 'fabrika-platform-setup',
			},
		}])
	})

	test('a task ECS could not place, or an answer of another form, is an error; a value of another form is never sent', async () => {
		const unplaced = fakeAws(ECS, { RunTask: () => ({ tasks: [], failures: [{ reason: 'RESOURCE:MEMORY' }] }) })
		await expect(ecsPlatformTasks(unplaced.options).runTask(start)).rejects.toMatchObject({ code: 'task_not_started' })
		const two = fakeAws(ECS, { RunTask: () => ({ tasks: [{ taskArn: TASK, lastStatus: 'PENDING' }, { taskArn: TASK, lastStatus: 'PENDING' }] }) })
		await expect(ecsPlatformTasks(two.options).runTask(start)).rejects.toMatchObject({ code: 'invalid_answer' })
		const { options, calls } = fakeAws(ECS, {})
		const tasks = ecsPlatformTasks(options)
		await expect(tasks.runTask({ ...start, taskDefinitionArn: 'fabrika_platform_setup' })).rejects.toThrow('the task definition')
		await expect(tasks.runTask({ ...start, network: { ...start.network, subnets: [] } })).rejects.toThrow('the subnets')
		await expect(tasks.runTask({ ...start, clientToken: 'a token' })).rejects.toThrow('the client token')
		expect(calls).toEqual([])
	})

	test('reads the task back as the deploy does', async () => {
		const { options } = fakeAws(ECS, {
			DescribeTasks: () => ({
				tasks: [{ taskArn: TASK, lastStatus: 'STOPPED', stopCode: 'EssentialContainerExited', containers: [{ name: 'setup', exitCode: 0 }] }],
			}),
		})
		expect(await ecsPlatformTasks(options).describeTask('fabrika-platform', TASK, 'setup')).toMatchObject({ status: 'stopped', exitCode: 0 })
	})

	test('lists the tasks a starter left running, on one page alone', async () => {
		const { options, calls } = fakeAws(ECS, { ListTasks: () => ({ taskArns: [TASK] }) })
		expect(await ecsPlatformTasks(options).listRunningTasks('fabrika-platform', 'fabrika-platform-setup')).toEqual([TASK])
		expect(calls[0]?.body).toEqual({ cluster: 'fabrika-platform', startedBy: 'fabrika-platform-setup', desiredStatus: 'RUNNING', maxResults: 100 })
		const paged = fakeAws(ECS, { ListTasks: () => ({ taskArns: [TASK], nextToken: 'more' }) })
		await expect(ecsPlatformTasks(paged.options).listRunningTasks('fabrika-platform', 'fabrika-platform-setup')).rejects.toMatchObject({
			code: 'too_many_tasks',
		})
	})

	test("reads a service's creation and deployments, and redeploys its own revision", async () => {
		const { options, calls } = fakeAws(ECS, {
			DescribeServices: () => ({
				services: [{
					serviceName: 'fabrika-platform-iam',
					status: 'ACTIVE',
					createdAt: 1_790_000_000,
					deployments: [{ id: 'ecs-svc/1', status: 'PRIMARY', createdAt: 1_790_000_060.5, rolloutState: 'COMPLETED' }],
				}],
			}),
			UpdateService: () => ({ service: { serviceName: 'fabrika-platform-iam' } }),
		})
		const tasks = ecsPlatformTasks(options)
		expect(await tasks.describeService('fabrika-platform', 'fabrika-platform-iam')).toEqual({
			createdAt: new Date(1_790_000_000_000),
			deployments: [{ id: 'ecs-svc/1', status: 'primary', createdAt: new Date(1_790_000_060_500), rolloutState: 'completed' }],
		})
		await tasks.redeployService('fabrika-platform', 'fabrika-platform-iam')
		expect(calls[1]?.body).toEqual({ cluster: 'fabrika-platform', service: 'fabrika-platform-iam', forceNewDeployment: true })
		const missing = fakeAws(ECS, { DescribeServices: () => ({ services: [], failures: [{ reason: 'MISSING' }] }) })
		expect(await ecsPlatformTasks(missing.options).describeService('fabrika-platform', 'fabrika-platform-iam')).toBeNull()
		const odd = fakeAws(ECS, {
			DescribeServices: () => ({
				services: [{ serviceName: 'fabrika-platform-iam', status: 'ACTIVE', createdAt: 1, deployments: [{ id: 'x', status: 'NEW', createdAt: 1 }] }],
			}),
		})
		await expect(ecsPlatformTasks(odd.options).describeService('fabrika-platform', 'fabrika-platform-iam')).rejects.toMatchObject({
			code: 'invalid_answer',
		})
	})
})
