// The ECS calls the AWS provider makes (ADR-0081): register a Fargate task definition (ARM64, `awsvpc`, the image by
// digest, secrets by reference), create a service on it or point one at it with the circuit breaker on, and read the
// service back with its deployments and events, which the deploy run observes (#374's `observe`) and relays to the run
// log.
//
// A registered revision activates nothing; only `createService` and `updateService` do. One of them is the run's
// submitting call: the checkpoint's `serviceUpdateRequested` is recorded before it (ADR-0044).
//
// UNVERIFIED: the operations' input and answer fields, the Fargate CPU values, the rollout states, the `dependsOn`
// rules, `CreateService`'s 36-character client token and that its answer names `currentServiceDeployment` follow
// ECS's API reference; none was checked against an account.

import { z } from 'zod'
import { AwsError, awsJsonClient, type AwsJsonClientOptions, ECS } from './json'

/** A cluster's, a service's, a task family's or a container's name. */
const ECS_NAME = /^[A-Za-z0-9_-]{1,255}$/
/** An IAM role's ARN. */
const ROLE_ARN = /^arn:aws(?:-[a-z]{1,10}){0,2}:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/
/** A task definition revision's ARN. */
const TASK_DEFINITION_ARN = /^arn:aws(?:-[a-z]{1,10}){0,2}:ecs:[a-z0-9-]{1,32}:\d{12}:task-definition\/[A-Za-z0-9_-]{1,255}:\d{1,10}$/
/** An image by digest: `<registry>/<repository>@sha256:<64 hex>`; a tag would let the image change under the revision. */
export const IMAGE_BY_DIGEST = /^[a-z0-9.-]{1,255}\/[a-z0-9._/-]{1,256}@sha256:[0-9a-f]{64}$/
/**
 * A Parameter Store parameter's ARN, which a container's secret references: `parameter` and the hierarchical name, at
 * most 15 segments of `[A-Za-z0-9_.-]` with no empty one, at most 950 characters (as `ssm.ts` writes them).
 */
const PARAMETER_ARN = /^arn:aws(?:-[a-z]{1,10}){0,2}:ssm:[a-z0-9-]{1,32}:\d{12}:parameter(?=[A-Za-z0-9_./-]{2,950}$)(?:\/[A-Za-z0-9_.-]+){1,15}$/
/** An environment variable's name. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/
/** A log group's name. */
const LOG_GROUP = /^[A-Za-z0-9_\-/.#]{1,512}$/
/** A region code. */
const REGION = /^[a-z]{2,4}(?:-[a-z]{1,10}){1,3}-\d{1,2}$/
/** A resource tag's key and value: letters, digits, spaces and `_.:/=+-@`, no line break. */
const TAG_KEY = /^[\p{L}\p{Zs}\p{N}_.:/=+@-]{1,128}$/u
const TAG_VALUE = /^[\p{L}\p{Zs}\p{N}_.:/=+@-]{0,256}$/u
/** The CPU units a Fargate task takes. */
const FARGATE_CPU: ReadonlySet<number> = new Set([256, 512, 1024, 2048, 4096, 8192, 16384])
/** The memory bounds of a Fargate task, in MiB; ECS checks the pair against the CPU. */
export const MIN_TASK_MEMORY = 512
export const MAX_TASK_MEMORY = 122_880

/** When a container may start relative to another (`dependsOn`). */
export type EcsDependency = 'START' | 'COMPLETE' | 'SUCCESS' | 'HEALTHY'

/** One container of a task definition. */
export interface EcsContainer {
	readonly name: string
	/** The image by digest, never by tag. */
	readonly image: string
	readonly essential: boolean
	readonly port?: number
	readonly command?: readonly string[]
	/** Plain values, readable by whoever reads the task definition: never a secret. */
	readonly environment?: Readonly<Record<string, string>>
	/** Secrets by the ARN of the Parameter Store parameter ECS reads at start. */
	readonly secrets?: Readonly<Record<string, string>>
	readonly healthCheck?: {
		readonly command: readonly string[]
		readonly intervalSeconds: number
		readonly timeoutSeconds: number
		readonly retries: number
		readonly startPeriodSeconds: number
	}
	readonly dependsOn?: readonly { readonly container: string; readonly condition: EcsDependency }[]
	readonly log: { readonly group: string; readonly region: string; readonly streamPrefix: string }
}

/** A Fargate task definition on ARM64 with `awsvpc` networking. */
export interface EcsTaskDefinition {
	readonly family: string
	/** The role the application's own code runs as. Never the execution role. */
	readonly taskRoleArn: string
	/**
	 * The role ECS uses to start the task: it pulls the image, reads the secrets and writes the log. It is the application
	 * environment's own, scoped to its repository, its parameter path and its log group, never one shared by applications:
	 * with the AWS-managed `aws/ssm` key, that scope is the only boundary between two applications' secrets
	 * ([ADR-0004](../../../../docs/decisions/0004-secrets-live-in-the-platform.md)). This client cannot see other
	 * applications' roles; the step that provisions the roles holds that rule.
	 */
	readonly executionRoleArn: string
	readonly cpu: number
	readonly memory: number
	readonly containers: readonly EcsContainer[]
	readonly tags: Readonly<Record<string, string>>
}

/** A registered revision. */
export interface EcsTaskDefinitionRevision {
	readonly arn: string
	readonly family: string
	readonly revision: number
}

/** A rollout's state; `null` for a deployment ECS reports none for (one made without the circuit breaker). */
export type EcsRolloutState = 'in_progress' | 'completed' | 'failed'

/** One deployment of a service. */
export interface EcsDeployment {
	readonly id: string
	/**
	 * `primary` is the deployment the service moves to; `active` an older one still running tasks; `inactive` one whose
	 * tasks are all stopped. ECS drops a replaced deployment from the list once it is done, so a deployment missing here
	 * is not a verdict on it (B8 reads the verdict from the service deployment instead).
	 */
	readonly status: 'primary' | 'active' | 'inactive'
	readonly taskDefinitionArn: string
	readonly rolloutState: EcsRolloutState | null
	readonly runningCount: number
	readonly desiredCount: number
	readonly failedTasks: number
}

/** A service as the deploy run observes it: its state, its deployments and its newest events. */
export interface EcsService {
	readonly name: string
	readonly arn: string
	readonly status: 'active' | 'draining' | 'inactive'
	readonly taskDefinitionArn: string
	readonly deployments: readonly EcsDeployment[]
	/** The ARN of the service's current service deployment (`currentServiceDeployment`), `null` when it names none. */
	readonly currentDeploymentArn: string | null
	/** The service's `awsvpc` network, which a one-off task of the application environment runs in too; `null` without one. */
	readonly network: EcsNetwork | null
	/** ECS's own event messages, newest first: what the run log relays. */
	readonly events: readonly { readonly id: string; readonly at: Date; readonly message: string }[]
}

/** An `awsvpc` network: the subnets and security groups a task's interface is placed in, and whether it has a public address. */
export interface EcsNetwork {
	readonly subnets: readonly string[]
	readonly securityGroups: readonly string[]
	/**
	 * Whether a task gets a public address (`assignPublicIp: ENABLED`): the network of a small installation, whose tasks
	 * reach AWS's endpoints without a NAT gateway. A one-off task takes the service's own setting.
	 */
	readonly publicIp: boolean
}

export interface EcsServiceAddress {
	readonly cluster: string
	readonly service: string
}

/**
 * One run of a one-off task (the init commands, `ecs-task.ts`): its ARN, where it stands, and once stopped, the exit
 * code of the container it ran (`null` when that container never ran to an exit) and ECS's stop code.
 */
export interface EcsTaskRun {
	readonly arn: string
	readonly status: 'pending' | 'running' | 'stopped'
	readonly exitCode: number | null
	readonly stopCode: string | null
	/**
	 * ECS's words for why it stopped, the task's `stoppedReason` and the container's `reason` (an image that would not
	 * pull, a secret that would not resolve), each cut at `MAX_REASON_LENGTH`: what the run log says when an init failed.
	 */
	readonly reason: string | null
}

/** What `runTask` starts: one Fargate task of a registered revision, with one container's command overridden. */
export interface EcsTaskStart {
	readonly cluster: string
	readonly taskDefinitionArn: string
	readonly container: string
	readonly command: readonly string[]
	readonly network: EcsNetwork
	/**
	 * The idempotency token: a repeat with the same token starts no second task, so it is unique per run and command
	 * (the run's build token and the command's index), and a lost answer is settled by repeating the call.
	 */
	readonly clientToken: string
	/** Who started the task, which `ListTasks` filters by: one value per run, so a recovery finds the run's tasks. */
	readonly startedBy: string
}

/**
 * What `createService` creates: a Fargate service of `desiredCount` tasks of a registered revision in an `awsvpc`
 * network, rolled by ECS with its circuit breaker on, its tags propagated to its tasks.
 */
export interface EcsServiceCreate extends EcsServiceAddress {
	readonly taskDefinitionArn: string
	readonly network: EcsNetwork
	readonly desiredCount: number
	/** The idempotency token, at most 36 characters: one per run, so a lost answer is settled by repeating the call. */
	readonly clientToken: string
	readonly tags: Readonly<Record<string, string>>
}

/** A service deployment's state; a circuit breaker's rollback is a state of the same deployment. */
export type EcsServiceDeploymentStatus =
	| 'pending'
	| 'in_progress'
	| 'successful'
	| 'stop_requested'
	| 'stopped'
	| 'rollback_requested'
	| 'rollback_in_progress'
	| 'rollback_successful'
	| 'rollback_failed'

/** One service deployment: what the run's verdict is read from. */
export interface EcsServiceDeployment {
	readonly arn: string
	readonly serviceArn: string
	readonly status: EcsServiceDeploymentStatus
	/** ECS's words for the state, e.g. that the circuit breaker detected a failure. */
	readonly statusReason: string | null
	/** The service revision the deployment deploys, `null` when ECS names none. */
	readonly targetRevisionArn: string | null
}

/** A service revision: which task definition a deployment deploys. */
export interface EcsServiceRevision {
	readonly arn: string
	readonly taskDefinitionArn: string
}

export interface EcsClient {
	/** Registers `definition` as a new revision of its family; nothing runs it until a service is updated to it. */
	registerTaskDefinition(definition: EcsTaskDefinition, signal?: AbortSignal): Promise<EcsTaskDefinitionRevision>
	/**
	 * Creates the service on `taskDefinitionArn`: the submitting call of an environment's first run. A repeat under the
	 * same client token creates nothing more.
	 */
	createService(create: EcsServiceCreate, signal?: AbortSignal): Promise<EcsService>
	/**
	 * Points the service at `taskDefinitionArn` in `network` with the circuit breaker on: the submitting call of every
	 * later run. The network is sent each time, so a service converges on the installation's current one.
	 */
	updateService(address: EcsServiceAddress, taskDefinitionArn: string, network: EcsNetwork, signal?: AbortSignal): Promise<EcsService>
	/** The service, or `null` when ECS answers it `MISSING`. Any other failure is an error. */
	describeService(address: EcsServiceAddress, signal?: AbortSignal): Promise<EcsService | null>
	/** The service deployment `arn`, or `null` when ECS answers it `MISSING`. Any other failure is an error. */
	describeServiceDeployment(arn: string, signal?: AbortSignal): Promise<EcsServiceDeployment | null>
	/** The service revision `arn`, or `null` when ECS answers it `MISSING`. Any other failure is an error. */
	describeServiceRevision(arn: string, signal?: AbortSignal): Promise<EcsServiceRevision | null>
	/** Starts one task; a task ECS could not place (`failures`) is the error `task_not_started`. */
	runTask(start: EcsTaskStart, signal?: AbortSignal): Promise<EcsTaskRun>
	/** The task `arn` in `cluster`, its `container`'s exit code read; `null` when ECS answers it `MISSING`. */
	describeTask(cluster: string, arn: string, container: string, signal?: AbortSignal): Promise<EcsTaskRun | null>
}

const SERVICE_DEPLOYMENT_STATUSES: Readonly<Record<string, EcsServiceDeploymentStatus>> = {
	PENDING: 'pending',
	IN_PROGRESS: 'in_progress',
	SUCCESSFUL: 'successful',
	STOP_REQUESTED: 'stop_requested',
	STOPPED: 'stopped',
	ROLLBACK_REQUESTED: 'rollback_requested',
	ROLLBACK_IN_PROGRESS: 'rollback_in_progress',
	ROLLBACK_SUCCESSFUL: 'rollback_successful',
	ROLLBACK_FAILED: 'rollback_failed',
}
/** A service deployment's ARN: `…:service-deployment/<cluster>/<service>/<id>`. */
const SERVICE_DEPLOYMENT_ARN =
	/^arn:aws(?:-[a-z]{1,10}){0,2}:ecs:[a-z0-9-]{1,32}:\d{12}:service-deployment\/[A-Za-z0-9_-]{1,255}\/[A-Za-z0-9_-]{1,255}\/[A-Za-z0-9_-]{1,64}$/
/** A service revision's ARN: `…:service-revision/<cluster>/<service>/<id>`. */
const SERVICE_REVISION_ARN =
	/^arn:aws(?:-[a-z]{1,10}){0,2}:ecs:[a-z0-9-]{1,32}:\d{12}:service-revision\/[A-Za-z0-9_-]{1,255}\/[A-Za-z0-9_-]{1,255}\/[A-Za-z0-9_-]{1,64}$/

/** A subnet's and a security group's id. */
const SUBNET = /^subnet-[0-9a-f]{8,17}$/
const SECURITY_GROUP = /^sg-[0-9a-f]{8,17}$/
/** A task's ARN: `…:task/<cluster>/<id>`. */
const TASK_ARN = /^arn:aws(?:-[a-z]{1,10}){0,2}:ecs:[a-z0-9-]{1,32}:\d{12}:task\/[A-Za-z0-9_-]{1,255}\/[0-9a-f]{32}$/
/** A `RunTask` idempotency token, and a `CreateService` one, which takes at most 36 characters. */
const CLIENT_TOKEN = /^[A-Za-z0-9-]{1,64}$/
const SERVICE_CLIENT_TOKEN = /^[A-Za-z0-9-]{1,36}$/
/** The most subnets and security groups an `awsvpc` network takes. */
const MAX_SUBNETS = 16
const MAX_SECURITY_GROUPS = 5
/** The most tasks a service of this provider runs. */
const MAX_DESIRED_COUNT = 100
/** `startedBy`: letters, digits, hyphens and underscores, at most 128. */
const STARTED_BY = /^[A-Za-z0-9_-]{1,128}$/
/** The longest reason a stopped task reports, per part. */
const MAX_REASON_LENGTH = 300
/** A task's states, as ECS writes them; a state ECS may add later is no answer. */
const TASK_STATUSES: Readonly<Record<string, EcsTaskRun['status']>> = {
	PROVISIONING: 'pending',
	PENDING: 'pending',
	ACTIVATING: 'pending',
	RUNNING: 'running',
	DEACTIVATING: 'running',
	STOPPING: 'running',
	DEPROVISIONING: 'running',
	STOPPED: 'stopped',
	DELETED: 'stopped',
}

const DEPLOYMENT_STATUSES: Readonly<Record<string, EcsDeployment['status']>> = { PRIMARY: 'primary', ACTIVE: 'active', INACTIVE: 'inactive' }
const ROLLOUT_STATES: Readonly<Record<string, EcsRolloutState>> = { IN_PROGRESS: 'in_progress', COMPLETED: 'completed', FAILED: 'failed' }
const SERVICE_STATUSES: Readonly<Record<string, EcsService['status']>> = { ACTIVE: 'active', DRAINING: 'draining', INACTIVE: 'inactive' }

const serviceSchema = z.object({
	serviceName: z.string(),
	serviceArn: z.string(),
	status: z.string(),
	taskDefinition: z.string(),
	deployments: z.array(
		z.object({
			id: z.string(),
			status: z.string(),
			taskDefinition: z.string(),
			rolloutState: z.string().optional(),
			runningCount: z.number().int(),
			desiredCount: z.number().int(),
			failedTasks: z.number().int().optional(),
		}),
	).optional(),
	events: z.array(z.object({ id: z.string(), createdAt: z.number(), message: z.string() })).optional(),
	currentServiceDeployment: z.string().regex(SERVICE_DEPLOYMENT_ARN).optional(),
	networkConfiguration: z.object({
		awsvpcConfiguration: z.object({
			subnets: z.array(z.string().regex(SUBNET)).min(1).max(16),
			securityGroups: z.array(z.string().regex(SECURITY_GROUP)).max(5).optional(),
			assignPublicIp: z.string().optional(),
		}).optional(),
	}).optional(),
})
const taskSchema = z.object({
	taskArn: z.string().regex(TASK_ARN),
	lastStatus: z.string(),
	stopCode: z.string().optional(),
	stoppedReason: z.string().optional(),
	containers: z.array(z.object({ name: z.string(), exitCode: z.number().int().optional(), reason: z.string().optional() })).optional(),
})
const tasksSchema = z.object({
	tasks: z.array(taskSchema).optional(),
	failures: z.array(z.object({ arn: z.string().optional(), reason: z.string().optional() })).optional(),
})
const failuresSchema = z.array(z.object({ arn: z.string().optional(), reason: z.string().optional() })).optional()
const serviceDeploymentsSchema = z.object({
	serviceDeployments: z.array(
		z.object({
			serviceDeploymentArn: z.string(),
			serviceArn: z.string(),
			status: z.string(),
			statusReason: z.string().optional(),
			targetServiceRevision: z.object({ arn: z.string().regex(SERVICE_REVISION_ARN).optional() }).optional(),
		}),
	).optional(),
	failures: failuresSchema,
})
// Both lists are optional: an answer where every ARN is MISSING may leave the empty list out (UNVERIFIED either way).
const serviceRevisionsSchema = z.object({
	serviceRevisions: z.array(z.object({ serviceRevisionArn: z.string(), taskDefinition: z.string().regex(TASK_DEFINITION_ARN) })).optional(),
	failures: failuresSchema,
})
const registeredSchema = z.object({
	taskDefinition: z.object({ taskDefinitionArn: z.string().regex(TASK_DEFINITION_ARN), family: z.string(), revision: z.number().int().positive() }),
})
const updatedSchema = z.object({ service: serviceSchema })
const describedSchema = z.object({
	services: z.array(serviceSchema),
	failures: z.array(z.object({ arn: z.string().optional(), reason: z.string().optional() })).optional(),
})

/** Refuses a value of another form before anything is sent, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`ECS: ${what} is not one ECS takes`)
}

function seconds(value: number, min: number, max: number, what: string): number {
	return Number.isInteger(value) && value >= min && value <= max ? value : refuse(what)
}

function tagsOf(tags: Readonly<Record<string, string>>): { key: string; value: string }[] {
	return Object.entries(tags).map(([key, value]) => {
		// AWS reserves the `aws:` prefix in any letter case.
		if (!TAG_KEY.test(key) || !TAG_VALUE.test(value) || key.toLowerCase().startsWith('aws:')) refuse('a tag')
		return { key, value }
	})
}

/** The container definition ECS takes, after every value of it was checked. */
function containerOf(container: EcsContainer, names: ReadonlySet<string>): Record<string, unknown> {
	if (!ECS_NAME.test(container.name)) refuse('a container name')
	if (!IMAGE_BY_DIGEST.test(container.image)) refuse('an image (by digest)')
	if (container.port !== undefined && (!Number.isInteger(container.port) || container.port < 1 || container.port > 65535)) refuse('a port')
	const environment = Object.entries(container.environment ?? {})
	const secrets = Object.entries(container.secrets ?? {})
	const variableNames = new Set<string>()
	for (const [name] of [...environment, ...secrets]) {
		if (!VARIABLE_NAME.test(name) || variableNames.has(name)) refuse('a variable name')
		variableNames.add(name)
	}
	for (const [, valueFrom] of secrets) if (!PARAMETER_ARN.test(valueFrom)) refuse('a secret reference')
	for (const dependency of container.dependsOn ?? []) {
		if (!names.has(dependency.container) || dependency.container === container.name) refuse('a dependency')
	}
	if (!LOG_GROUP.test(container.log.group) || !REGION.test(container.log.region) || !ECS_NAME.test(container.log.streamPrefix)) refuse('the log')
	const health = container.healthCheck
	// ECS runs `CMD` with arguments as given and `CMD-SHELL` through the image's shell; nothing else is a health check.
	if (health !== undefined && (health.command.length < 2 || (health.command[0] !== 'CMD' && health.command[0] !== 'CMD-SHELL'))) {
		refuse('the health check')
	}
	return {
		name: container.name,
		image: container.image,
		essential: container.essential,
		...(container.port === undefined ? {} : { portMappings: [{ containerPort: container.port, protocol: 'tcp' }] }),
		...(container.command === undefined ? {} : { command: [...container.command] }),
		environment: environment.map(([name, value]) => ({ name, value })),
		secrets: secrets.map(([name, valueFrom]) => ({ name, valueFrom })),
		...(health === undefined ? {} : {
			healthCheck: {
				command: [...health.command],
				interval: seconds(health.intervalSeconds, 5, 300, 'the health check'),
				timeout: seconds(health.timeoutSeconds, 2, 60, 'the health check'),
				retries: seconds(health.retries, 1, 10, 'the health check'),
				startPeriod: seconds(health.startPeriodSeconds, 0, 300, 'the health check'),
			},
		}),
		...(container.dependsOn === undefined ? {} : {
			dependsOn: container.dependsOn.map((dependency) => ({ containerName: dependency.container, condition: dependency.condition })),
		}),
		logConfiguration: {
			logDriver: 'awslogs',
			options: { 'awslogs-group': container.log.group, 'awslogs-region': container.log.region, 'awslogs-stream-prefix': container.log.streamPrefix },
		},
	}
}

/** The service as the provider reads it; a state ECS may add later is an `invalid_answer`, never a guess. */
function serviceOf(operation: string, raw: z.infer<typeof serviceSchema>): EcsService {
	const invalid = (): never => {
		throw new AwsError(operation, 'invalid_answer', 200, null, false)
	}
	const status = SERVICE_STATUSES[raw.status] ?? invalid()
	return {
		name: raw.serviceName,
		arn: raw.serviceArn,
		status,
		taskDefinitionArn: raw.taskDefinition,
		deployments: (raw.deployments ?? []).map((deployment) => ({
			id: deployment.id,
			status: DEPLOYMENT_STATUSES[deployment.status] ?? invalid(),
			taskDefinitionArn: deployment.taskDefinition,
			rolloutState: deployment.rolloutState === undefined ? null : ROLLOUT_STATES[deployment.rolloutState] ?? invalid(),
			runningCount: deployment.runningCount,
			desiredCount: deployment.desiredCount,
			failedTasks: deployment.failedTasks ?? 0,
		})),
		currentDeploymentArn: raw.currentServiceDeployment ?? null,
		network: (() => {
			const awsvpc = raw.networkConfiguration?.awsvpcConfiguration
			// ECS's default is no public address.
			return awsvpc === undefined
				? null
				: { subnets: awsvpc.subnets, securityGroups: awsvpc.securityGroups ?? [], publicIp: awsvpc.assignPublicIp === 'ENABLED' }
		})(),
		// ECS's JSON protocol writes a timestamp as seconds since the epoch, fractions included.
		events: (raw.events ?? []).map((event) => ({ id: event.id, at: new Date(event.createdAt * 1000), message: event.message })),
	}
}

/**
 * A role as IAM tells two apart: its account and its name, without the path, in lower case. A role's name is unique in
 * its account whatever its path, and IAM compares names without regard to case.
 */
function roleIdentity(arn: string): string {
	const [, , , , account = '', resource = ''] = arn.split(':')
	return `${account}/${resource.slice(resource.lastIndexOf('/') + 1).toLowerCase()}`
}

function address(where: EcsServiceAddress): EcsServiceAddress {
	if (!ECS_NAME.test(where.cluster)) refuse('the cluster name')
	if (!ECS_NAME.test(where.service)) refuse('the service name')
	return where
}

/** The `awsvpcConfiguration` ECS takes, after every id was checked: one subnet at least, at most five groups. */
function awsvpcOf(network: EcsNetwork): Record<string, unknown> {
	const { subnets, securityGroups } = network
	if (subnets.length === 0 || subnets.length > MAX_SUBNETS || !subnets.every((subnet) => SUBNET.test(subnet))) refuse('the subnets')
	if (securityGroups.length > MAX_SECURITY_GROUPS || !securityGroups.every((group) => SECURITY_GROUP.test(group))) refuse('the security groups')
	return {
		awsvpcConfiguration: {
			subnets: [...subnets],
			securityGroups: [...securityGroups],
			assignPublicIp: network.publicIp ? 'ENABLED' : 'DISABLED',
		},
	}
}

/**
 * How ECS rolls a service: a new task starts before an old one stops (at most twice the desired count, never below it),
 * and the circuit breaker rolls a deployment whose tasks do not come up back to the last one that did.
 */
const DEPLOYMENT_CONFIGURATION = {
	deploymentCircuitBreaker: { enable: true, rollback: true },
	maximumPercent: 200,
	minimumHealthyPercent: 100,
}

/** ECS at `options.origin`; the client is of the `ECS` service by construction. */
export function ecsClient(options: AwsJsonClientOptions): EcsClient {
	const json = awsJsonClient(ECS, options)
	return {
		async registerTaskDefinition(definition, signal) {
			if (!ECS_NAME.test(definition.family)) refuse('the family')
			if (!ROLE_ARN.test(definition.taskRoleArn) || !ROLE_ARN.test(definition.executionRoleArn)) refuse('a role')
			// The application's code must never hold the role that reads its secrets and pulls its image.
			if (roleIdentity(definition.taskRoleArn) === roleIdentity(definition.executionRoleArn)) refuse('the task role (it is the execution role)')
			if (!FARGATE_CPU.has(definition.cpu)) refuse('the CPU')
			if (!Number.isInteger(definition.memory) || definition.memory < MIN_TASK_MEMORY || definition.memory > MAX_TASK_MEMORY) refuse('the memory')
			const names = new Set(definition.containers.map((container) => container.name))
			if (definition.containers.length === 0 || names.size !== definition.containers.length) refuse('the containers')
			if (!definition.containers.some((container) => container.essential)) refuse('the containers')
			// A container another waits on for SUCCESS or COMPLETE must be allowed to exit: it is not essential. One waited on
			// for HEALTHY must have a health check.
			for (const container of definition.containers) {
				for (const dependency of container.dependsOn ?? []) {
					const target = definition.containers.find((candidate) => candidate.name === dependency.container)
					if (target?.essential === true && (dependency.condition === 'SUCCESS' || dependency.condition === 'COMPLETE')) refuse('a dependency')
					if (target !== undefined && dependency.condition === 'HEALTHY' && target.healthCheck === undefined) refuse('a dependency')
				}
			}
			const registered = await json.call(
				'RegisterTaskDefinition',
				{
					family: definition.family,
					taskRoleArn: definition.taskRoleArn,
					executionRoleArn: definition.executionRoleArn,
					networkMode: 'awsvpc',
					requiresCompatibilities: ['FARGATE'],
					cpu: String(definition.cpu),
					memory: String(definition.memory),
					runtimePlatform: { cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' },
					containerDefinitions: definition.containers.map((container) => containerOf(container, names)),
					tags: tagsOf(definition.tags),
				},
				registeredSchema,
				signal,
			)
			const revision = registered.taskDefinition
			if (revision.family !== definition.family) throw new AwsError('RegisterTaskDefinition', 'invalid_answer', 200, null, false)
			return { arn: revision.taskDefinitionArn, family: revision.family, revision: revision.revision }
		},

		async createService(create, signal) {
			const { cluster, service } = address(create)
			if (!TASK_DEFINITION_ARN.test(create.taskDefinitionArn)) refuse('the task definition')
			if (!SERVICE_CLIENT_TOKEN.test(create.clientToken)) refuse('the client token')
			if (!Number.isInteger(create.desiredCount) || create.desiredCount < 0 || create.desiredCount > MAX_DESIRED_COUNT) refuse('the desired count')
			const networkConfiguration = awsvpcOf(create.network)
			const created = await json.call(
				'CreateService',
				{
					cluster,
					serviceName: service,
					taskDefinition: create.taskDefinitionArn,
					desiredCount: create.desiredCount,
					launchType: 'FARGATE',
					platformVersion: 'LATEST',
					schedulingStrategy: 'REPLICA',
					deploymentController: { type: 'ECS' },
					deploymentConfiguration: DEPLOYMENT_CONFIGURATION,
					networkConfiguration,
					clientToken: create.clientToken,
					// No shell into a task: ECS Exec would reach the application's process around the proxy.
					enableExecuteCommand: false,
					enableECSManagedTags: true,
					propagateTags: 'SERVICE',
					tags: tagsOf(create.tags),
				},
				updatedSchema,
				signal,
			)
			// An answer for another service, or one that runs another revision, is no answer to this call.
			if (created.service.serviceName !== service || created.service.taskDefinition !== create.taskDefinitionArn) {
				throw new AwsError('CreateService', 'invalid_answer', 200, null, false)
			}
			return serviceOf('CreateService', created.service)
		},

		async updateService(where, taskDefinitionArn, network, signal) {
			const { cluster, service } = address(where)
			if (!TASK_DEFINITION_ARN.test(taskDefinitionArn)) refuse('the task definition')
			const networkConfiguration = awsvpcOf(network)
			const updated = await json.call(
				'UpdateService',
				{
					cluster,
					service,
					taskDefinition: taskDefinitionArn,
					deploymentConfiguration: DEPLOYMENT_CONFIGURATION,
					networkConfiguration,
				},
				updatedSchema,
				signal,
			)
			// An answer for another service, or one that points the service elsewhere, is no answer to this call.
			if (updated.service.serviceName !== service || updated.service.taskDefinition !== taskDefinitionArn) {
				throw new AwsError('UpdateService', 'invalid_answer', 200, null, false)
			}
			return serviceOf('UpdateService', updated.service)
		},

		async describeService(where, signal) {
			const { cluster, service } = address(where)
			const described = await json.call('DescribeServices', { cluster, services: [service] }, describedSchema, signal)
			const found = described.services.find((candidate) => candidate.serviceName === service)
			if (found !== undefined) return serviceOf('DescribeServices', found)
			// Only an explicit MISSING says there is no such service; anything else is no answer.
			if ((described.failures ?? []).some((failure) => failure.reason === 'MISSING')) return null
			throw new AwsError('DescribeServices', 'invalid_answer', 200, null, false)
		},

		async describeServiceDeployment(arn, signal) {
			if (!SERVICE_DEPLOYMENT_ARN.test(arn)) refuse('the service deployment')
			const operation = 'DescribeServiceDeployments'
			const described = await json.call(operation, { serviceDeploymentArns: [arn] }, serviceDeploymentsSchema, signal)
			const found = (described.serviceDeployments ?? []).find((candidate) => candidate.serviceDeploymentArn === arn)
			if (found === undefined) {
				// Only an explicit MISSING for this ARN says there is no such deployment; anything else is no answer.
				if ((described.failures ?? []).some((failure) => failure.arn === arn && failure.reason === 'MISSING')) return null
				throw new AwsError(operation, 'invalid_answer', 200, null, false)
			}
			const status = SERVICE_DEPLOYMENT_STATUSES[found.status]
			// A state ECS may add later is no answer, never a guess.
			if (status === undefined) throw new AwsError(operation, 'invalid_answer', 200, null, false)
			return {
				arn: found.serviceDeploymentArn,
				serviceArn: found.serviceArn,
				status,
				statusReason: found.statusReason ?? null,
				targetRevisionArn: found.targetServiceRevision?.arn ?? null,
			}
		},

		async describeServiceRevision(arn, signal) {
			if (!SERVICE_REVISION_ARN.test(arn)) refuse('the service revision')
			const operation = 'DescribeServiceRevisions'
			const described = await json.call(operation, { serviceRevisionArns: [arn] }, serviceRevisionsSchema, signal)
			const found = (described.serviceRevisions ?? []).find((candidate) => candidate.serviceRevisionArn === arn)
			if (found !== undefined) return { arn: found.serviceRevisionArn, taskDefinitionArn: found.taskDefinition }
			if ((described.failures ?? []).some((failure) => failure.arn === arn && failure.reason === 'MISSING')) return null
			throw new AwsError(operation, 'invalid_answer', 200, null, false)
		},

		async runTask(start, signal) {
			if (!ECS_NAME.test(start.cluster)) refuse('the cluster name')
			if (!TASK_DEFINITION_ARN.test(start.taskDefinitionArn)) refuse('the task definition')
			if (!ECS_NAME.test(start.container)) refuse('the container')
			if (start.command.length === 0) refuse('the command')
			if (!CLIENT_TOKEN.test(start.clientToken)) refuse('the client token')
			if (!STARTED_BY.test(start.startedBy)) refuse('the starter')
			const networkConfiguration = awsvpcOf(start.network)
			const operation = 'RunTask'
			const answered = await json.call(
				operation,
				{
					cluster: start.cluster,
					taskDefinition: start.taskDefinitionArn,
					launchType: 'FARGATE',
					count: 1,
					clientToken: start.clientToken,
					startedBy: start.startedBy,
					networkConfiguration,
					overrides: { containerOverrides: [{ name: start.container, command: [...start.command] }] },
				},
				tasksSchema,
				signal,
			)
			const tasks = answered.tasks ?? []
			// A task ECS could not place is named in `failures` (capacity, an unknown revision): nothing runs.
			if (tasks.length === 0 && (answered.failures ?? []).length > 0) throw new AwsError(operation, 'task_not_started', 200, null, false)
			const [task] = tasks
			if (tasks.length !== 1 || task === undefined) throw new AwsError(operation, 'invalid_answer', 200, null, false)
			return taskRunOf(operation, task, start.container)
		},

		async describeTask(cluster, arn, container, signal) {
			if (!ECS_NAME.test(cluster)) refuse('the cluster name')
			if (!TASK_ARN.test(arn)) refuse('the task')
			if (!ECS_NAME.test(container)) refuse('the container')
			const operation = 'DescribeTasks'
			const described = await json.call(operation, { cluster, tasks: [arn] }, tasksSchema, signal)
			const found = (described.tasks ?? []).find((candidate) => candidate.taskArn === arn)
			if (found !== undefined) return taskRunOf(operation, found, container)
			if ((described.failures ?? []).some((failure) => failure.arn === arn && failure.reason === 'MISSING')) return null
			throw new AwsError(operation, 'invalid_answer', 200, null, false)
		},
	}
}

/** A task as the deploy reads it; a state ECS may add later, or a stopped task without the container, is no answer. */
function taskRunOf(operation: string, task: z.infer<typeof taskSchema>, container: string): EcsTaskRun {
	const status = TASK_STATUSES[task.lastStatus]
	if (status === undefined) throw new AwsError(operation, 'invalid_answer', 200, null, false)
	const named = (task.containers ?? []).filter((candidate) => candidate.name === container)
	if (named.length > 1 || (status === 'stopped' && named.length === 0)) throw new AwsError(operation, 'invalid_answer', 200, null, false)
	const reasons: string[] = []
	for (const reason of [task.stoppedReason, named[0]?.reason]) {
		if (reason !== undefined && reason !== '') reasons.push(reason)
	}
	return {
		arn: task.taskArn,
		status,
		exitCode: named[0]?.exitCode ?? null,
		stopCode: task.stopCode ?? null,
		reason: reasons.length === 0 ? null : reasons.map((reason) => reason.slice(0, MAX_REASON_LENGTH)).join('; '),
	}
}
