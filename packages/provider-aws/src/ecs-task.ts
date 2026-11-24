// The task definition of one application environment (the AWS idea's checklist, step 7): its image, rendered from the
// contract's recipe by `containerImage` (`@fabrika/app/build`) and pushed by the build, as ECS runs it. Pure: no AWS
// call, no clock. `ecsClient(…).registerTaskDefinition` checks every value again before anything is sent.
//
// - The recipe's init commands (the migrations, and the schema check an image build moves to container start) each run
//   in a non-essential container of their own, in order, and the server starts only once the last one exited 0. Every
//   task runs them, as every Zerops container does: `fabrika db migrate` takes its own lock.
// - The server runs the recipe's start command on port 3000, the Bun adapter's default, and its health check asks the
//   contract's health endpoint on the loopback, the one path the application serves without the proxy's headers.
// - Variables are plain values and secrets are Parameter Store ARNs, never a secret's value (ADR-0004).
// - The task role and the execution role are the application environment's own (ADR-0004's AWS invariant); this module
//   takes them as given and the ECS client refuses the two being one role.
// - The recipe's jobs are not here: the image runs none of them, and their schedule is the provider's (ADR-0080).
//
// UNVERIFIED: that ECS starts the `dependsOn` chain in order and counts a failed container health check against the
// deployment's circuit breaker follows ECS's developer guide; none was checked against an account.

import type { ContainerImage } from '@fabrika/app/build'
import type { EcsContainer, EcsTaskDefinition } from './aws/ecs'

/** The port the Bun adapter serves on when `PORT` is not set. */
export const AWS_APPLICATION_PORT = 3000
/** The server container's name, which the service's Service Connect configuration names too. */
export const SERVER_CONTAINER = 'server'
/** How long a new task has before a failed health check counts: the boot after the init containers. */
const HEALTH_START_PERIOD_SECONDS = 60
/** A pushed image by digest; a tag would let the image change under the revision. */
const IMAGE_BY_DIGEST = /^[a-z0-9.-]{1,255}\/[a-z0-9._/-]{1,256}@sha256:[0-9a-f]{64}$/
/** The contract's health endpoint, as the artifact codec reads it. */
const HEALTH_PATH = /^\/[A-Za-z0-9._~/-]{0,255}$/

/** One application environment's task, besides its image. */
export interface AwsTaskDefinitionInput {
	/** The task definition's family: one per application environment. */
	readonly family: string
	/** The image the build pushed, by digest. */
	readonly image: string
	/** What `containerImage` rendered the image with: its init and start commands. */
	readonly rendered: Pick<ContainerImage, 'init' | 'start'>
	/** The contract's health endpoint (`AwsAppArtifact.healthPath`). */
	readonly healthPath: string
	/** Plain values: the managed variables a deploy hands every container, and the application's own. */
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

/** The task definition of one application environment, as `ecsClient(…).registerTaskDefinition` takes it. */
export function awsTaskDefinition(input: AwsTaskDefinitionInput): EcsTaskDefinition {
	if (!IMAGE_BY_DIGEST.test(input.image)) refuse('the image (by digest)')
	if (!HEALTH_PATH.test(input.healthPath) || input.healthPath.split('/').some((segment) => segment === '.' || segment === '..')) {
		refuse('the health path')
	}
	if (input.rendered.start.length === 0 || input.rendered.init.some((command) => command.length === 0)) refuse('the image commands')
	// The port is the platform's: a `PORT` of the application's would move the server away from its health check.
	if (Object.hasOwn(input.environment, 'PORT') || Object.hasOwn(input.secrets, 'PORT')) refuse('the variable PORT')
	const log = (streamPrefix: string) => ({ group: input.log.group, region: input.log.region, streamPrefix })
	const environment = { ...input.environment }
	const secrets = { ...input.secrets }

	// Each init command in a container of its own, each waiting for the one before it to exit 0.
	const init: EcsContainer[] = input.rendered.init.map((command, index) => ({
		name: `init-${index + 1}`,
		image: input.image,
		essential: false,
		command: [...command],
		environment,
		secrets,
		...(index === 0 ? {} : { dependsOn: [{ container: `init-${index}`, condition: 'SUCCESS' }] }),
		log: log(`init-${index + 1}`),
	}))
	const server: EcsContainer = {
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
		...(init.length === 0 ? {} : { dependsOn: [{ container: `init-${init.length}`, condition: 'SUCCESS' }] }),
		log: log(SERVER_CONTAINER),
	}
	return {
		family: input.family,
		taskRoleArn: input.taskRoleArn,
		executionRoleArn: input.executionRoleArn,
		cpu: input.cpu,
		memory: input.memory,
		containers: [...init, server],
		tags: input.tags,
	}
}
