// One application environment's CloudFormation stack (checklist step 10): everything of its own a deploy uses, under
// the names `awsEnvironmentResources` derives, each role scoped to that environment's resources alone.
//
// - The image repository (immutable tags, AES-256) and the two log groups: the server's and the build's.
// - The task role (the application's own; no permission yet) and the execution role: it pulls this environment's
//   images, writes this environment's log group and reads this environment's secret parameters, nothing else.
// - The build project and its role: the build pushes to this environment's repository only, reads only this
//   environment's source URL parameters and writes only its own log group. An application's own build steps run with
//   that role, so no application's build reaches another's images or sources (the risk of one shared project).
// - Every trust policy names its service, this account (`aws:SourceAccount`) and the resources that may take it
//   (`aws:SourceArn`: the environment's own build project; for the ECS roles, ECS in this account and region).
// - Every role carries the installation's permissions boundary (`awsAppsPermissionsBoundary`), so whoever applies the
//   stack (Control, which must create roles to do it) can only create roles inside it: Control's own policy (step 11
//   of the idea doc) allows its role writes only with that boundary and never lets it change or remove it.
// - The stack owns the repository, its lifecycle policy included (`ecrLifecyclePolicy`, the rule the deploy sends).
//
// `awsEnvironmentStack` is pure: it renders the template. `ensureEnvironmentStack` applies it through CloudFormation
// (`aws/cloudformation.ts`), which a deploy runs before its steps.
//
// UNVERIFIED: the resource types, their properties, the build image and the IAM actions below follow AWS's published
// references (CloudFormation's resource reference, the service authorization reference); none was checked against an
// account. SecureString parameters under the account's default `aws/ssm` key need no `kms:Decrypt` grant of their own.

import type { JsonValue } from '@fabrika/provider-contract'
import { type CloudFormationClient, MAX_TEMPLATE_BYTES, STACK_STATUSES, type StackStatus } from './aws/cloudformation'
import { ecrLifecyclePolicy } from './aws/ecr'
import { AwsError } from './aws/transport'
import { AWS_BUILDSPEC } from './build'
import type { AwsAppTarget } from './codecs'
import { AWS_KEPT_IMAGES, type AwsEnvironmentResources, awsEnvironmentResources } from './resources'
import { AWS_BUILD_QUEUED_TIMEOUT_MINUTES, AWS_BUILD_TIMEOUT_MINUTES } from './run-attempt'

/** How long both log groups keep their events (one of CloudWatch Logs' values). */
export const AWS_LOG_RETENTION_DAYS = 30
/** The build's image: Amazon Linux on ARM, because the tasks run on ARM64 (`ecs.ts`). */
export const AWS_BUILD_IMAGE = 'aws/codebuild/amazonlinux-aarch64-standard:3.0'
const IAM_PATH = '/fabrika/apps/'

/** The pieces of one environment's stack: its name and the template CloudFormation takes. */
export interface AwsEnvironmentStack {
	readonly stackName: string
	readonly resources: AwsEnvironmentResources
	readonly template: JsonValue
	/** The stack's own tags. */
	readonly tags: Readonly<Record<string, string>>
}

/** The role's name within its path: the part of its ARN after `role/fabrika/apps/`. */
function roleName(arn: string): string {
	return arn.slice(arn.lastIndexOf('/') + 1)
}

/**
 * The managed policy every application environment's role carries as its permissions boundary: the installation's
 * (step 11 creates it), at one derived name, so Control's policy can require exactly it on every role write.
 */
export function awsAppsPermissionsBoundary(accountId: string): string {
	return `arn:aws:iam::${accountId}:policy/fabrika/fabrika-apps-boundary`
}

/** A trust policy that lets `service` take the role on behalf of this account, and only for `sourceArn`. */
function trust(service: string, accountId: string, sourceArn: { readonly equals: string } | { readonly like: string }): JsonValue {
	const condition: { [operator: string]: JsonValue } = { StringEquals: { 'aws:SourceAccount': accountId } }
	if ('equals' in sourceArn) condition['ArnEquals'] = { 'aws:SourceArn': sourceArn.equals }
	else condition['ArnLike'] = { 'aws:SourceArn': sourceArn.like }
	return {
		Version: '2012-10-17',
		Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole', Condition: condition }],
	}
}

/** An inline policy of `statements`. */
function policy(name: string, statements: readonly JsonValue[]): JsonValue {
	return { PolicyName: name, PolicyDocument: { Version: '2012-10-17', Statement: [...statements] } }
}

function allow(actions: readonly string[], resources: readonly string[]): JsonValue {
	return { Effect: 'Allow', Action: [...actions], Resource: [...resources] }
}

/** The stack of one application environment of `installation`. */
export function awsEnvironmentStack(appId: string, env: string, installation: AwsAppTarget): AwsEnvironmentStack {
	const resources = awsEnvironmentResources(appId, env, installation.accountId)
	const { accountId, region } = installation
	const repositoryArn = `arn:aws:ecr:${region}:${accountId}:repository/${resources.repository}`
	const logGroupArn = (group: string) => `arn:aws:logs:${region}:${accountId}:log-group:${group}:*`
	const parameters = (folder: string) => `arn:aws:ssm:${region}:${accountId}:parameter${resources.parameterPath}/${folder}/*`
	const tags = [{ Key: 'fabrika:app', Value: appId }, { Key: 'fabrika:env', Value: env }]
	// ECR issues its login token per account; the action takes no resource.
	const login = allow(['ecr:GetAuthorizationToken'], ['*'])
	const boundary = awsAppsPermissionsBoundary(accountId)
	// ECS names the task or the service it takes a role for; any of this account and region, and only of ECS.
	const ecs = { like: `arn:aws:ecs:${region}:${accountId}:*` }
	const project = { equals: `arn:aws:codebuild:${region}:${accountId}:project/${resources.buildProject}` }

	const template: JsonValue = {
		AWSTemplateFormatVersion: '2010-09-09',
		Description: `fabrika: the application environment ${appId}/${env}`,
		Resources: {
			Repository: {
				Type: 'AWS::ECR::Repository',
				Properties: {
					RepositoryName: resources.repository,
					ImageTagMutability: 'IMMUTABLE',
					EncryptionConfiguration: { EncryptionType: 'AES256' },
					LifecyclePolicy: { LifecyclePolicyText: ecrLifecyclePolicy(AWS_KEPT_IMAGES) },
					Tags: tags,
				},
			},
			LogGroup: {
				Type: 'AWS::Logs::LogGroup',
				Properties: { LogGroupName: resources.logGroup, RetentionInDays: AWS_LOG_RETENTION_DAYS, Tags: tags },
			},
			BuildLogGroup: {
				Type: 'AWS::Logs::LogGroup',
				Properties: { LogGroupName: resources.buildLogGroup, RetentionInDays: AWS_LOG_RETENTION_DAYS, Tags: tags },
			},
			TaskRole: {
				Type: 'AWS::IAM::Role',
				Properties: {
					RoleName: roleName(resources.taskRoleArn),
					Path: IAM_PATH,
					PermissionsBoundary: boundary,
					AssumeRolePolicyDocument: trust('ecs-tasks.amazonaws.com', accountId, ecs),
					Tags: tags,
				},
			},
			ExecutionRole: {
				Type: 'AWS::IAM::Role',
				Properties: {
					RoleName: roleName(resources.executionRoleArn),
					Path: IAM_PATH,
					PermissionsBoundary: boundary,
					AssumeRolePolicyDocument: trust('ecs-tasks.amazonaws.com', accountId, ecs),
					Policies: [
						policy('execution', [
							login,
							allow(['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'], [repositoryArn]),
							allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [logGroupArn(resources.logGroup)]),
							allow(['ssm:GetParameters'], [parameters('env')]),
						]),
					],
					Tags: tags,
				},
			},
			BuildRole: {
				Type: 'AWS::IAM::Role',
				Properties: {
					RoleName: roleName(resources.buildRoleArn),
					Path: IAM_PATH,
					PermissionsBoundary: boundary,
					AssumeRolePolicyDocument: trust('codebuild.amazonaws.com', accountId, project),
					Policies: [
						policy('build', [
							login,
							allow(
								[
									'ecr:BatchCheckLayerAvailability',
									'ecr:InitiateLayerUpload',
									'ecr:UploadLayerPart',
									'ecr:CompleteLayerUpload',
									'ecr:PutImage',
								],
								[repositoryArn],
							),
							allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [logGroupArn(resources.buildLogGroup)]),
							allow(['ssm:GetParameters'], [parameters('builds')]),
						]),
					],
					Tags: tags,
				},
			},
			BuildProject: {
				Type: 'AWS::CodeBuild::Project',
				Properties: {
					Name: resources.buildProject,
					ServiceRole: { 'Fn::GetAtt': ['BuildRole', 'Arn'] },
					// The deploy sends the same buildspec and the run's variables with every start (`awsBuildStart`).
					Source: { Type: 'NO_SOURCE', BuildSpec: AWS_BUILDSPEC },
					Artifacts: { Type: 'NO_ARTIFACTS' },
					Environment: {
						Type: 'ARM_CONTAINER',
						ComputeType: 'BUILD_GENERAL1_SMALL',
						Image: AWS_BUILD_IMAGE,
						// The build runs Docker to build the image.
						PrivilegedMode: true,
					},
					LogsConfig: { CloudWatchLogs: { Status: 'ENABLED', GroupName: resources.buildLogGroup } },
					TimeoutInMinutes: AWS_BUILD_TIMEOUT_MINUTES,
					QueuedTimeoutInMinutes: AWS_BUILD_QUEUED_TIMEOUT_MINUTES,
					Tags: tags,
				},
			},
		},
	}
	return { stackName: resources.stackName, resources, template, tags: { 'fabrika:app': appId, 'fabrika:env': env } }
}

/** How often the stack is read while CloudFormation works on it, and how long a deploy waits for it. */
export const AWS_STACK_POLL_MS = 10_000
export const AWS_STACK_TIMEOUT_MS = 20 * 60 * 1000

/** The statuses from which the stack serves: its template is the one last applied. */
const SETTLED: ReadonlySet<StackStatus> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE'])
/** The statuses CloudFormation leaves by itself. `REVIEW_IN_PROGRESS` (an unexecuted change set) never does. */
const MOVING: ReadonlySet<StackStatus> = new Set(
	STACK_STATUSES.filter((status) => status.endsWith('_IN_PROGRESS') && status !== 'REVIEW_IN_PROGRESS'),
)

/** A JSON value's text with every object's keys sorted: two documents equal as JSON have one canonical text. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
	}
	return JSON.stringify(value) ?? 'null'
}

/** Whether a template body the stack answered is the rendered one as JSON; a body that is not JSON is not. */
function sameTemplate(answered: string, wanted: string): boolean {
	try {
		return canonical(JSON.parse(answered)) === wanted
	} catch {
		return false
	}
}

/** A read of the stack: by name (`null` when none is listed) or by id (`DELETE_COMPLETE` once it is deleted). */
type StackRead = { readonly stackId: string; readonly status: StackStatus | 'DELETE_COMPLETE' } | null

/** What a read that may be sent again answered, or `UNREAD` when AWS asked to read again later. */
const UNREAD = Symbol('unread')
async function readAgainLater<T>(read: () => Promise<T>): Promise<T | typeof UNREAD> {
	try {
		return await read()
	} catch (error) {
		// A read changes nothing, so a throttle or a lost answer is read again at the next poll, within the deadline.
		if (error instanceof AwsError && error.retryable) return UNREAD
		throw error
	}
}

export interface EnsureEnvironmentStackInput {
	readonly cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack' | 'getTemplate' | 'createStack' | 'updateStack'>
	readonly stack: AwsEnvironmentStack
	readonly signal: AbortSignal
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly log: (line: string) => void
	readonly now?: () => number
	/** A `ClientRequestToken`, one per call sent. */
	readonly newToken?: () => string
}

/**
 * Brings the environment's stack to the rendered template and waits until it serves: creates it when absent, updates
 * it when the template it holds differs, and waits while CloudFormation works.
 *
 * - The template is compared as JSON (`GetTemplate`'s body parsed, keys in any order), so an unchanged stack is never
 *   updated: a no-op update is refused with a `ValidationError` only its message names, which would fail every later
 *   deploy. UNVERIFIED: that `GetTemplate` answers a JSON template's body as JSON; a body that is not is updated.
 * - After a create the stack is read by its id (`describeStack`), which answers `DELETE_COMPLETE` once a failed create
 *   was deleted (`OnFailure=DELETE`), so a create that fails before the first read is reported as failed, not as a
 *   timeout. Absence is decided by `ListStacks` alone (`findStack`).
 * - A read refused for rate or with a lost answer is read again at the next poll; a refused write fails the run.
 * - Refused: a create or an update of its own that failed, a stack an operator must repair (`*_FAILED`,
 *   `ROLLBACK_COMPLETE`, an unexecuted change set), a template past `MAX_TEMPLATE_BYTES` (named, not a bare refusal),
 *   and a wait past `AWS_STACK_TIMEOUT_MS`.
 */
export async function ensureEnvironmentStack(input: EnsureEnvironmentStackInput): Promise<void> {
	const { cloudFormation, stack, signal, sleep, log } = input
	const now = input.now ?? Date.now
	const newToken = input.newToken ?? (() => crypto.randomUUID())
	const body = JSON.stringify(stack.template)
	const name = stack.stackName
	const bytes = new TextEncoder().encode(body).byteLength
	if (bytes > MAX_TEMPLATE_BYTES) {
		throw new Error(`aws: the stack ${name}'s template is ${bytes} bytes, past the ${MAX_TEMPLATE_BYTES} CloudFormation takes inline`)
	}
	const wanted = canonical(stack.template)
	const giveUpAt = now() + AWS_STACK_TIMEOUT_MS
	let sent: 'create' | 'update' | null = null
	// The stack's id once a create answered it or a read listed it: from then on it is read by its id.
	let stackId: string | null = null
	for (;;) {
		signal.throwIfAborted()
		const id: string | null = stackId
		const found: StackRead | typeof UNREAD = await readAgainLater<StackRead>(() =>
			id === null ? cloudFormation.findStack(name, signal) : cloudFormation.describeStack(id, signal)
		)
		if (found === UNREAD) {
			// Read again at the next poll.
		} else if (found === null || found.status === 'DELETE_COMPLETE') {
			if (sent === 'create' && found !== null) {
				throw new Error(`aws: creating the stack ${name} failed and CloudFormation deleted it; its events say why`)
			}
			// No stack (or the one this call followed is gone): create one. Another creator that won the name is followed
			// from the next read on.
			stackId = null
			try {
				stackId = await cloudFormation.createStack({ name, templateBody: body, tags: stack.tags, token: newToken() }, signal)
				sent = 'create'
				log(`aws: creating the stack ${name}`)
			} catch (error) {
				if (!(error instanceof AwsError && error.code === 'AlreadyExistsException')) throw error
				sent = null
			}
		} else {
			stackId = found.stackId
			if (SETTLED.has(found.status)) {
				if (found.status === 'UPDATE_ROLLBACK_COMPLETE' && sent === 'update') {
					throw new Error(`aws: updating the stack ${name} failed and CloudFormation rolled it back; its events say why`)
				}
				const answered = await readAgainLater(() => cloudFormation.getTemplate(name, signal))
				if (answered !== UNREAD) {
					if (sameTemplate(answered, wanted)) {
						log(`aws: the stack ${name} is current`)
						return
					}
					if (sent === 'update') throw new Error(`aws: the stack ${name} holds another template than the update sent`)
					await cloudFormation.updateStack({ name, templateBody: body, token: newToken() }, signal)
					sent = 'update'
					log(`aws: updating the stack ${name}`)
				}
			} else if (!MOVING.has(found.status)) {
				throw new Error(`aws: the stack ${name} is ${found.status}; an operator must repair or delete it before a deploy`)
			}
		}
		if (now() >= giveUpAt) throw new Error(`aws: the stack ${name} did not settle within ${AWS_STACK_TIMEOUT_MS / 60_000} minutes`)
		await sleep(AWS_STACK_POLL_MS, signal)
	}
}
