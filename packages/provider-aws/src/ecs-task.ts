// The task definitions of one application environment (the AWS idea's checklist, step 7): its image, rendered from the
// contract's recipe by `containerImage` (`@fabrika/app/build`) and pushed by the build, as ECS runs it. Pure: no AWS
// call, no clock. `ecsClient(…).registerTaskDefinition` checks every value again before anything is sent.
//
// - The service's definition carries the server alone: it runs the recipe's start command on port 3000, the Bun
//   adapter's default, and its health check asks the contract's health endpoint on the loopback, the one path the
//   application serves without the proxy's headers.
// - The recipe's init commands (the migrations, and the schema check an image build moves to container start) run once
//   per deploy, before the service is updated, as `ContainerImage.init` says: the deploy step runs the init definition
//   as a one-off task per command, in order, each overriding its command, and updates the service only after every one
//   exited 0. Never in every service task: the schema check fails against a schema a newer revision migrated, so a
//   rollback, a replacement or a scale-out of the older revision could not start; and Fargate bounds a container
//   dependency's wait at 120 s, which a long migration would outrun.
// - Variables are plain values, which anyone who may read the task definition reads, and secrets are Parameter Store
//   ARNs (ADR-0004). A framework variable that carries a credential (`isManagedCredential`, the rule Control writes by,
//   failing closed) is refused among the plain values.
// - The task role and the execution role are the application environment's own (ADR-0004's AWS invariant); this module
//   takes them as given and the ECS client refuses the two being one role.
// - The recipe's jobs are not here: the image runs none of them, and their schedule is the provider's (ADR-0080).
//
// UNVERIFIED: that ECS counts a failed container health check against the deployment's circuit breaker follows ECS's
// developer guide; it was not checked against an account.

import type { ContainerImage } from '@fabrika/app/build'
import { isManagedCredential } from '@fabrika/auth-core'
import { type EcsContainer, type EcsTaskDefinition, IMAGE_BY_DIGEST } from './aws/ecs'
import { isHealthPath } from './codecs'

/** The port the Bun adapter serves on when `PORT` is not set. */
export const AWS_APPLICATION_PORT = 3000
/** The server container's name, which the service's Service Connect configuration names too. */
export const SERVER_CONTAINER = 'server'
/** The init definition's one container, whose command each one-off task overrides. */
export const INIT_CONTAINER = 'init'
/** The init definition's family is the service's with this suffix. */
export const INIT_FAMILY_SUFFIX = '-init'
/** How long a new task has before a failed health check counts: the server's boot. */
const HEALTH_START_PERIOD_SECONDS = 60
/** A family the init suffix still fits behind (ECS takes 255). */
const FAMILY = /^[A-Za-z0-9_-]{1,250}$/

/** One application environment's tasks, besides its image. */
export interface AwsTaskDefinitionInput {
	/** The service's task definition family: one per application environment. */
	readonly family: string
	/** The image the build pushed, by digest. */
	readonly image: string
	/** What `containerImage` rendered the image with: its init and start commands. */
	readonly rendered: Pick<ContainerImage, 'init' | 'start'>
	/** The contract's health endpoint (`AwsAppArtifact.healthPath`). */
	readonly healthPath: string
	/** Plain values: the managed variables that carry no credential, and the application's own. */
	readonly environment: Readonly<Record<string, string>>
	/** Secrets by the ARN of the Parameter Store parameter ECS reads at start (`parameterArn`). */
	readonly secrets: Readonly<Record<string, string>>
	readonly taskRoleArn: string
	readonly executionRoleArn: string
	/** Fargate CPU units and memory in MiB, from the application's size. */
	readonly cpu: number
	readonly memory: number
	/** The application environment's log group and its region. */
	readonly log: { readonly group: string; readonly region: string }
	readonly tags: Readonly<Record<string, string>>
}

/** The service's task definition, and the one-off init definition with the commands the deploy runs on it, in order. */
export interface AwsTaskDefinitions {
	readonly service: EcsTaskDefinition
	/** `null` when the recipe has no init command (an application without a database). */
	readonly init: { readonly definition: EcsTaskDefinition; readonly commands: readonly (readonly string[])[] } | null
}

/** Refuses an input this module cannot render, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`AWS task definition: ${what} is not one this provider renders`)
}

/**
 * The health check of the server: one request to the health endpoint on the loopback, through the image's own Bun (the
 * image carries no curl). An argv, so no shell reads the path; the path is a JSON string literal in the script.
 */
function healthCommand(healthPath: string): readonly string[] {
	const url = JSON.stringify(`http://127.0.0.1:${AWS_APPLICATION_PORT}${healthPath}`)
	return ['CMD', 'bun', '-e', `fetch(${url}).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))`]
}

/** The task definitions of one application environment, as `ecsClient(…).registerTaskDefinition` takes them. */
export function awsTaskDefinitions(input: AwsTaskDefinitionInput): AwsTaskDefinitions {
	if (!FAMILY.test(input.family)) refuse('the family')
	if (!IMAGE_BY_DIGEST.test(input.image)) refuse('the image (by digest)')
	if (!isHealthPath(input.healthPath)) refuse('the health path')
	if (input.rendered.start.length === 0 || input.rendered.init.some((command) => command.length === 0)) refuse('the image commands')
	// The port is the platform's: a `PORT` of the application's would move the server away from its health check.
	if (Object.hasOwn(input.environment, 'PORT') || Object.hasOwn(input.secrets, 'PORT')) refuse('the variable PORT')
	for (const name of Object.keys(input.environment)) {
		// A plain value is readable in the task definition: a framework credential goes by parameter ARN only.
		if (name.startsWith('FABRIKA_') && isManagedCredential(name)) refuse(`the plain variable ${name} (a credential)`)
	}
	const environment = { ...input.environment }
	const secrets = { ...input.secrets }
	const log = (streamPrefix: string) => ({ group: input.log.group, region: input.log.region, streamPrefix })
	const definition = (family: string, container: EcsContainer): EcsTaskDefinition => ({
		family,
		taskRoleArn: input.taskRoleArn,
		executionRoleArn: input.executionRoleArn,
		cpu: input.cpu,
		memory: input.memory,
		containers: [container],
		tags: input.tags,
	})

	const service = definition(input.family, {
		name: SERVER_CONTAINER,
		image: input.image,
		essential: true,
		port: AWS_APPLICATION_PORT,
		command: [...input.rendered.start],
		environment,
		secrets,
		healthCheck: {
			command: healthCommand(input.healthPath),
			intervalSeconds: 10,
			timeoutSeconds: 5,
			retries: 3,
			startPeriodSeconds: HEALTH_START_PERIOD_SECONDS,
		},
		log: log(SERVER_CONTAINER),
	})
	const [first] = input.rendered.init
	if (first === undefined) return { service, init: null }
	// No port and no health check: the one-off task runs a command and exits, and its exit code is the verdict.
	const init = definition(`${input.family}${INIT_FAMILY_SUFFIX}`, {
		name: INIT_CONTAINER,
		image: input.image,
		essential: true,
		command: [...first],
		environment,
		secrets,
		log: log(INIT_CONTAINER),
	})
	return { service, init: { definition: init, commands: input.rendered.init.map((command) => [...command]) } }
}
