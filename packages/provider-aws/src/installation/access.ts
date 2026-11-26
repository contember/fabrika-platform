// The installation's access (the AWS idea's checklist, step 11), from one stack the operator applies: the permissions
// boundary every role Control's stacks create carries, Control's own role, the applications' ECS cluster and the
// sources bucket. The policy is rendered with the installation's account, region and listener as literals, so what
// it allows can be read and tested as it will be sent.
//
// What Control's role reaches, and what it never does:
//
// - **Its prefixes alone.** Every grant names `fabrika/apps/` or `fabrika/namespaces/` (roles, repositories, log
//   groups, parameters), the `fabrika_` projects, the `fabrika-app-`, `fabrika-ns-` and `fabrika-nh-` stacks, the
//   applications' cluster and the applications' listener. The platform's own resources are under `fabrika/platform/`,
//   the `fabrika-platform-` stacks, a cluster of their own (`fabrika-platform`) and a balancer of their own, none of
//   which a grant names; and an explicit deny keeps Control off the platform's roles whatever else is granted.
// - **No role past the boundary.** `iam:CreateRole` and `iam:PutRolePolicy` only with `iam:PermissionsBoundary` equal to
//   the boundary, which allows only what an environment's and a namespace proxy's roles need. No `AttachRolePolicy`, so
//   no managed policy reaches a role Control writes. Control is denied removing or replacing a boundary, and every write
//   to a policy under `fabrika/`, so it can neither lift the boundary nor widen it.
// - **No tag written into its reach.** A tag write is granted only in the call that creates the resource
//   (`ecs:CreateAction`, `ec2:CreateAction`, `elasticloadbalancing:CreateAction`); ACM and Cloud Map get none.
// - **Actions that take no resource** (the `Describe*` of EC2 and Elastic Load Balancing, `ecr:GetAuthorizationToken`,
//   `ecs:RegisterTaskDefinition`, `cloudformation:ListStacks`, ACM's request) are granted on `*`; a task definition
//   Control registers can still only pass the applications' and namespaces' roles (`iam:PassRole`).
//
// OPEN, the plan's decision on the platform's certificates: Elastic Load Balancing scopes `AddListenerCertificates` by
// the listener alone, so this role can attach any certificate of the account, a platform host's among them, to the
// applications' listener. The plan weighs accepting it against a certificate broker (recommended), TLS outside ACM for
// the platform, and an account of its own.
//
// The grants follow the plan's step 11, narrowed to what the code calls: Control deletes no stack and reads no stack
// event, so neither is granted.
//
// UNVERIFIED, like the plan's grants: the actions CloudFormation's resource handlers call with the caller's
// credentials, which condition keys each service evaluates, that a SecureString under the AWS-managed key needs no KMS
// grant, and that each managed policy fits IAM's 6,144 characters as AWS counts them. The live check (step 13) settles
// them before an installation relies on the policy.

import type { JsonValue } from '@fabrika/provider-contract'
import { LISTENER_ARN } from '../aws/elb'
import { allow, awsAppsPermissionsBoundary } from '../environment-stack'
import type { AwsStack } from '../stack'

/** The access stack's name: under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_ACCESS_STACK = 'fabrika-platform-access'
/** The applications' and namespace proxies' cluster, the only one Control's role reaches. */
export const AWS_APPS_CLUSTER = 'fabrika-apps'
/** The platform's own services' cluster (Control's, IAM's, Operations', the platform proxy's): Control never reaches it. */
export const AWS_PLATFORM_CLUSTER = 'fabrika-platform'
/** Control's role, under the platform's path, which no grant of its own names. */
export const AWS_CONTROL_ROLE = 'fabrika-control'
/** The platform's IAM path: its roles and policies, out of Control's reach. */
export const AWS_PLATFORM_PATH = '/fabrika/platform/'
/** How long an uploaded source archive is kept: a build fetches it within the hour, a retry within the day. */
export const AWS_SOURCES_DAYS = 7
/** The most characters IAM takes in one managed policy. */
export const AWS_MAX_MANAGED_POLICY = 6144

/** The sources bucket's name: one installation per account, so the account names it. */
export function awsSourcesBucket(accountId: string): string {
	return `fabrika-sources-${accountId}`
}

export interface AwsAccessInput {
	readonly accountId: string
	readonly region: string
	/** The applications' HTTPS listener (`balancers.ts`), the only listener Control's role reaches. */
	readonly appsListenerArn: string
	/** The installation's VPC (`network.ts`), the only one Control creates a security group in. */
	readonly vpcId: string
}

const ACCOUNT_ID = /^\d{12}$/
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/

/** `input` as given, or an error naming the part of another form (never a value). */
export function checkAwsAccessInput(input: AwsAccessInput): AwsAccessInput {
	if (!ACCOUNT_ID.test(input.accountId)) throw new Error('aws: the account id is not twelve digits')
	if (!REGION.test(input.region)) throw new Error('aws: the region is not of the form AWS names one')
	if (!LISTENER_ARN.test(input.appsListenerArn) || !input.appsListenerArn.includes(`:${input.region}:${input.accountId}:`)) {
		throw new Error("aws: the applications' listener is not a listener of this account and region")
	}
	if (!/^vpc-[0-9a-f]{8,17}$/.test(input.vpcId)) throw new Error("aws: the installation's VPC id is of another form")
	return input
}

/** A grant held to a condition. */
function allowIf(actions: readonly string[], resources: readonly string[], condition: JsonValue): JsonValue {
	return { Effect: 'Allow', Action: [...actions], Resource: [...resources], Condition: condition }
}

function deny(actions: readonly string[], resources: readonly string[]): JsonValue {
	return { Effect: 'Deny', Action: [...actions], Resource: [...resources] }
}

/** One managed policy of Control's role: its name and its statements. */
export interface AwsManagedPolicy {
	readonly name: string
	readonly statements: readonly JsonValue[]
}

/**
 * The boundary every role Control's stacks create carries (`awsAppsPermissionsBoundary`): the union of what an
 * environment's roles and a namespace proxy's roles are granted (`environment-stack.ts`, `namespace.ts`), each on the
 * two prefixes. A role's own policy narrows it to its environment's or namespace's resources alone.
 */
export function awsAppsBoundaryStatements(input: AwsAccessInput): readonly JsonValue[] {
	const { accountId: a, region: r } = checkAwsAccessInput(input)
	const both = (shape: (prefix: string) => string): string[] => ['apps', 'namespaces'].map(shape)
	return [
		allow(['ecr:GetAuthorizationToken'], ['*']),
		allow(
			[
				'ecr:BatchCheckLayerAvailability',
				'ecr:GetDownloadUrlForLayer',
				'ecr:BatchGetImage',
				'ecr:InitiateLayerUpload',
				'ecr:UploadLayerPart',
				'ecr:CompleteLayerUpload',
				'ecr:PutImage',
			],
			both((prefix) => `arn:aws:ecr:${r}:${a}:repository/fabrika/${prefix}/*`),
		),
		allow(['logs:CreateLogStream', 'logs:PutLogEvents'], both((prefix) => `arn:aws:logs:${r}:${a}:log-group:/fabrika/${prefix}/*`)),
		allow(['ssm:GetParameters'], both((prefix) => `arn:aws:ssm:${r}:${a}:parameter/fabrika/${prefix}/*`)),
	]
}

/**
 * Control's role's policies, each a managed policy of its own (IAM's bound on one policy is 6,144 characters, and the
 * grants are more): what Control's code calls, what CloudFormation calls with Control's credentials while applying an
 * environment's, a namespace's or a hosts stack, and the denies that hold whatever else is granted.
 */
export function awsControlPolicies(input: AwsAccessInput): readonly AwsManagedPolicy[] {
	const { accountId: a, region: r, appsListenerArn } = checkAwsAccessInput(input)
	const both = (shape: (prefix: string) => string): string[] => ['apps', 'namespaces'].map(shape)
	const cluster = `arn:aws:ecs:${r}:${a}:cluster/${AWS_APPS_CLUSTER}`
	const boundary = awsAppsPermissionsBoundary(a)
	const roles = both((prefix) => `arn:aws:iam::${a}:role/fabrika/${prefix}/*`)
	const projects = [`arn:aws:codebuild:${r}:${a}:project/fabrika_*`]
	const repositories = both((prefix) => `arn:aws:ecr:${r}:${a}:repository/fabrika/${prefix}/*`)
	const logGroups = both((prefix) => `arn:aws:logs:${r}:${a}:log-group:/fabrika/${prefix}/*`)
	const stacks = ['fabrika-app-*', 'fabrika-ns-*', 'fabrika-nh-*'].map((name) => `arn:aws:cloudformation:${r}:${a}:stack/${name}/*`)
	// The listener's rules: `listener-rule/app/<balancer>/<id>/<id>/<rule id>`.
	const listenerRules = `${appsListenerArn.replace(':listener/', ':listener-rule/')}/*`
	const targetGroups = `arn:aws:elasticloadbalancing:${r}:${a}:targetgroup/*`
	const createdWith = (key: string, action: string): JsonValue => ({ StringEquals: { [key]: action } })
	const tagged = (key: string): JsonValue => ({ Null: { [key]: 'false' } })

	return [
		{
			name: 'fabrika-control-runtime',
			statements: [
				allow(
					['ecs:CreateService', 'ecs:UpdateService', 'ecs:DescribeServices'],
					[`arn:aws:ecs:${r}:${a}:service/${AWS_APPS_CLUSTER}/*`],
				),
				allow(['ecs:DescribeServiceDeployments'], [`arn:aws:ecs:${r}:${a}:service-deployment/${AWS_APPS_CLUSTER}/*`]),
				allow(['ecs:DescribeServiceRevisions'], [`arn:aws:ecs:${r}:${a}:service-revision/${AWS_APPS_CLUSTER}/*`]),
				allow(['ecs:DescribeTasks'], [`arn:aws:ecs:${r}:${a}:task/${AWS_APPS_CLUSTER}/*`]),
				// A task runs in the applications' cluster alone, whatever task definition it names.
				allowIf(['ecs:RunTask'], [`arn:aws:ecs:${r}:${a}:task-definition/*`], { ArnEquals: { 'ecs:cluster': cluster } }),
				// ECS scopes no task definition's registration; what one can pass is held by `iam:PassRole` below.
				allow(['ecs:RegisterTaskDefinition'], ['*']),
				// Tags only as ECS creates the service, the task definition or the task they belong to.
				allowIf(['ecs:TagResource'], ['*'], { StringEquals: { 'ecs:CreateAction': ['CreateService', 'RegisterTaskDefinition', 'RunTask'] } }),
				allowIf(['iam:PassRole'], roles, { StringEquals: { 'iam:PassedToService': ['ecs-tasks.amazonaws.com', 'codebuild.amazonaws.com'] } }),
				allow(['ecr:DescribeImages'], repositories),
				allow(['ssm:PutParameter', 'ssm:DeleteParameter'], both((prefix) => `arn:aws:ssm:${r}:${a}:parameter/fabrika/${prefix}/*`)),
				// A one-level listing of a path; Parameter Store scopes no listing by resource.
				allow(['ssm:DescribeParameters'], ['*']),
				allow(['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild', 'codebuild:ListBuildsForProject'], projects),
				// The uploads, and the presigned read a build fetches its archive with, signed by Control.
				allow(
					['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload'],
					[`arn:aws:s3:::${awsSourcesBucket(a)}/sources/*`],
				),
				// An IAM wildcard spans `:`, so a group's pattern covers its streams too.
				allow(['logs:GetLogEvents', 'logs:FilterLogEvents'], logGroups),
				allow(['acm:RequestCertificate', 'acm:DescribeCertificate'], ['*']),
				allow(['elasticloadbalancing:DescribeRules', 'elasticloadbalancing:DescribeListenerCertificates'], ['*']),
				allow(['cloudformation:CreateStack', 'cloudformation:UpdateStack', 'cloudformation:DescribeStacks', 'cloudformation:GetTemplate'], stacks),
				allow(['cloudformation:ListStacks'], ['*']),
			],
		},
		{
			name: 'fabrika-control-roles',
			statements: [
				// A role Control's stacks create, or a policy they write on one, carries the boundary: nothing past it.
				allowIf(['iam:CreateRole', 'iam:PutRolePolicy'], roles, { StringEquals: { 'iam:PermissionsBoundary': boundary } }),
				allow(
					['iam:GetRole', 'iam:GetRolePolicy', 'iam:DeleteRolePolicy', 'iam:UpdateAssumeRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:DeleteRole'],
					roles,
				),
				allow(['codebuild:CreateProject', 'codebuild:UpdateProject', 'codebuild:DeleteProject', 'codebuild:BatchGetProjects'], projects),
				allow(
					[
						'ecr:CreateRepository',
						'ecr:PutLifecyclePolicy',
						'ecr:GetLifecyclePolicy',
						'ecr:PutImageTagMutability',
						'ecr:TagResource',
						'ecr:UntagResource',
						'ecr:ListTagsForResource',
						'ecr:DescribeRepositories',
						'ecr:DeleteRepository',
					],
					repositories,
				),
				allow(
					['logs:CreateLogGroup', 'logs:PutRetentionPolicy', 'logs:TagResource', 'logs:UntagResource', 'logs:ListTagsForResource', 'logs:DeleteLogGroup'],
					logGroups,
				),
				allow(['logs:DescribeLogGroups'], ['*']),
			],
		},
		{
			name: 'fabrika-control-network',
			statements: [
				// An environment's or a namespace proxy's group: created tagged in the installation's VPC, written only while tagged.
				allowIf(['ec2:CreateSecurityGroup'], [`arn:aws:ec2:${r}:${a}:security-group/*`], tagged('aws:RequestTag/fabrika:env')),
				allow(['ec2:CreateSecurityGroup'], [`arn:aws:ec2:${r}:${a}:vpc/${input.vpcId}`]),
				allowIf(['ec2:CreateTags'], [`arn:aws:ec2:${r}:${a}:security-group/*`], createdWith('ec2:CreateAction', 'CreateSecurityGroup')),
				allowIf(
					[
						'ec2:AuthorizeSecurityGroupEgress',
						'ec2:RevokeSecurityGroupEgress',
						'ec2:AuthorizeSecurityGroupIngress',
						'ec2:RevokeSecurityGroupIngress',
						'ec2:DeleteSecurityGroup',
					],
					[`arn:aws:ec2:${r}:${a}:security-group/*`],
					tagged('aws:ResourceTag/fabrika:env'),
				),
				allow(['ec2:DescribeSecurityGroups', 'ec2:DescribeSecurityGroupRules', 'ec2:DescribeVpcs'], ['*']),
				// A namespace's Service Connect namespace: created tagged, then reached by its tag alone; no standalone tag write.
				allowIf(['servicediscovery:CreateHttpNamespace'], ['*'], tagged('aws:RequestTag/fabrika:namespace')),
				allowIf(
					[
						'servicediscovery:GetNamespace',
						'servicediscovery:UpdateHttpNamespace',
						'servicediscovery:ListTagsForResource',
						'servicediscovery:DeleteNamespace',
					],
					[`arn:aws:servicediscovery:${r}:${a}:namespace/*`],
					tagged('aws:ResourceTag/fabrika:namespace'),
				),
				allow(['servicediscovery:GetOperation'], ['*']),
			],
		},
		{
			name: 'fabrika-control-balancer',
			statements: [
				// A namespace proxy's target group: created tagged, tagged only as it is created, written only while tagged.
				allowIf(['elasticloadbalancing:CreateTargetGroup'], [targetGroups], tagged('aws:RequestTag/fabrika:namespace')),
				allowIf(['elasticloadbalancing:AddTags'], [targetGroups], createdWith('elasticloadbalancing:CreateAction', 'CreateTargetGroup')),
				allowIf(
					['elasticloadbalancing:ModifyTargetGroup', 'elasticloadbalancing:ModifyTargetGroupAttributes', 'elasticloadbalancing:DeleteTargetGroup'],
					[targetGroups],
					tagged('aws:ResourceTag/fabrika:namespace'),
				),
				// The applications' listener alone: a namespace's hosts, their rules and certificates.
				allow(
					['elasticloadbalancing:CreateRule', 'elasticloadbalancing:AddListenerCertificates', 'elasticloadbalancing:RemoveListenerCertificates'],
					[appsListenerArn],
				),
				allow(['elasticloadbalancing:ModifyRule', 'elasticloadbalancing:DeleteRule', 'elasticloadbalancing:SetRulePriorities'], [listenerRules]),
				allow(
					[
						'elasticloadbalancing:DescribeTargetGroups',
						'elasticloadbalancing:DescribeTargetGroupAttributes',
						'elasticloadbalancing:DescribeTags',
						'elasticloadbalancing:DescribeListeners',
						'elasticloadbalancing:DescribeLoadBalancers',
					],
					['*'],
				),
			],
		},
		{
			name: 'fabrika-control-guards',
			statements: [
				// The boundary stays on every role, and no policy under `fabrika/` changes: Control can neither lift nor widen it.
				deny(['iam:DeleteRolePermissionsBoundary', 'iam:PutRolePermissionsBoundary', 'iam:AttachRolePolicy'], ['*']),
				deny(
					['iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'],
					[`arn:aws:iam::${a}:policy/fabrika/*`],
				),
				// The platform's own roles, Control's among them, whatever else is granted.
				deny(['iam:*'], [`arn:aws:iam::${a}:role${AWS_PLATFORM_PATH}*`]),
				deny(['iam:PassRole'], [`arn:aws:iam::${a}:role${AWS_PLATFORM_PATH}*`]),
			],
		},
	]
}

/** The access stack: the boundary, Control's role and its policies, the applications' cluster and the sources bucket. */
export function awsAccessStack(input: AwsAccessInput): AwsStack {
	const { accountId, region } = checkAwsAccessInput(input)
	const resources: Record<string, JsonValue> = {
		AppsBoundary: {
			Type: 'AWS::IAM::ManagedPolicy',
			Properties: {
				ManagedPolicyName: 'fabrika-apps-boundary',
				Path: '/fabrika/',
				Description: "fabrika: the ceiling of every role Control's stacks create",
				PolicyDocument: { Version: '2012-10-17', Statement: [...awsAppsBoundaryStatements(input)] },
			},
		},
		ControlRole: {
			Type: 'AWS::IAM::Role',
			Properties: {
				RoleName: AWS_CONTROL_ROLE,
				Path: AWS_PLATFORM_PATH,
				// Control's task in the platform's cluster alone takes it.
				AssumeRolePolicyDocument: {
					Version: '2012-10-17',
					Statement: [{
						Effect: 'Allow',
						Principal: { Service: 'ecs-tasks.amazonaws.com' },
						Action: 'sts:AssumeRole',
						Condition: {
							StringEquals: { 'aws:SourceAccount': accountId },
							ArnLike: { 'aws:SourceArn': `arn:aws:ecs:${region}:${accountId}:*` },
						},
					}],
				},
				Tags: [{ Key: 'fabrika:platform', Value: 'control' }],
			},
		},
		AppsCluster: {
			Type: 'AWS::ECS::Cluster',
			Properties: {
				ClusterName: AWS_APPS_CLUSTER,
				CapacityProviders: ['FARGATE'],
				ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
			},
		},
		PlatformCluster: {
			Type: 'AWS::ECS::Cluster',
			Properties: {
				ClusterName: AWS_PLATFORM_CLUSTER,
				CapacityProviders: ['FARGATE'],
				ClusterSettings: [{ Name: 'containerInsights', Value: 'disabled' }],
			},
		},
		SourcesBucket: {
			Type: 'AWS::S3::Bucket',
			Properties: {
				BucketName: awsSourcesBucket(accountId),
				PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
				OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
				BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
				LifecycleConfiguration: {
					Rules: [
						{ Id: 'sources', Status: 'Enabled', Prefix: 'sources/', ExpirationInDays: AWS_SOURCES_DAYS },
						{ Id: 'uploads', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
					],
				},
			},
		},
		SourcesBucketPolicy: {
			Type: 'AWS::S3::BucketPolicy',
			Properties: {
				Bucket: { Ref: 'SourcesBucket' },
				PolicyDocument: {
					Version: '2012-10-17',
					Statement: [{
						Effect: 'Deny',
						Principal: '*',
						Action: 's3:*',
						Resource: [`arn:aws:s3:::${awsSourcesBucket(accountId)}`, `arn:aws:s3:::${awsSourcesBucket(accountId)}/*`],
						Condition: { Bool: { 'aws:SecureTransport': 'false' } },
					}],
				},
			},
		},
	}
	for (const [index, managed] of awsControlPolicies(input).entries()) {
		resources[`ControlPolicy${index}`] = {
			Type: 'AWS::IAM::ManagedPolicy',
			Properties: {
				ManagedPolicyName: managed.name,
				Path: AWS_PLATFORM_PATH,
				Roles: [{ Ref: 'ControlRole' }],
				PolicyDocument: { Version: '2012-10-17', Statement: [...managed.statements] },
			},
		}
	}
	return {
		stackName: AWS_ACCESS_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: "fabrika: the installation's access",
			Resources: resources,
			Outputs: {
				ControlRoleArn: { Value: { 'Fn::GetAtt': ['ControlRole', 'Arn'] } },
				AppsBoundaryArn: { Value: { Ref: 'AppsBoundary' } },
			},
		},
		tags: { 'fabrika:platform': 'access' },
	}
}

/** Control's variables for the installation's coordinates (`packages/control/src/aws/provider.ts`). */
export function awsAccessEnvironment(input: AwsAccessInput): Readonly<Record<string, string>> {
	const { accountId, region } = checkAwsAccessInput(input)
	return {
		FABRIKA_AWS_ACCOUNT_ID: accountId,
		FABRIKA_AWS_REGION: region,
		FABRIKA_AWS_CLUSTER: AWS_APPS_CLUSTER,
		FABRIKA_AWS_SOURCES_BUCKET: awsSourcesBucket(accountId),
	}
}
