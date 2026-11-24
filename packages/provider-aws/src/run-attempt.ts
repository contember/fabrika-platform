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
import { type AwsRunCheckpoint, awsRunCheckpointCodec } from './codecs'

/**
 * A run stops waiting for its candidate this long after it started: a build of up to an hour (the build project's
 * timeout) and the rollout behind it.
 */
export const AWS_RUN_DEADLINE_MS = 90 * 60 * 1000
/** The longest reason a failed deployment reports in the run log. */
const MAX_REASON_LENGTH = 300

/** What the run attempt reads and stops: the application environment's build project and service. */
export interface AwsRunAttemptInput {
	readonly codeBuild: Pick<CodeBuildClient, 'findBuild' | 'stopBuild'>
	readonly ecs: Pick<EcsClient, 'describeService' | 'describeServiceDeployment' | 'describeServiceRevision'>
	readonly buildProject: string
	readonly service: EcsServiceAddress
}

/** A checkpoint the run has as it does: a token first, and each later field only behind the one it needs. */
type RecordedCheckpoint = AwsRunCheckpoint & { readonly buildToken: string }

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

	/** The run's service deployment: the recorded one, or the service's current one when it is this run's revision. */
	const deploymentOf = async (checkpoint: RecordedCheckpoint, signal: AbortSignal): Promise<EcsServiceDeployment | null> => {
		if (checkpoint.deploymentArn !== undefined) return ecs.describeServiceDeployment(checkpoint.deploymentArn, signal)
		// The update's answer was lost: the service's current deployment is this run's only if it deploys this revision.
		const current = await ecs.describeService(service, signal)
		if (current?.currentDeploymentArn == null) return null
		const deployment = await ecs.describeServiceDeployment(current.currentDeploymentArn, signal)
		if (deployment?.targetRevisionArn == null) return null
		const revision = await ecs.describeServiceRevision(deployment.targetRevisionArn, signal)
		return revision?.taskDefinitionArn === checkpoint.taskDefinitionArn ? deployment : null
	}

	return {
		parse: parseAwsCheckpoint,
		encode: (checkpoint) => awsRunCheckpointCodec.encode(checkpoint),
		externalId: (checkpoint) => checkpoint.buildToken,
		submitted: (checkpoint) => checkpoint.serviceUpdateRequested === true,
		// Before the update nothing of the run can activate; stopping its build ends the work it started.
		discard: (checkpoint, signal) => stopBuild(checkpoint, signal),
		observe: async (checkpoint, signal) => {
			let deployment: EcsServiceDeployment | null
			try {
				signal.throwIfAborted()
				deployment = await deploymentOf(checkpoint, signal)
			} catch (error) {
				return { state: 'unobservable', cause: signal.aborted ? signal.reason : error }
			}
			if (deployment === null) return { state: 'absent' }
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
