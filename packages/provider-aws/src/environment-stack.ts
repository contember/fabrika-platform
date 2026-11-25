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
// - The security group of the environment's tasks, in the installation's VPC: outbound, and in only from its
//   namespace proxy's group (the namespace stack's), on the application's port; its id is the stack's output.
//   A change of the installation's VPC (or of the group's description) replaces the group, and does not converge:
//   CloudFormation creates the new group, then fails to delete the old one while the service's tasks still hold it,
//   and the deploy waits on that cleanup before it moves the service. Moving an installation to another VPC is an
//   operator's step (move the services, then delete the old groups), never a deploy's.
// - Not the ECS service: its task definition is the deploy's, which registers one per run and creates the service with
//   the first (`deploy.ts`). A service in the stack would name a revision the next stack update could roll back to.
//
// `awsEnvironmentStack` is pure: it renders the template. `ensureEnvironmentStack` applies it (`stack.ts`), which a
// deploy runs before its steps.
//
// UNVERIFIED: the resource types, their properties, the build image and the IAM actions below follow AWS's published
// references (CloudFormation's resource reference, the service authorization reference); none was checked against an
// account. SecureString parameters under the account's default `aws/ssm` key need no `kms:Decrypt` grant of their own.

import type { JsonValue } from '@fabrika/provider-contract'
import { ecrLifecyclePolicy } from './aws/ecr'
import { AWS_BUILDSPEC } from './build'
import type { AwsAppTarget } from './codecs'
import { AWS_APPLICATION_PORT } from './ecs-task'
import { AWS_KEPT_IMAGES, type AwsEnvironmentResources, awsEnvironmentResources } from './resources'
import { AWS_BUILD_QUEUED_TIMEOUT_MINUTES, AWS_BUILD_TIMEOUT_MINUTES } from './run-attempt'
import { ensureStack, type EnsureStackInput } from './stack'

/** How long both log groups keep their events (one of CloudWatch Logs' values). */
export const AWS_LOG_RETENTION_DAYS = 30
/** The build's image: Amazon Linux on ARM, because the tasks run on ARM64 (`ecs.ts`). */
export const AWS_BUILD_IMAGE = 'aws/codebuild/amazonlinux-aarch64-standard:3.0'
const IAM_PATH = '/fabrika/apps/'
/** The output that names the environment's security group, whose id EC2 chooses. */
const SECURITY_GROUP_OUTPUT = 'SecurityGroupId'
/** A VPC's, a subnet's and a security group's id. */
const VPC_ID = /^vpc-[0-9a-f]{8,17}$/
const SUBNET_ID = /^subnet-[0-9a-f]{8,17}$/
const SECURITY_GROUP_ID = /^sg-[0-9a-f]{8,17}$/
/** The most subnets an `awsvpc` network takes. */
const MAX_SUBNETS = 16

/**
 * The installation's network, Control's own configuration like the rest of the installation's coordinates: the VPC an
 * environment's security group is created in, the subnets its tasks run in, and whether a task gets a public address
 * (a small installation's way out without a NAT gateway). No environment stores it; every deploy reads the current one.
 */
export interface AwsInstallationNetwork {
	readonly vpcId: string
	readonly subnets: readonly string[]
	readonly publicIp: boolean
}

/** `network` as given, or an error naming the field of another form (never a value). */
export function checkInstallationNetwork(network: AwsInstallationNetwork): AwsInstallationNetwork {
	if (!VPC_ID.test(network.vpcId)) throw new Error('aws: the installation network names a VPC id of another form')
	const { subnets } = network
	if (
		subnets.length === 0 || subnets.length > MAX_SUBNETS || new Set(subnets).size !== subnets.length
		|| !subnets.every((subnet) => SUBNET_ID.test(subnet))
	) {
		throw new Error(`aws: the installation network names no subnets, more than ${MAX_SUBNETS}, one twice or one of another form`)
	}
	return { vpcId: network.vpcId, subnets: [...subnets], publicIp: network.publicIp }
}

/** What the environment's stack created under names AWS chose. */
export interface AwsEnvironmentStackOutputs {
	/** The group of the environment's tasks: the service's and the init tasks'. */
	readonly securityGroupId: string
}

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
 * The managed policy every role Control's stacks create carries as its permissions boundary, an application
 * environment's and a namespace proxy's (`namespace.ts`): the installation's (step 11 creates it), at one derived name,
 * so Control's policy can require exactly it on every role write.
 */
export function awsAppsPermissionsBoundary(accountId: string): string {
	return `arn:aws:iam::${accountId}:policy/fabrika/fabrika-apps-boundary`
}

/** A trust policy that lets `service` take the role on behalf of this account, and only for `sourceArn`. */
export function trust(service: string, accountId: string, sourceArn: { readonly equals: string } | { readonly like: string }): JsonValue {
	const condition: { [operator: string]: JsonValue } = { StringEquals: { 'aws:SourceAccount': accountId } }
	if ('equals' in sourceArn) condition['ArnEquals'] = { 'aws:SourceArn': sourceArn.equals }
	else condition['ArnLike'] = { 'aws:SourceArn': sourceArn.like }
	return {
		Version: '2012-10-17',
		Statement: [{ Effect: 'Allow', Principal: { Service: service }, Action: 'sts:AssumeRole', Condition: condition }],
	}
}

/** An inline policy of `statements`. */
export function policy(name: string, statements: readonly JsonValue[]): JsonValue {
	return { PolicyName: name, PolicyDocument: { Version: '2012-10-17', Statement: [...statements] } }
}

export function allow(actions: readonly string[], resources: readonly string[]): JsonValue {
	return { Effect: 'Allow', Action: [...actions], Resource: [...resources] }
}

/**
 * The stack of one application environment of `installation`. `proxy` is the security group of the namespace proxy the
 * environment is placed behind, the one group its tasks admit, on the application's port alone; `null` admits nothing.
 */
export function awsEnvironmentStack(
	appId: string,
	env: string,
	installation: AwsAppTarget,
	network: Pick<AwsInstallationNetwork, 'vpcId'>,
	proxy: { readonly securityGroupId: string } | null,
): AwsEnvironmentStack {
	if (!VPC_ID.test(network.vpcId)) throw new Error('aws: the VPC id is not one EC2 names a VPC by')
	if (proxy !== null && !SECURITY_GROUP_ID.test(proxy.securityGroupId)) {
		throw new Error('aws: the namespace proxy names no security group of the form EC2 gives one')
	}
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
			SecurityGroup: {
				Type: 'AWS::EC2::SecurityGroup',
				Properties: {
					GroupDescription: `fabrika: the tasks of ${appId}/${env}`,
					VpcId: network.vpcId,
					// No ingress rule of its own: nothing reaches the application's port, not even another task of the
					// installation, but its namespace's proxy (`ProxyIngress`, ADR-0022 rule 5). The tasks reach out: the image
					// pull, Parameter Store and the logs, and whatever the application itself calls.
					SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'outbound' }],
					Tags: tags,
				},
			},
			// The namespace proxy's group, on the application's port alone: the only way in. A rule of its own, so moving the
			// environment to another namespace replaces the rule, never the group the service's tasks hold.
			...(proxy === null ? {} : {
				ProxyIngress: {
					Type: 'AWS::EC2::SecurityGroupIngress',
					Properties: {
						GroupId: { 'Fn::GetAtt': ['SecurityGroup', 'GroupId'] },
						IpProtocol: 'tcp',
						FromPort: AWS_APPLICATION_PORT,
						ToPort: AWS_APPLICATION_PORT,
						SourceSecurityGroupId: proxy.securityGroupId,
						Description: 'the namespace proxy',
					},
				},
			}),
		},
		Outputs: {
			[SECURITY_GROUP_OUTPUT]: { Value: { 'Fn::GetAtt': ['SecurityGroup', 'GroupId'] } },
		},
	}
	return { stackName: resources.stackName, resources, template, tags: { 'fabrika:app': appId, 'fabrika:env': env } }
}

/** The outputs the template declares, each of its form; a stack without them is one this deploy cannot run in. */
function outputsOf(name: string, outputs: Readonly<Record<string, string>>): AwsEnvironmentStackOutputs {
	const securityGroupId = outputs[SECURITY_GROUP_OUTPUT] ?? ''
	if (!SECURITY_GROUP_ID.test(securityGroupId)) throw new Error(`aws: the stack ${name} names no security group of the form EC2 gives one`)
	return { securityGroupId }
}

export interface EnsureEnvironmentStackInput extends EnsureStackInput {
	readonly stack: AwsEnvironmentStack
}

/**
 * Brings the environment's stack to the rendered template and waits until it serves (`ensureStack`), and answers its
 * outputs, each of its form.
 */
export async function ensureEnvironmentStack(input: EnsureEnvironmentStackInput): Promise<AwsEnvironmentStackOutputs> {
	return outputsOf(input.stack.stackName, await ensureStack(input))
}
