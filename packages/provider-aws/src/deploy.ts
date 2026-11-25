// The deploy of one application environment (the AWS idea's checklist, step 8): its steps over the shared deploy run
// (`@fabrika/provider-contract`'s `runDeploy` and `awaitSettlement`, ADR-0044), with the AWS candidate `awsRunAttempt`.
// What it is handed is already decided: the rendered image, the task's environment and secrets, the clients, and
// Control's source upload. Step 9 (`control.ts`) assembles them.
//
// - `repository`: the run's build token is recorded first, as the run's external id, before anything exists; then the
//   application's repository is ensured, with its lifecycle rule.
// - `upload`: Control streams the commit's archive into the sources bucket in parts (`s3PartWriter`), under a key that
//   is this run's own (`awsSourceKey`).
// - `build`: the presigned read (valid for the queue allowance and the provisioning, `AWS_SOURCE_URL_SECONDS`) goes into
//   a SecureString under the run's path; the build starts with the token as its idempotency token; its id is recorded;
//   the build is polled to its end, its log relayed into the run log and drained once it ended; the SecureString is
//   deleted either way, and by `discard` after a crash.
// - `register`: the image's digest is read from ECR by the run's tag, and both task definitions are registered; the
//   service's revision is recorded.
// - `init`: each init command runs once as a one-off task of the init definition in the service's network (the
//   installation's subnets, the environment's security group; it exists before the service does), in order, and must
//   exit 0. A cancelled or abandoned run does not stop an init task that is running: a migration runs to its end under
//   the application's migration lock, which a later deploy's migration waits for.
// - `update`: `serviceUpdateRequested` is recorded before the one call that activates anything, and the service
//   deployment it answered after it. That call is `CreateService` when the environment has no service yet (its first
//   run, or one after the service was deleted) and `UpdateService` otherwise, with the network each time, so a service
//   converges on the installation's current one. The deploy owns the service, not the environment stack: it registers
//   the revision the service runs, and a stack would hold one the next stack update could return to.
// - `rollout`: the service deployment is polled to its verdict (`awsRunAttempt`'s `observe`).
//
// A refusal for rate (`isThrottled`) was not processed, so the call is sent again, with the same idempotency token where
// it has one. Another retryable failure may have taken effect: a lost start is found by its token, never repeated
// blindly; a repeated `RunTask` keeps its client token, so a task that started is not started twice; a lost update is
// left to the rollout, which keeps the run pending until the deadline (an update fails its step only on a definite
// refusal). UNVERIFIED: that `RunTask` with a repeated `clientToken` starts no second task follows ECS's API reference;
// it was not checked against an account. A failed run whose service was never updated
// stops its build (`runDeploy` discards it); one whose update was sent is settled by polling, never by a rollback. A dry
// run calls nothing.

import type { ContainerImage } from '@fabrika/app/build'
import {
	awaitSettlement,
	type DeployRunContext,
	type DeployStepResult,
	type ProviderRunEvents,
	type RunAttempt,
	runDeploy,
	type RunObservation,
} from '@fabrika/provider-contract'
import type { CodeBuildBuild, CodeBuildClient } from './aws/codebuild'
import type { EcrClient } from './aws/ecr'
import type { EcsClient, EcsNetwork, EcsServiceConnect } from './aws/ecs'
import type { LogsClient } from './aws/logs'
import { awsSourceKey, type S3ObjectAddress, type S3PartWriter, s3PresignedGet } from './aws/s3'
import type { SsmClient } from './aws/ssm'
import { type AwsCredentialSource, AwsError, isThrottled } from './aws/transport'
import { awsBuildStart, awsImageTag } from './build'
import type { AwsAppTarget } from './codecs'
import { type AwsTaskDefinitionInput, awsTaskDefinitions, INIT_CONTAINER } from './ecs-task'
import { AWS_RUN_DEADLINE_MS, AWS_SOURCE_URL_SECONDS, awsRunAttempt, type RecordedCheckpoint } from './run-attempt'

/** How often a build, an init task and the rollout are read while the run waits. */
export const AWS_POLL_INTERVAL_MS = 10_000
/** How many tasks an environment's service runs, until an application's size is authored. */
export const AWS_SERVICE_DESIRED_COUNT = 1
/** How often a call refused for rate, or a `RunTask` whose answer was lost, is sent in all. */
export const AWS_CALL_ATTEMPTS = 4
/** The backoff before the first repeat, doubled for each further one. */
const REPEAT_BACKOFF_MS = 1000
/** How long the deletion of the source URL's parameter may take once the build ended. */
const CLEANUP_TIMEOUT_MS = 10_000
/** How many pages of a build's log are read after it ended, within `DRAIN_TIMEOUT_MS`: its last lines arrive late. */
const DRAIN_PAGES = 5
const DRAIN_TIMEOUT_MS = 15_000

export type AwsDeployStepId = 'repository' | 'upload' | 'build' | 'register' | 'init' | 'update' | 'rollout'

export interface AwsDeployStep {
	readonly id: AwsDeployStepId
	readonly description: string
}

/** The steps of every deploy, in order. */
export const AWS_DEPLOY_STEPS: readonly AwsDeployStep[] = [
	{ id: 'repository', description: "record the run's build token and ensure the image repository" },
	{ id: 'upload', description: "upload the commit's archive to the sources bucket" },
	{ id: 'build', description: 'build and push the image' },
	{ id: 'register', description: 'register the task definitions of the pushed image' },
	{ id: 'init', description: 'run the init commands once (the migrations)' },
	{ id: 'update', description: 'create the service on the new revision, or update it to it' },
	{ id: 'rollout', description: 'wait for the service deployment' },
]

/** Control's source upload, as the composition root hands it: the run's commit as one archive, cut into parts. */
export interface AwsSourceUpload {
	upload(parts: S3PartWriter, signal: AbortSignal): Promise<void>
}

/** The AWS calls a deploy makes. */
export interface AwsDeployClients {
	readonly ecr: Pick<EcrClient, 'ensureRepository' | 'keepNewestImages' | 'findImage'>
	readonly codeBuild: Pick<CodeBuildClient, 'startBuild' | 'findBuild' | 'getBuild' | 'stopBuild'>
	readonly ecs: Pick<
		EcsClient,
		| 'registerTaskDefinition'
		| 'createService'
		| 'updateService'
		| 'describeService'
		| 'describeServiceDeployment'
		| 'describeServiceRevision'
		| 'runTask'
		| 'describeTask'
	>
	readonly logs: Pick<LogsClient, 'readForward'>
	readonly ssm: Pick<SsmClient, 'putSecret' | 'deleteSecret'>
	/** The part writer of an object in the sources bucket (`s3PartWriter` over the bucket's origin). */
	readonly s3PartWriter: (address: S3ObjectAddress) => S3PartWriter
	/** The credentials the build's presigned read is signed with. */
	readonly credentials: AwsCredentialSource
}

/** One application environment's ECS service, in its account, region and cluster. */
export interface AwsServiceTarget extends Pick<AwsAppTarget, 'accountId' | 'region' | 'cluster'> {
	readonly service: string
}

export interface AwsDeployInput {
	readonly appId: string
	readonly env: string
	/** The service the deploy updates; every other resource arrives below as the step that uses it takes it. */
	readonly target: AwsServiceTarget
	/** The namespace's sources bucket, in the target's region and account. */
	readonly sourcesBucket: string
	readonly build: {
		/** The installation's CodeBuild project. */
		readonly project: string
		/** The application environment's ECR repository, its URI, its tags and how many images its rule keeps. */
		readonly repositoryName: string
		readonly repositoryUri: string
		readonly repositoryTags: Readonly<Record<string, string>>
		readonly keepImages: number
		/** The Parameter Store path a run's source URL goes under (`awsSourceUrlParameter`). */
		readonly urlParameterPath: string
	}
	/** What `containerImage` rendered from the contract's recipe. */
	readonly image: Pick<ContainerImage, 'dockerfile' | 'init' | 'start'>
	/** The Parameter Store name of the source-map bearer, when the recipe uploads maps. */
	readonly sourceMapKeyParameter: string | null
	/** The task definitions' inputs besides the image. */
	readonly task: Omit<AwsTaskDefinitionInput, 'image' | 'rendered'>
	/**
	 * The network the service and the init tasks run in: the installation's subnets and the environment stack's
	 * security group. `null` only in a dry run, which calls nothing.
	 */
	readonly network: EcsNetwork | null
	/** How the service is published in its namespace's Service Connect namespace, for its proxy; `null` only in a dry run. */
	readonly serviceConnect: EcsServiceConnect | null
	readonly clients: AwsDeployClients
	readonly source: AwsSourceUpload
	readonly events: ProviderRunEvents
	readonly signal: AbortSignal
	readonly dryRun: boolean
	/**
	 * When the run started, in epoch milliseconds (Control's `startedAtMs`): its deadline counts from here, as
	 * `cancelRun` and `reconcileRun` count it, on the clock `awaitSettlement` reads (`Date.now()`).
	 */
	readonly startedAtMs: number
	readonly pollIntervalMs?: number
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
	/** The time the presigned read is signed at. */
	readonly now?: () => Date
	/** The run's build token: a lowercase UUID. */
	readonly newToken?: () => string
}

export interface AwsDeployResult {
	readonly status: 'succeeded' | 'failed'
	readonly steps: readonly DeployStepResult[]
	readonly checkpoint: RecordedCheckpoint | undefined
}

/** The Parameter Store name of one run's source URL: a function of the run, so a recovery can delete it. */
export function awsSourceUrlParameter(path: string, buildToken: string): string {
	return `${path}/${buildToken}/source-url`
}

/** Waits `ms`, or rejects once `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop)
			resolve()
		}, ms)
		const stop = (): void => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		signal.addEventListener('abort', stop, { once: true })
	})
}

/** The client's refusals before a request is sent: nothing reached ECS. */
const UNSENT: ReadonlySet<string> = new Set(['invalid_operation', 'invalid_request', 'credentials'])

/** Whether a failed `UpdateService` certainly changed nothing: ECS answered a 4xx, or the request was never sent. */
function refusedUpdate(error: AwsError): boolean {
	return (error.status >= 400 && error.status < 500) || (error.status === 0 && UNSENT.has(error.code))
}

/** A build's state as the wait reads it. */
function buildObservation(build: CodeBuildBuild): RunObservation {
	if (build.status === 'succeeded') return { state: 'active' }
	if (build.status === 'in_progress') return { state: 'pending', status: build.phase ?? 'in_progress' }
	return { state: 'failed', reason: `aws: build ${build.id} is ${build.status}` }
}

/** Runs the deploy of one application environment. */
export async function awsDeploy(input: AwsDeployInput): Promise<AwsDeployResult> {
	const { clients, events, signal, target, build } = input
	const now = input.now ?? (() => new Date())
	const sleep = input.sleep ?? pause
	const intervalMs = input.pollIntervalMs ?? AWS_POLL_INTERVAL_MS
	const log = (line: string): void => events.log(line)
	const token = (input.newToken ?? (() => crypto.randomUUID()))()
	const giveUpAtMs = input.startedAtMs + AWS_RUN_DEADLINE_MS
	const service = { cluster: target.cluster, service: target.service }
	const parameter = awsSourceUrlParameter(build.urlParameterPath, token)
	const attempt = awsRunAttempt({
		codeBuild: clients.codeBuild,
		ecs: clients.ecs,
		buildProject: build.project,
		service,
		sourceUrl: { ssm: clients.ssm, parameter: (buildToken) => awsSourceUrlParameter(build.urlParameterPath, buildToken) },
	})
	const address: S3ObjectAddress = {
		bucket: input.sourcesBucket,
		region: target.region,
		accountId: target.accountId,
		key: awsSourceKey(input.appId, input.env, token),
	}
	// What a step hands the next one, beside the checkpoint.
	let init: { readonly arn: string; readonly commands: readonly (readonly string[])[] } | null = null

	/** The checkpoint recorded so far; every step after the first has one. */
	const recorded = (context: DeployRunContext<RecordedCheckpoint>): RecordedCheckpoint => {
		const checkpoint = context.checkpoint
		if (checkpoint === undefined) throw new Error('aws: a step ran before the run recorded its build token')
		return checkpoint
	}

	/** The network of the service and the init tasks; only a dry run, whose steps never run, has none. */
	const networkOf = (): EcsNetwork => {
		if (input.network === null) throw new Error('aws: the deploy has no network for its tasks')
		return input.network
	}

	/**
	 * `call`, sent again while `repeatable` says its failure was not processed (or, for a call with an idempotency token,
	 * may be repeated), at most `AWS_CALL_ATTEMPTS` times, backing off, within the signal and the deadline.
	 */
	const repeated = async <T>(call: () => Promise<T>, repeatable: (error: unknown) => boolean): Promise<T> => {
		for (let attempt_ = 1;; attempt_ += 1) {
			try {
				return await call()
			} catch (error) {
				if (!repeatable(error) || attempt_ >= AWS_CALL_ATTEMPTS || signal.aborted || Date.now() > giveUpAtMs) throw error
				await sleep(REPEAT_BACKOFF_MS * 2 ** (attempt_ - 1), signal)
			}
		}
	}

	/** One page of a build's log, relayed into the run log; a failed read only skips the page. */
	const relay = async (stream: { readonly group: string; readonly stream: string }, cursor: string | undefined, read: AbortSignal) => {
		try {
			const page = await clients.logs.readForward(stream.group, stream.stream, cursor, read)
			if (page === null) return { cursor, atEnd: true }
			for (const event of page.events) {
				for (const line of event.message.split('\n')) if (line.trim() !== '') log(`  │ ${line.trimEnd()}`)
			}
			return { cursor: page.cursor, atEnd: page.atEnd }
		} catch {
			return { cursor, atEnd: true }
		}
	}

	/** A view of the run's candidate for a wait on something else than the build, named in its words, stopping nothing. */
	const waitingOn = (what: string): RunAttempt<RecordedCheckpoint> => ({
		...attempt,
		stop: async () => {},
		words: { ...attempt.words, candidate: () => what },
	})

	const steps: Record<AwsDeployStepId, (context: DeployRunContext<RecordedCheckpoint>) => Promise<void>> = {
		async repository(context) {
			await context.record({ buildToken: token })
			await repeated(() => clients.ecr.ensureRepository(build.repositoryName, build.repositoryTags, signal), isThrottled)
			await repeated(() => clients.ecr.keepNewestImages(build.repositoryName, build.keepImages, signal), isThrottled)
		},

		async upload() {
			await input.source.upload(clients.s3PartWriter(address), signal)
			log(`  uploaded ${address.key}`)
		},

		async build(context) {
			const url = await s3PresignedGet(clients.credentials, address, now(), AWS_SOURCE_URL_SECONDS)
			await repeated(() => clients.ssm.putSecret(parameter, url, signal), isThrottled)
			let stream: { readonly group: string; readonly stream: string } | null = null
			let cursor: string | undefined
			try {
				const start = awsBuildStart({
					project: build.project,
					buildToken: token,
					sourceUrlParameter: parameter,
					dockerfile: input.image.dockerfile,
					repositoryUri: build.repositoryUri,
					sourceMapKeyParameter: input.sourceMapKeyParameter,
				})
				let started: CodeBuildBuild
				try {
					// A throttled start was not processed: the same start under the same token is sent again.
					started = await repeated(() => clients.codeBuild.startBuild(start, signal), isThrottled)
				} catch (error) {
					// Any other retryable failure may hide a start: only the token tells (ADR-0044), never a blind repeat.
					if (!(error instanceof AwsError) || !error.retryable || isThrottled(error)) throw error
					const found = await clients.codeBuild.findBuild(build.project, token, signal)
					if (found === null) throw error
					started = found
				}
				await context.record({ ...recorded(context), buildId: started.id })
				log(`  build ${started.id}`)
				await awaitSettlement({
					attempt,
					checkpoint: recorded(context),
					events,
					signal,
					giveUpAtMs,
					intervalMs,
					sleep,
					observe: async (read) => {
						try {
							const current = await clients.codeBuild.getBuild(started.id, read)
							if (current === null) return { state: 'absent' }
							if (current.log !== null) {
								stream = current.log
								cursor = (await relay(current.log, cursor, read)).cursor
							}
							return buildObservation(current)
						} catch (error) {
							return { state: 'unobservable', cause: error }
						}
					},
				})
			} finally {
				// The build's last lines arrive in its log after it stopped: read on a few pages, bounded in time.
				const drained = stream
				if (drained !== null) {
					const drain = AbortSignal.timeout(DRAIN_TIMEOUT_MS)
					for (let page = 0; page < DRAIN_PAGES && !drain.aborted; page += 1) {
						const next = await relay(drained, cursor, drain)
						cursor = next.cursor
						if (next.atEnd) break
					}
				}
				// The URL opens the archive until it expires; its parameter goes once the build no longer needs it.
				await clients.ssm.deleteSecret(parameter, AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(() => {
					log(`  [warn] the source URL's parameter of this run could not be deleted; the URL in it expires, a recovery deletes it`)
				})
			}
		},

		async register(context) {
			const tag = awsImageTag(token)
			const pushed = await repeated(() => clients.ecr.findImage(build.repositoryName, { tag }, signal), isThrottled)
			if (pushed === null) throw new Error(`aws: the build pushed no image tagged ${tag}`)
			const definitions = awsTaskDefinitions({ ...input.task, image: `${build.repositoryUri}@${pushed.digest}`, rendered: input.image })
			const revision = await repeated(() => clients.ecs.registerTaskDefinition(definitions.service, signal), isThrottled)
			await context.record({ ...recorded(context), taskDefinitionArn: revision.arn })
			log(`  registered ${revision.arn}`)
			if (definitions.init !== null) {
				const initDefinition = definitions.init.definition
				const initRevision = await repeated(() => clients.ecs.registerTaskDefinition(initDefinition, signal), isThrottled)
				init = { arn: initRevision.arn, commands: definitions.init.commands }
			}
		},

		async init(context) {
			if (init === null) {
				log('  no init command')
				return
			}
			const { arn, commands } = init
			// The service's own network, which exists before the service does: a first run migrates before it creates it.
			const network = networkOf()
			for (const [index, command] of commands.entries()) {
				// Under its client token a repeated start starts no second task, so any retryable failure is repeated.
				const task = await repeated(
					() =>
						clients.ecs.runTask(
							{
								cluster: target.cluster,
								taskDefinitionArn: arn,
								container: INIT_CONTAINER,
								command,
								network,
								clientToken: `${token}-init-${index + 1}`,
								startedBy: `fabrika-${token}`,
							},
							signal,
						),
					(error) => error instanceof AwsError && error.retryable,
				)
				log(`  init ${index + 1}/${commands.length}: task ${task.arn}`)
				await awaitSettlement({
					attempt: waitingOn(`init task ${task.arn}`),
					checkpoint: recorded(context),
					events,
					signal,
					giveUpAtMs,
					intervalMs,
					sleep,
					observe: async (read) => {
						try {
							const ran = await clients.ecs.describeTask(target.cluster, task.arn, INIT_CONTAINER, read)
							if (ran === null) return { state: 'absent' }
							if (ran.status !== 'stopped') return { state: 'pending', status: ran.status }
							if (ran.exitCode === 0) return { state: 'active' }
							const reason = ran.reason === null ? '' : `: ${ran.reason}`
							return { state: 'failed', reason: `aws: init command ${index + 1} exited ${ran.exitCode ?? 'without an exit code'}${reason}` }
						} catch (error) {
							return { state: 'unobservable', cause: error }
						}
					},
				})
			}
		},

		async update(context) {
			const checkpoint = recorded(context)
			const revision = checkpoint.taskDefinitionArn
			if (revision === undefined) throw new Error('aws: the update ran before a revision was registered')
			const network = networkOf()
			const serviceConnect = input.serviceConnect
			if (serviceConnect === null) throw new Error('aws: the deploy has no Service Connect namespace for its service')
			// The environment's first run creates its service on its revision; every later one updates it. A service being
			// deleted is neither: ECS refuses an update of it, and a create of its name until it is gone.
			const current = await repeated(() => clients.ecs.describeService(service, signal), isThrottled)
			if (current?.status === 'draining') throw new Error(`aws: the service ${target.service} is being deleted; deploy again once it is gone`)
			const create = current === null || current.status === 'inactive'
			// Recorded before the call: from here the run is settled only by polling (ADR-0044). A create is marked as one, so a
			// service ECS does not show yet is no verdict on it.
			const submitted: RecordedCheckpoint = create
				? { ...checkpoint, serviceUpdateRequested: true, serviceCreateRequested: true }
				: { ...checkpoint, serviceUpdateRequested: true }
			await context.record(submitted)
			try {
				const updated = create
					// Under its client token (the run's) a repeated create creates no second service, so any retryable failure
					// is repeated. One whose answers were all lost is settled by the rollout, which waits for its deadline.
					? await repeated(
						() =>
							clients.ecs.createService(
								{
									...service,
									taskDefinitionArn: revision,
									network,
									desiredCount: AWS_SERVICE_DESIRED_COUNT,
									clientToken: token,
									serviceConnect,
									tags: input.task.tags,
								},
								signal,
							),
						(error) => error instanceof AwsError && error.retryable,
					)
					// A throttled update was not processed: the same revision is asked for again.
					: await repeated(() => clients.ecs.updateService(service, revision, network, serviceConnect, signal), isThrottled)
				if (create) log(`  created the service ${target.service}`)
				if (updated.currentDeploymentArn !== null) {
					await context.record({ ...submitted, deploymentArn: updated.currentDeploymentArn }).catch(() => {
						// The rollout finds the deployment through the service when its ARN is not recorded.
						log('  [warn] the service deployment could not be recorded; the rollout reads it through the service')
					})
				}
			} catch (error) {
				// Only a definite refusal fails the step: ECS's 4xx (a throttle was repeated above), or the client's own refusal
				// before anything was sent. Anything else (a timeout, a 5xx, a 200 the client could not read) may hide an update
				// that landed: the rollout settles it, pending until the deadline.
				if (!(error instanceof AwsError) || refusedUpdate(error)) throw error
				log(`  [warn] the update's answer is unknown (${error.code}); the rollout settles it`)
			}
		},

		async rollout(context) {
			const checkpoint = recorded(context)
			await awaitSettlement({
				attempt,
				checkpoint,
				events,
				signal,
				giveUpAtMs,
				intervalMs,
				sleep,
				observe: (read) => attempt.observe(checkpoint, read),
			})
		},
	}

	const result = await runDeploy({
		attempt,
		steps: AWS_DEPLOY_STEPS,
		options: { appId: input.appId, env: input.env, dryRun: input.dryRun, signal, log },
		events,
		runOne: async (step, context) => {
			if (input.dryRun) {
				log(`  dry run: would ${step.description}`)
				return
			}
			await steps[step.id](context)
		},
	})
	return { status: result.status, steps: result.steps, checkpoint: result.checkpoint }
}
