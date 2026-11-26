// The task runner (the plan's step 11 decision on one-off tasks, 2026-11-26): the one principal that starts a one-off
// task (an environment's init commands, `deploy.ts`). `RunTask` takes no condition key on the subnets or the security
// groups, and ECS attaches the task's network interface with its own role, so a role holding it could start a task in
// the platform's network carrying any of the platform's groups. Control's role is denied `RunTask` and may only invoke
// this function, which:
//
// - starts the task in the applications' cluster and the applications' task subnets alone (its own configuration, never
//   the request's), so the platform's network is never one it lands in; a security group the request names is accepted
//   as it is, since ECS refuses a group of another VPC than the subnets' (AWS's `AwsVpcConfiguration`), and the
//   platform's groups are all in the platform's;
// - refuses a platform task definition (`fabrika_platform_*`), as its role is denied one;
// - overrides one container's command and nothing else: no role, no environment, no ECS Exec;
// - answers the task as `RunTask` answers it, cut to what the deploy reads, so ECS's own tokens, metadata and dates stay
//   in the function.
//
// Its configuration (the cluster, the subnets) is its environment, written by the access stack; Control is denied every
// Lambda action on it but invoking it, and every IAM action on its role (`access.ts`). A repeat with the same client
// token starts no second task, as with `RunTask` itself.
//
// The source is plain CommonJS for Lambda's Node.js runtime, inline in the template (at most 4,096 characters), with
// the AWS SDK the runtime carries. `make` takes its call as a parameter, so the tests run it against a fake.
//
// UNVERIFIED: that the runtime carries the SDK's ECS client and reports a thrown error's `name` as its `errorType` follows
// AWS's documentation; it was not checked against an account.

/** The runner's function and its role, under the platform's names, out of Control's reach. */
export const AWS_TASK_RUNNER = 'fabrika-task-runner'

/** The runner's ARN in `accountId` and `region`, which Control's role may invoke. */
export function awsTaskRunnerArn(accountId: string, region: string): string {
	return `arn:aws:lambda:${region}:${accountId}:function:${AWS_TASK_RUNNER}`
}

/**
 * The runner's source: `index.handler` over the SDK, `make` over any `RunTask`. `PLATFORM` is `access.ts`'s
 * `AWS_PLATFORM_FAMILY_PREFIX`, written out because `access.ts` imports this module; a test holds them equal.
 */
export const AWS_TASK_RUNNER_SOURCE = String.raw`'use strict'
const PLATFORM = 'fabrika_platform_'
const DEFINITION = /^arn:[a-z-]+:ecs:[a-z0-9-]+:\d{12}:task-definition\/([A-Za-z0-9_-]{1,255}):\d+$/
const refuse = (what) => {
	const error = new Error('refused: ' + what)
	error.name = 'TaskRunnerRefused'
	throw error
}
const text = (value, form) => typeof value === 'string' && form.test(value)
exports.make = (run) => async (event) => {
	const cluster = process.env.CLUSTER
	const subnets = (process.env.SUBNETS || '').split(',').filter(Boolean)
	// Fail closed: no configuration refuses everything.
	if (!cluster || subnets.length === 0) refuse('the runner is not configured')
	const e = event || {}
	const family = DEFINITION.exec(typeof e.taskDefinition === 'string' ? e.taskDefinition : '')
	if (!family) refuse('the task definition')
	if (family[1].startsWith(PLATFORM)) refuse('a platform task definition')
	if (!text(e.container, /^[A-Za-z0-9_-]{1,255}$/)) refuse('the container')
	if (!Array.isArray(e.command) || e.command.length === 0 || !e.command.every((part) => typeof part === 'string')) refuse('the command')
	const groups = e.securityGroups
	if (!Array.isArray(groups) || groups.length > 5 ||!groups.every((group) => text(group, /^sg-[0-9a-f]{8,17}$/))) {
		refuse('the security groups')
	}
	if (!text(e.clientToken, /^[A-Za-z0-9-]{1,64}$/)) refuse('the client token')
	if (!text(e.startedBy, /^[A-Za-z0-9_-]{1,128}$/)) refuse('the starter')
	const answer = await run({
		cluster,
		taskDefinition: e.taskDefinition,
		launchType: 'FARGATE',
		count: 1,
		clientToken: e.clientToken,
		startedBy: e.startedBy,
		networkConfiguration: {
			awsvpcConfiguration: { subnets, securityGroups: groups, assignPublicIp: e.publicIp === true ? 'ENABLED' : 'DISABLED' },
		},
		overrides: { containerOverrides: [{ name: e.container, command: e.command }] },
	})
	return {
		tasks: (answer.tasks || []).map((task) => ({
			taskArn: task.taskArn,
			lastStatus: task.lastStatus,
			stopCode: task.stopCode,
			stoppedReason: task.stoppedReason,
			containers: (task.containers || []).map((c) => ({ name: c.name, exitCode: c.exitCode, reason: c.reason })),
		})),
		failures: (answer.failures || []).map((failure) => ({ arn: failure.arn, reason: failure.reason })),
	}
}
exports.handler = (event) => {
	const ecs = require('@aws-sdk/client-ecs')
	const client = new ecs.ECSClient({})
	return exports.make((input) => client.send(new ecs.RunTaskCommand(input)))(event)
}
`
