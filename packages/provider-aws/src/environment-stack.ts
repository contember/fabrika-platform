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
// Pure: it renders a template; applying it (CreateStack, UpdateStack) is the caller's.
//
// UNVERIFIED: the resource types, their properties, the build image and the IAM actions below follow AWS's published
// references (CloudFormation's resource reference, the service authorization reference); none was checked against an
// account. SecureString parameters under the account's default `aws/ssm` key need no `kms:Decrypt` grant of their own.

import type { JsonValue } from '@fabrika/provider-contract'
import { ecrLifecyclePolicy } from './aws/ecr'
import { AWS_BUILDSPEC } from './build'
import type { AwsAppTarget } from './codecs'
import { AWS_KEPT_IMAGES, type AwsEnvironmentResources, awsEnvironmentResources } from './control'
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
	return { stackName: resources.stackName, resources, template }
}
