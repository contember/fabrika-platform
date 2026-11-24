// The AWS candidate of a deploy run (ADR-0044, `@fabrika/provider-contract`'s `RunAttempt`): the checkpoint
// `awsRunCheckpointCodec` stores, the build to stop when an unsubmitted run is given up, and the read that settles a
// submitted one. The shared deploy run owns the rule (`runDeploy`, `awaitSettlement`, `cancelRun`, `reconcileRun`); this
// module supplies the AWS calls.
//
// - The external id is `buildToken`, recorded before `StartBuild`, so it exists before anything does.
// - The run is submitted once `serviceUpdateRequested` is recorded, before `UpdateService`: only that call activates
//   anything. A build's image and a registered revision run nowhere until it.
// - The verdict of a submitted run is its service deployment's (`DescribeServiceDeployments`), never `DescribeServices`'
//   deployment list, which drops a rolled-back deployment once the rollback is done.
// - Cancellation never implies rollback: `stop` stops a build, never a service deployment, whose circuit breaker
//   settles it.
//
// UNVERIFIED: the service deployment's states and fields, the service's `currentServiceDeployment` and the revision's
// task definition follow ECS's API reference; none was checked against an account.

import type { JsonValue, RunAttempt, RunObservation } from '@fabrika/provider-contract'
import type { CodeBuildClient } from './aws/codebuild'
import type { EcsClient, EcsServiceAddress, EcsServiceDeployment } from './aws/ecs'
import type { SsmClient } from './aws/ssm'
import { type AwsRunCheckpoint, awsRunCheckpointCodec } from './codecs'

/** The build's timeout once it started, which the build step sends as `startBuild`'s `timeoutMinutes`. */
export const AWS_BUILD_TIMEOUT_MINUTES = 60
/** How long the build may wait in CodeBuild's queue, which the build step sends as `queuedTimeoutMinutes`. */
export const AWS_BUILD_QUEUED_TIMEOUT_MINUTES = 15
/** How long a build may take between leaving the queue and fetching its source: provisioning the builder. */
export const AWS_BUILD_PROVISION_MARGIN_MINUTES = 15
/**
 * How long the build's presigned read of its source stays valid: the whole queue allowance plus the provisioning, so a
 * build that waited its full allowance still fetches with a live URL. A URL signed with temporary credentials also ends
 * with their session, so the credentials it is signed with must outlive it. platform-node's container credentials are
 * refreshed only within `CREDENTIAL_REFRESH_BEFORE_MS` (five minutes) of their expiry, so a held set may have less left than the URL's validity:
 * step 9 signs with a set that has at least `AWS_SOURCE_URL_SECONDS` left (a fresh one if not), or the URL dies early.
 */
export const AWS_SOURCE_URL_SECONDS = (AWS_BUILD_QUEUED_TIMEOUT_MINUTES + AWS_BUILD_PROVISION_MARGIN_MINUTES) * 60
/**
 * The time the rollout has after the build: registering, the update, and the circuit breaker settling it. The service's
 * deployment settings (its failure threshold, the health check's start period and retries) must let ECS decide within it,
 * or a rollout still running at the deadline is abandoned as failed and may succeed later.
 */
export const AWS_ROLLOUT_MARGIN_MINUTES = 30
/** A run stops waiting for its candidate this long after it started: the queue, the build and the rollout. */
export const AWS_RUN_DEADLINE_MS = (AWS_BUILD_QUEUED_TIMEOUT_MINUTES + AWS_BUILD_TIMEOUT_MINUTES + AWS_ROLLOUT_MARGIN_MINUTES) * 60 * 1000
/** The run log's word for a submitted run whose deployment ECS does not show yet. */
const UNCONFIRMED = 'update_unconfirmed'
/** The longest reason a failed deployment reports in the run log. */
const MAX_REASON_LENGTH = 300

/** What the run attempt reads and stops: the application environment's build project and service. */
export interface AwsRunAttemptInput {
	readonly codeBuild: Pick<CodeBuildClient, 'findBuild' | 'stopBuild'>
	readonly ecs: Pick<EcsClient, 'describeService' | 'describeServiceDeployment' | 'describeServiceRevision'>
	readonly buildProject: string
	readonly service: EcsServiceAddress
	/**
	 * The run's source URL parameter, which `discard` deletes beside stopping the build: after a crash no `finally` of
	 * the live run deleted it, and nothing else would (an absent one is no error).
	 */
	readonly sourceUrl?: { readonly ssm: Pick<SsmClient, 'deleteSecret'>; readonly parameter: (buildToken: string) => string }
}

/** A checkpoint the run has as it does: a token first, and each later field only behind the one it needs. */
export type RecordedCheckpoint = AwsRunCheckpoint & { readonly buildToken: string }

/** The run checkpoint, or null for any other shape (an older one, or one whose fields could not have been recorded so). */
export function parseAwsCheckpoint(state: JsonValue | undefined): RecordedCheckpoint | null {
	if (state === undefined) return null
	let checkpoint: AwsRunCheckpoint
	try {
		checkpoint = awsRunCheckpointCodec.decode(state)
	} catch {
		return null
	}
	const { buildToken } = checkpoint
	if (buildToken === undefined) return null
	// A revision is registered only from a build, the service is updated only to a revision, and a deployment is named
	// only by that update's answer.
	if (checkpoint.taskDefinitionArn !== undefined && checkpoint.buildId === undefined) return null
	if (checkpoint.serviceUpdateRequested === true && checkpoint.taskDefinitionArn === undefined) return null
	if (checkpoint.deploymentArn !== undefined && checkpoint.serviceUpdateRequested !== true) return null
	return { ...checkpoint, buildToken }
}

/** The run log's words for a deployment's state, and whether it settled the run. */
function observation(deployment: EcsServiceDeployment): RunObservation {
	switch (deployment.status) {
		case 'successful':
			return { state: 'active' }
		case 'stopped':
		case 'rollback_successful':
		case 'rollback_failed': {
			const reason = deployment.statusReason === null ? '' : `: ${deployment.statusReason.slice(0, MAX_REASON_LENGTH)}`
			return { state: 'failed', reason: `aws: service deployment ${deployment.arn} is ${deployment.status}${reason}` }
		}
		// A rollback in progress has failed the candidate, but the run settles once the service is back.
		case 'pending':
		case 'in_progress':
		case 'stop_requested':
		case 'rollback_requested':
		case 'rollback_in_progress':
			return { state: 'pending', status: deployment.status }
	}
}

/** The AWS candidate of a deploy run over the application environment's build project and service. */
export function awsRunAttempt(input: AwsRunAttemptInput): RunAttempt<RecordedCheckpoint> {
	const { codeBuild, ecs, buildProject, service } = input

	/** Stops the run's build, if it started one; an absent or finished build needs nothing. */
	const stopBuild = async (checkpoint: RecordedCheckpoint, signal: AbortSignal): Promise<void> => {
		const id = checkpoint.buildId ?? (await codeBuild.findBuild(buildProject, checkpoint.buildToken, signal))?.id
		if (id !== undefined) await codeBuild.stopBuild(id, signal)
	}

	/**
	 * The run's service deployment: the recorded one, or the service's current one when it deploys this run's revision.
	 * `unconfirmed` when ECS does not show it (yet). Only a service ECS answers `MISSING` is `absent`: an update whose
	 * answer was lost can still land, and ECS's reads may lag the update, so everything else waits for the deadline, as
	 * the shared run's `cancelRun` and `reconcileRun` plan for a submission that never landed.
	 */
	const deploymentOf = async (checkpoint: RecordedCheckpoint, signal: AbortSignal): Promise<EcsServiceDeployment | 'unconfirmed' | 'absent'> => {
		if (checkpoint.deploymentArn !== undefined) {
			return (await ecs.describeServiceDeployment(checkpoint.deploymentArn, signal)) ?? 'unconfirmed'
		}
		const current = await ecs.describeService(service, signal)
		if (current === null) return 'absent'
		if (current.currentDeploymentArn === null) return 'unconfirmed'
		const deployment = await ecs.describeServiceDeployment(current.currentDeploymentArn, signal)
		if (deployment === null || deployment.targetRevisionArn === null) return 'unconfirmed'
		const revision = await ecs.describeServiceRevision(deployment.targetRevisionArn, signal)
		return revision !== null && revision.taskDefinitionArn === checkpoint.taskDefinitionArn ? deployment : 'unconfirmed'
	}

	return {
		parse: parseAwsCheckpoint,
		encode: (checkpoint) => awsRunCheckpointCodec.encode(checkpoint),
		externalId: (checkpoint) => checkpoint.buildToken,
		submitted: (checkpoint) => checkpoint.serviceUpdateRequested === true,
		// Before the update nothing of the run can activate; stopping its build ends the work it started.
		discard: async (checkpoint, signal) => {
			await stopBuild(checkpoint, signal)
			if (input.sourceUrl !== undefined) await input.sourceUrl.ssm.deleteSecret(input.sourceUrl.parameter(checkpoint.buildToken), signal)
		},
		observe: async (checkpoint, signal) => {
			let deployment: EcsServiceDeployment | 'unconfirmed' | 'absent'
			try {
				signal.throwIfAborted()
				deployment = await deploymentOf(checkpoint, signal)
			} catch (error) {
				return { state: 'unobservable', cause: signal.aborted ? signal.reason : error }
			}
			if (deployment === 'absent') return { state: 'absent' }
			if (deployment === 'unconfirmed') return { state: 'pending', status: UNCONFIRMED }
			// An answer about another service is no answer about this run.
			if (!deployment.serviceArn.endsWith(`:service/${service.cluster}/${service.service}`)) {
				return { state: 'unobservable', cause: new Error('aws: a service deployment of another service') }
			}
			return observation(deployment)
		},
		// A submitted run's build has finished; its rollout is never stopped (no rollback on cancel).
		stop: async (checkpoint, signal) => {
			if (checkpoint.serviceUpdateRequested !== true) await stopBuild(checkpoint, signal)
		},
		deadlineMs: AWS_RUN_DEADLINE_MS,
		words: {
			provider: 'aws',
			candidate: (checkpoint) =>
				checkpoint.taskDefinitionArn !== undefined
					? `task definition ${checkpoint.taskDefinitionArn}`
					: checkpoint.buildId !== undefined
					? `build ${checkpoint.buildId}`
					: `the build of token ${checkpoint.buildToken}`,
			discarded: 'stopped the work of',
			notDiscarded: 'could not be stopped; nothing of it runs before the service is updated',
			submission: 'updated the service',
		},
	}
}
