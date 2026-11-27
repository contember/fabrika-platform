// The platform's services (the AWS idea's checklist, step 11, the services' step): the database setup task, from a
// stack of its own, and IAM, Control, Operations and the platform proxy in front of them, from the stack the operator
// applies last. What each task names is the runtime stack's (`runtime.ts`): its execution role, its security group,
// its log group, the platform's Service Connect namespace.
//
// - **The setup before the services, on install and on every upgrade.** The operator applies the setup stack
//   (`fabrika-platform-setup`), runs its task (`awsDatabaseSetupRun`) and only then applies the services stack. In one
//   stack the install could never finish: the services' migrations would fail on users the setup has not made, the
//   stack would roll back and take the setup's definition with it, and an upgrade would roll the services onto a new
//   release before its setup ran.
// - **Values never in the template.** Every variable a service reads is a Parameter Store SecureString under its own
//   path (`/fabrika/platform/<task>/<NAME>`), which the operator's command writes (`installation-init`'s
//   `installationServiceEnvironment` and `deployedServiceEnvironment`, and the AWS provider's own) and the task
//   definition names as a secret. The template holds the variables' names and the few fixed addresses alone. A name the
//   template sets, or the proxy image fixes, is refused: a secret would replace it.
// - **Images by digest.** Each container names its image by the digest it was pushed under (`images.ts`), never a
//   tag, which the repository's lifecycle policy can free and a later push take again.
// - **Migrations as each service starts**, as on Zerops: `migrate` then `server`, in one container. Its migration
//   runner serializes concurrent containers behind an advisory lock, so a rolling deploy's second task waits.
// - **The scheduled jobs in a container beside each service**: IAM's prune daily, Control's maintenance every five
//   minutes, Operations' maintenance every minute, as Zerops' crontab runs them. The job runs once the service is
//   healthy (its migrations done), with the service's own role and variables; each job holds its own claims and
//   locks, so the two tasks of a rolling deploy run it safely. A job container that exits stops its task, which ECS
//   replaces. Every container of the services image runs under an init process, so a task's SIGTERM reaches its
//   shell, which exits at once instead of waiting out the stop timeout. A job's pass still running then is killed with
//   the container, not signalled: it ends as a crash of the job would.
//   After `exec` the server itself is the init's child and receives the signal.
// - **The platform's network and cluster alone**: the platform's task subnets, each task's own group (IAM, Control
//   and Operations the database's client group beside it), a public address because the subnets have no NAT gateway.
// - **Service Connect without its request timeout.** An HTTP Service Connect service answers 504 for any request
//   whose whole response takes longer than 15 seconds unless it says otherwise; Zerops' private network and the
//   namespace proxies impose no such cap, and a source-map upload or a Control call that waits on GitHub can take
//   longer. Each published service turns the per-request timeout off and keeps the idle timeout at five minutes.
// - **The platform proxy** routes the three hosts on one port, by host, as a namespace proxy does, behind the
//   platform balancer's one target group; it is a Service Connect client and dials `iam:3000`, `control:3000` and
//   `operations:3000`. A task resolves only the endpoints that existed when its service deployed, so the proxy is
//   created after the three; their own cycle (IAM dials Control, which dials IAM) the operator's command closes by
//   redeploying, once, each whose tasks started before the last endpoint existed (`apply.ts`).
//
// UNVERIFIED: the resources' properties follow the CloudFormation and ECS references, and that the services image's
// Alpine base carries BusyBox's `wget` for the health checks; none was checked against an account.

import { staticEnvironment } from '@fabrika/installation-init'
import type { JsonValue } from '@fabrika/provider-contract'
import { TARGET_GROUP_ARN } from '../aws/ecs'
import type { AwsStack } from '../stack'
import { AWS_CONTROL_ROLE, AWS_PLATFORM_CLUSTER, AWS_PLATFORM_PATH } from './access'
import type { AwsBalancersOutputs } from './balancers'
import { AWS_DATABASE_ADMIN_PASSWORD_PARAMETER, AWS_DATABASE_SERVICES, type AwsDatabaseOutputs, awsDatabasePasswordParameter } from './database'
import { AWS_DATABASE_SETUP_VARIABLES, awsDatabaseSetupPasswordVariable } from './database-setup-main'
import { AWS_PLATFORM_PROXY_REPOSITORY, AWS_SERVICES_REPOSITORY } from './images'
import { awsInstallationModel, awsJobInterval } from './model'
import type { AwsNetworkOutputs } from './network'
import {
	AWS_ACCOUNT_ID_FORM,
	AWS_OPERATIONS_TASK_ROLE,
	AWS_PLATFORM_PROXY_HEALTH_PORT,
	AWS_PLATFORM_PROXY_PORT,
	AWS_PLATFORM_SERVICE_PORT,
	AWS_PLATFORM_SERVICE_TASKS,
	AWS_REGION_FORM,
	awsPlatformExecutionRole,
	awsPlatformLogGroup,
	awsPlatformParameters,
	type AwsPlatformServiceTask,
	type AwsPlatformTask,
	awsPlatformTaskFamily,
	type AwsRuntimeOutputs,
} from './runtime'

/** The setup's stack, applied and run before the services': under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_SETUP_STACK = 'fabrika-platform-setup'
/** The services' stack, applied last. */
export const AWS_SERVICES_STACK = 'fabrika-platform-services'
/** A platform task's ECS service, in the platform's cluster. */
export function awsPlatformServiceName(task: AwsPlatformTask): string {
	return `fabrika-platform-${task}`
}
/** The name each container's port is published under, which Service Connect addresses it by. */
const PORT_NAME = 'http'
/** How long a Service Connect connection may sit idle, in seconds: the HTTP default, stated. */
const IDLE_TIMEOUT_SECONDS = 300

/** What each task is given: CPU units (1024 = one vCPU) and MiB, Fargate's sizes. */
export const AWS_PLATFORM_TASK_SIZES: Readonly<Record<AwsPlatformTask, { readonly cpu: number; readonly memory: number }>> = {
	iam: { cpu: 256, memory: 512 },
	// The console's assets and the deploy's calls: the heaviest of the three.
	control: { cpu: 512, memory: 1024 },
	operations: { cpu: 256, memory: 512 },
	proxy: { cpu: 256, memory: 512 },
	setup: { cpu: 256, memory: 512 },
}

/**
 * Each service's commands in the services image (`platform.Dockerfile`, `WORKDIR /app`), its scheduled job and the
 * job's interval: the installation model's (ADR-0092), with Control's AWS composition root.
 */
function serviceCommands(
	task: AwsPlatformServiceTask,
): { readonly migrate: string; readonly server: string; readonly job: string; readonly everySeconds: number } {
	const { entry, jobs } = awsInstallationModel.services[task]
	const [job, ...more] = jobs
	if (entry?.migrate === undefined || job === undefined || more.length > 0) {
		throw new Error(`aws: the ${task} service's task runs a migration, a server and one job beside it, which the model does not give`)
	}
	return { migrate: entry.migrate, server: entry.server, job: job.command, everySeconds: awsJobInterval(job.schedule) }
}

/**
 * The plain variables the template itself sets: fixed addresses and paths, never an installation's value. The
 * installation model's `fixed` and `address` variables; a Service Connect name is the task's, as the model's host is.
 */
const FIXED_VARIABLES: Readonly<Record<AwsPlatformTask, Readonly<Record<string, string>>>> = {
	iam: Object.fromEntries(staticEnvironment(awsInstallationModel, 'iam')),
	control: Object.fromEntries(staticEnvironment(awsInstallationModel, 'control')),
	operations: Object.fromEntries(staticEnvironment(awsInstallationModel, 'operations')),
	proxy: {},
	setup: {},
}

/**
 * The names an image fixes itself (`packages/proxy/Dockerfile`: the baked manifest and the loopback port Caddy dials
 * the auth service on). A task definition's secret would replace the image's value, so none may be one.
 */
const IMAGE_VARIABLES: Readonly<Record<AwsPlatformTask, readonly string[]>> = {
	iam: [],
	control: [],
	operations: [],
	proxy: ['FABRIKA_PROXY_MANIFEST', 'FABRIKA_PROXY_PORT'],
	setup: [],
}

/** A variable's name as the services read them. */
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]{0,127}$/
/** An image by digest in this account's registry. */
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/

/** Where a stack of the platform's tasks is: the account and region every ARN and the registry name. */
interface AwsPlace {
	readonly accountId: string
	readonly region: string
}

export interface AwsSetupInput extends AwsPlace {
	readonly database: Pick<AwsDatabaseOutputs, 'host' | 'port'>
	/** The services image's digest (`images.ts`): the setup's entry is in it. */
	readonly images: { readonly services: string }
}

export interface AwsServicesInput extends AwsPlace {
	readonly platform: AwsNetworkOutputs
	readonly runtime: AwsRuntimeOutputs
	readonly database: AwsDatabaseOutputs
	readonly balancers: Pick<AwsBalancersOutputs, 'platformProxyTargetGroupArn'>
	/** The digests the images were pushed under (`images.ts`). */
	readonly images: { readonly services: string; readonly proxy: string }
	/**
	 * The names of the variables each task reads from its parameters: the keys of the environment the operator's
	 * command writes. None may be one the template or the image sets itself.
	 */
	readonly variables: Readonly<Record<'iam' | 'control' | 'operations' | 'proxy', readonly string[]>>
}

function checkPlace(place: AwsPlace): void {
	if (!AWS_ACCOUNT_ID_FORM.test(place.accountId) || !AWS_REGION_FORM.test(place.region)) {
		throw new Error('aws: the account id or region is of another form')
	}
}

/** `input` as given, or an error naming the part of another form. */
export function checkAwsSetupInput(input: AwsSetupInput): AwsSetupInput {
	checkPlace(input)
	if (!IMAGE_DIGEST.test(input.images.services)) throw new Error("aws: an image's digest is of another form")
	return input
}

/** `input` as given, or an error naming the part of another form. */
export function checkAwsServicesInput(input: AwsServicesInput): AwsServicesInput {
	checkPlace(input)
	if (!IMAGE_DIGEST.test(input.images.services) || !IMAGE_DIGEST.test(input.images.proxy)) throw new Error("aws: an image's digest is of another form")
	if (!TARGET_GROUP_ARN.test(input.balancers.platformProxyTargetGroupArn)) throw new Error("aws: the platform proxy's target group is of another form")
	for (const task of ['iam', 'control', 'operations', 'proxy'] satisfies AwsPlatformTask[]) {
		const names = input.variables[task]
		if (!names.every((variable) => VARIABLE_NAME.test(variable)) || new Set(names).size !== names.length) {
			throw new Error(`aws: the ${task} task's variables name one twice, or one of another form`)
		}
		const fixed = names.find((variable) => variable in FIXED_VARIABLES[task])
		if (fixed !== undefined) throw new Error(`aws: the ${task} task's ${fixed} is the template's own`)
		const baked = names.find((variable) => IMAGE_VARIABLES[task].includes(variable))
		if (baked !== undefined) throw new Error(`aws: the ${task} task's ${baked} is its image's own`)
	}
	return input
}

const environment = (variables: Readonly<Record<string, string>>): JsonValue =>
	Object.entries(variables).map(([name, value]) => ({ Name: name, Value: value }))

/** The pieces every task definition of the platform is made of, in one account and region. */
function taskParts({ accountId: a, region: r }: AwsPlace) {
	const registry = `${a}.dkr.ecr.${r}.amazonaws.com`
	const role = (name: string) => `arn:aws:iam::${a}:role${AWS_PLATFORM_PATH}${name}`
	const parameter = (path: string) => `arn:aws:ssm:${r}:${a}:parameter${path}`
	return {
		role,
		parameter,
		servicesImage: (digest: string) => `${registry}/${AWS_SERVICES_REPOSITORY}@${digest}`,
		proxyImage: (digest: string) => `${registry}/${AWS_PLATFORM_PROXY_REPOSITORY}@${digest}`,
		logs: (task: AwsPlatformTask, prefix: string): JsonValue => ({
			LogDriver: 'awslogs',
			Options: { 'awslogs-group': awsPlatformLogGroup(task), 'awslogs-region': r, 'awslogs-stream-prefix': prefix },
		}),
		taskDefinition: (task: AwsPlatformTask, containers: readonly JsonValue[], taskRole?: string): JsonValue => ({
			Type: 'AWS::ECS::TaskDefinition',
			Properties: {
				Family: awsPlatformTaskFamily(task),
				Cpu: String(AWS_PLATFORM_TASK_SIZES[task].cpu),
				Memory: String(AWS_PLATFORM_TASK_SIZES[task].memory),
				NetworkMode: 'awsvpc',
				RequiresCompatibilities: ['FARGATE'],
				// x86: the platform proxy's binary is an x64 one, and the images are built for it (`images.ts`).
				RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
				ExecutionRoleArn: role(awsPlatformExecutionRole(task)),
				...(taskRole === undefined ? {} : { TaskRoleArn: taskRole }),
				ContainerDefinitions: [...containers],
			},
		}),
	}
}

/** A container of the services image runs under an init process: a shell as PID 1 would ignore the task's SIGTERM. */
const UNDER_INIT: JsonValue = { InitProcessEnabled: true }

/** The setup's task definition, alone in its stack, so the operator runs it before the services exist or move. */
export function awsSetupStack(input: AwsSetupInput): AwsStack {
	checkAwsSetupInput(input)
	const parts = taskParts(input)
	return {
		stackName: AWS_SETUP_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: "fabrika: the platform database's setup task",
			Resources: {
				SetupTaskDefinition: parts.taskDefinition('setup', [{
					Name: 'setup',
					Image: parts.servicesImage(input.images.services),
					Essential: true,
					Command: ['bun', 'packages/provider-aws/src/installation/database-setup-main.ts'],
					LinuxParameters: UNDER_INIT,
					Environment: environment({
						[AWS_DATABASE_SETUP_VARIABLES.host]: input.database.host,
						[AWS_DATABASE_SETUP_VARIABLES.port]: String(input.database.port),
					}),
					Secrets: [
						{ Name: AWS_DATABASE_SETUP_VARIABLES.adminPassword, ValueFrom: parts.parameter(AWS_DATABASE_ADMIN_PASSWORD_PARAMETER) },
						...AWS_DATABASE_SERVICES.map((service) => ({
							Name: awsDatabaseSetupPasswordVariable(service),
							ValueFrom: parts.parameter(awsDatabasePasswordParameter(service)),
						})),
					],
					LogConfiguration: parts.logs('setup', 'setup'),
				}]),
			},
			Outputs: { SetupTaskDefinitionArn: { Value: { Ref: 'SetupTaskDefinition' } } },
		},
		tags: { 'fabrika:platform': 'setup' },
	}
}

/** The task definition and the ECS service of each of the platform's services and its proxy. */
export function awsServicesStack(input: AwsServicesInput): AwsStack {
	const { runtime } = checkAwsServicesInput(input)
	const parts = taskParts(input)
	const servicesImage = parts.servicesImage(input.images.services)
	const secrets = (task: AwsPlatformTask, names: readonly string[]): JsonValue =>
		names.map((variable) => ({ Name: variable, ValueFrom: parts.parameter(`${awsPlatformParameters(task)}${variable}`) }))
	const network = (task: AwsPlatformTask, groups: readonly string[]): JsonValue => ({
		AwsvpcConfiguration: { Subnets: [...input.platform.taskSubnetIds], SecurityGroups: [runtime.groupIds[task], ...groups], AssignPublicIp: 'ENABLED' },
	})
	const service = (
		task: AwsPlatformTask,
		logical: string,
		extra: Readonly<Record<string, JsonValue>>,
		dependsOn: readonly string[] = [],
	): JsonValue => ({
		Type: 'AWS::ECS::Service',
		...(dependsOn.length === 0 ? {} : { DependsOn: [...dependsOn] }),
		Properties: {
			Cluster: AWS_PLATFORM_CLUSTER,
			ServiceName: awsPlatformServiceName(task),
			LaunchType: 'FARGATE',
			PlatformVersion: 'LATEST',
			TaskDefinition: { Ref: logical },
			DesiredCount: 1,
			EnableExecuteCommand: false,
			DeploymentConfiguration: { DeploymentCircuitBreaker: { Enable: true, Rollback: true }, MaximumPercent: 200, MinimumHealthyPercent: 100 },
			...extra,
		},
	})

	const resources: Record<string, JsonValue> = {}
	for (const task of AWS_PLATFORM_SERVICE_TASKS) {
		const commands = serviceCommands(task)
		const { health } = awsInstallationModel.services[task]
		const logical = `${task[0]?.toUpperCase() ?? ''}${task.slice(1)}`
		const shared = {
			Image: servicesImage,
			Environment: environment(FIXED_VARIABLES[task]),
			Secrets: secrets(task, input.variables[task]),
			LinuxParameters: UNDER_INIT,
		}
		resources[`${logical}TaskDefinition`] = parts.taskDefinition(task, [
			{
				Name: 'server',
				...shared,
				Essential: true,
				Command: ['sh', '-c', `bun ${commands.migrate} && exec bun ${commands.server}`],
				PortMappings: [{ Name: PORT_NAME, ContainerPort: AWS_PLATFORM_SERVICE_PORT, Protocol: 'tcp', AppProtocol: 'http' }],
				HealthCheck: {
					Command: ['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${health.port}${health.path} || exit 1`],
					Interval: 15,
					Timeout: 5,
					Retries: 3,
					// Migrations run before the server listens.
					StartPeriod: 120,
				},
				LogConfiguration: parts.logs(task, 'server'),
			},
			{
				Name: 'job',
				...shared,
				Essential: true,
				Command: ['sh', '-c', `while true; do bun ${commands.job}; sleep ${commands.everySeconds}; done`],
				DependsOn: [{ ContainerName: 'server', Condition: 'HEALTHY' }],
				LogConfiguration: parts.logs(task, 'job'),
			},
		], task === 'control' ? parts.role(AWS_CONTROL_ROLE) : task === 'operations' ? parts.role(AWS_OPERATIONS_TASK_ROLE) : undefined)
		resources[`${logical}Service`] = service(task, `${logical}TaskDefinition`, {
			NetworkConfiguration: network(task, [input.database.clientGroupId]),
			ServiceConnectConfiguration: {
				Enabled: true,
				Namespace: runtime.namespaceArn,
				Services: [{
					PortName: PORT_NAME,
					DiscoveryName: task,
					ClientAliases: [{ Port: AWS_PLATFORM_SERVICE_PORT, DnsName: task }],
					// No cap on a whole response (0 turns it off), as on Zerops; an idle connection still closes.
					Timeout: { PerRequestTimeoutSeconds: 0, IdleTimeoutSeconds: IDLE_TIMEOUT_SECONDS },
				}],
			},
		})
	}

	resources['ProxyTaskDefinition'] = parts.taskDefinition('proxy', [{
		Name: 'proxy',
		Image: parts.proxyImage(input.images.proxy),
		Essential: true,
		PortMappings: [
			{ Name: PORT_NAME, ContainerPort: AWS_PLATFORM_PROXY_PORT, Protocol: 'tcp', AppProtocol: 'http' },
			{ Name: 'health', ContainerPort: AWS_PLATFORM_PROXY_HEALTH_PORT, Protocol: 'tcp' },
		],
		Environment: environment(FIXED_VARIABLES.proxy),
		Secrets: secrets('proxy', input.variables.proxy),
		LogConfiguration: parts.logs('proxy', 'proxy'),
	}])
	// Created after the three, so its first tasks already resolve their names (a task resolves only the endpoints its
	// service's deployment saw). The three dial each other, which no order satisfies: the operator's command redeploys
	// any of them whose tasks started before the last one was created (`apply.ts`).
	const published = AWS_PLATFORM_SERVICE_TASKS.map((task) => `${task[0]?.toUpperCase() ?? ''}${task.slice(1)}Service`)
	resources['ProxyService'] = service('proxy', 'ProxyTaskDefinition', {
		NetworkConfiguration: network('proxy', []),
		// A client of the namespace alone: it dials the three services and publishes nothing.
		ServiceConnectConfiguration: { Enabled: true, Namespace: runtime.namespaceArn },
		LoadBalancers: [{ ContainerName: 'proxy', ContainerPort: AWS_PLATFORM_PROXY_PORT, TargetGroupArn: input.balancers.platformProxyTargetGroupArn }],
		HealthCheckGracePeriodSeconds: 60,
	}, published)

	return {
		stackName: AWS_SERVICES_STACK,
		template: { AWSTemplateFormatVersion: '2010-09-09', Description: "fabrika: the platform's services", Resources: resources },
		tags: { 'fabrika:platform': 'services' },
	}
}

/** How the operator's command runs the setup task: in the platform's cluster and network, with the setup's group. */
export function awsDatabaseSetupRun(input: Pick<AwsServicesInput, 'platform' | 'runtime' | 'database'>): {
	readonly cluster: string
	readonly network: { readonly subnets: readonly string[]; readonly securityGroups: readonly string[]; readonly publicIp: boolean }
} {
	return {
		cluster: AWS_PLATFORM_CLUSTER,
		network: {
			subnets: input.platform.taskSubnetIds,
			securityGroups: [input.runtime.groupIds.setup, input.database.clientGroupId],
			publicIp: true,
		},
	}
}
