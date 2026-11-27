// The platform services' foundation (the AWS idea's checklist, step 11, the services' step): what the task
// definitions of IAM, Control, Operations, the platform proxy and the database setup name, from one stack the operator
// applies before the access stack and the services.
//
// - **One task, one identity.** Each task family (`fabrika_platform_<task>`) has an execution role of its own, which
//   pulls its own image, writes its own log group and reads its own parameters alone: `/fabrika/platform/<task>/*`. A
//   secret two services share (IAM's RPC key, the proxy key, the sync key) is written once per reader under each one's
//   path, so no role reads another's. A service's database URL is one of its own parameters, which the operator's
//   command derives from the service's password under the database's path and is the only writer of. The setup alone
//   reads the database's path: the master's password, and the services' passwords, which it sets.
// - **The task roles.** Control's is the access stack's (`fabrika-control`); Operations' reaches its blob bucket alone;
//   IAM, the proxy and the setup call no AWS API and take none.
// - **One security group per task, rules exact.** The platform proxy admits only the platform balancer's group, on its
//   request and health ports, and dials the three services on their port. Each service admits only who calls it: IAM
//   the proxy, Control (its RPC) and Operations (its RPC); Control the proxy and IAM (the mail relay); Operations the
//   proxy and Control (the catalog sync). Every service and the setup reach the database's subnets on 5432 and the
//   internet on 443 (AWS's endpoints, GitHub, the OIDC provider, the platform's own public hosts), nothing else. Each
//   group's default egress is replaced, as the database's is.
// - **Service Connect of its own.** The services address each other as `iam:3000`, `control:3000` and
//   `operations:3000` in the `fabrika-platform` namespace, as on Zerops. Control's role is denied naming it on any
//   service it creates or updates (`access.ts`, by its ARN, an output here), so no application's task joins it.
// - **Two buckets**, private and TLS only: Control's run logs, which the access stack grants Control's role, and
//   Operations' blobs.
//
// Everything is under `fabrika/platform/`, `fabrika-platform-` and `fabrika_platform_`, out of Control's reach, and no
// resource carries a tag key Control's grants read.
//
// UNVERIFIED: the resources' properties follow the CloudFormation reference, and that the VPC's DNS resolver is
// reached whatever a task's group allows follows the VPC documentation; none was checked against an account.

import { PLATFORM_PROXY_HEALTH_PORT, PLATFORM_PROXY_PORT, PLATFORM_SERVICE_PORT } from '@fabrika/installation-init'
import type { JsonValue } from '@fabrika/provider-contract'
import { allow, AWS_LOG_RETENTION_DAYS, policy, trust } from '../environment-stack'
import type { AwsStack } from '../stack'
import { AWS_PLATFORM_FAMILY_PREFIX, AWS_PLATFORM_NAMESPACE, AWS_PLATFORM_PATH, awsRunLogsBucket } from './access'
import type { AwsBalancersOutputs } from './balancers'
import { AWS_DATABASE_PARAMETERS, awsDatabaseSubnetCidrs } from './database'
import { AWS_PLATFORM_PROXY_REPOSITORY, AWS_SERVICES_REPOSITORY } from './images'
import type { AwsNetworkOutputs } from './network'

/** The foundation's stack: under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_RUNTIME_STACK = 'fabrika-platform-runtime'
export { AWS_PLATFORM_NAMESPACE, awsRunLogsBucket }
/** The port IAM, Control and Operations listen on: the installation model's (ADR-0092), as on Zerops. */
export const AWS_PLATFORM_SERVICE_PORT = PLATFORM_SERVICE_PORT
/** The platform proxy's request port and its health route's, as a namespace proxy's: the installation model's. */
export const AWS_PLATFORM_PROXY_PORT = PLATFORM_PROXY_PORT
export const AWS_PLATFORM_PROXY_HEALTH_PORT = PLATFORM_PROXY_HEALTH_PORT
const POSTGRES_PORT = 5432
const HTTPS_PORT = 443

/** A task of the platform's: the three services, their proxy, and the database setup. */
export type AwsPlatformTask = 'iam' | 'control' | 'operations' | 'proxy' | 'setup'
export const AWS_PLATFORM_TASKS: readonly AwsPlatformTask[] = ['iam', 'control', 'operations', 'proxy', 'setup']
/** The three services: each a long-running ECS service with a database of its own. */
export type AwsPlatformServiceTask = 'iam' | 'control' | 'operations'
export const AWS_PLATFORM_SERVICE_TASKS: readonly AwsPlatformServiceTask[] = ['iam', 'control', 'operations']
const SERVICE_TASKS = AWS_PLATFORM_SERVICE_TASKS

/** A task's family: under the prefix Control is denied every task definition action on. */
export function awsPlatformTaskFamily(task: AwsPlatformTask): string {
	return `${AWS_PLATFORM_FAMILY_PREFIX}${task}`
}

/** The Parameter Store path a task's own variables and secrets are written under, which its execution role alone reads. */
export function awsPlatformParameters(task: AwsPlatformTask): string {
	return `${AWS_PLATFORM_PATH}${task}/`
}

/** A task's log group. */
export function awsPlatformLogGroup(task: AwsPlatformTask): string {
	return `/fabrika/platform/${task}`
}

/** A task's execution role, under the platform's path. */
export function awsPlatformExecutionRole(task: AwsPlatformTask): string {
	return `fabrika-platform-${task}-execution`
}

/** Operations' task role, the only task role this stack creates. */
export const AWS_OPERATIONS_TASK_ROLE = 'fabrika-platform-operations'

/** Operations' blob bucket. */
export function awsOperationsBucket(accountId: string): string {
	return `fabrika-operations-${accountId}`
}

export interface AwsRuntimeInput {
	readonly accountId: string
	readonly region: string
	/** The platform's network (`network.ts`), the only one any of these tasks runs in. */
	readonly platform: AwsNetworkOutputs
	/** The balancers' outputs: the platform balancer's group, the only one the platform proxy admits. */
	readonly balancers: Pick<AwsBalancersOutputs, 'platformBalancerGroupId'>
}

/** An account id and a region as AWS names them, the forms every stack of the platform checks. */
export const AWS_ACCOUNT_ID_FORM = /^\d{12}$/
export const AWS_REGION_FORM = /^[a-z]{2}(?:-[a-z]+)+-\d$/
const SECURITY_GROUP_ID = /^sg-[0-9a-f]{8,17}$/

const GROUPS: Readonly<Record<AwsPlatformTask, string>> = {
	iam: 'IamGroup',
	control: 'ControlGroup',
	operations: 'OperationsGroup',
	proxy: 'ProxyGroup',
	setup: 'SetupGroup',
}

const name = (value: string): JsonValue => [{ Key: 'Name', Value: value }]
const groupId = (task: AwsPlatformTask): JsonValue => ({ 'Fn::GetAtt': [GROUPS[task], 'GroupId'] })

/**
 * A grant on a bucket of this account alone (`s3:ResourceAccount`): a bucket's name is global, so a grant by name would
 * reach another account's bucket of that name if this one were ever gone.
 */
function ownBucket(actions: readonly string[], resources: readonly string[], accountId: string): JsonValue {
	return { Effect: 'Allow', Action: [...actions], Resource: [...resources], Condition: { StringEquals: { 's3:ResourceAccount': accountId } } }
}

/** The private, TLS-only, encrypted bucket `bucket`. */
function bucketResources(logical: string, bucket: string): Record<string, JsonValue> {
	return {
		[logical]: {
			Type: 'AWS::S3::Bucket',
			// Kept when the stack goes: its name is global and predictable, so a deleted one could be another account's next.
			DeletionPolicy: 'Retain',
			UpdateReplacePolicy: 'Retain',
			Properties: {
				BucketName: bucket,
				PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
				OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
				BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
			},
		},
		[`${logical}Policy`]: {
			Type: 'AWS::S3::BucketPolicy',
			Properties: {
				Bucket: { Ref: logical },
				PolicyDocument: {
					Version: '2012-10-17',
					Statement: [{
						Effect: 'Deny',
						Principal: '*',
						Action: 's3:*',
						Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
						Condition: { Bool: { 'aws:SecureTransport': 'false' } },
					}],
				},
			},
		},
	}
}

/** The foundation's stack: the namespace, the groups and their rules, the log groups, the roles and the buckets. */
export function awsRuntimeStack(input: AwsRuntimeInput): AwsStack {
	const { accountId: a, region: r, platform } = input
	if (!AWS_ACCOUNT_ID_FORM.test(a) || !AWS_REGION_FORM.test(r)) throw new Error('aws: the account id or region is of another form')
	if (!SECURITY_GROUP_ID.test(input.balancers.platformBalancerGroupId)) throw new Error("aws: the platform balancer's group id is of another form")
	const databaseSubnets = awsDatabaseSubnetCidrs(platform)
	const resources: Record<string, JsonValue> = {
		Namespace: {
			Type: 'AWS::ServiceDiscovery::HttpNamespace',
			Properties: { Name: AWS_PLATFORM_NAMESPACE, Description: 'fabrika: the platform services' },
		},
	}

	for (const task of AWS_PLATFORM_TASKS) {
		resources[GROUPS[task]] = {
			Type: 'AWS::EC2::SecurityGroup',
			Properties: {
				// No apostrophe in any description here: EC2 takes a group's and a rule's in a-z, A-Z, 0-9, spaces and
				// `._-:/()#,@[]+=&;{}!$*` alone.
				GroupDescription: `fabrika: the platform ${task} task`,
				VpcId: platform.vpcId,
				// The default egress replaced: the rules below are all it reaches.
				SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'none' }],
				Tags: name(`fabrika-platform-${task}`),
			},
		}
	}

	let rule = 0
	const ingress = (task: AwsPlatformTask, port: number, source: JsonValue, description: string): void => {
		resources[`Ingress${rule++}`] = {
			Type: 'AWS::EC2::SecurityGroupIngress',
			Properties: { GroupId: groupId(task), IpProtocol: 'tcp', FromPort: port, ToPort: port, SourceSecurityGroupId: source, Description: description },
		}
	}
	const egress = (task: AwsPlatformTask, port: number, to: { readonly group: JsonValue } | { readonly cidr: string }, description: string): void => {
		resources[`Egress${rule++}`] = {
			Type: 'AWS::EC2::SecurityGroupEgress',
			Properties: {
				GroupId: groupId(task),
				IpProtocol: 'tcp',
				FromPort: port,
				ToPort: port,
				...('group' in to ? { DestinationSecurityGroupId: to.group } : { CidrIp: to.cidr }),
				Description: description,
			},
		}
	}
	/** `from` dials `to` on the services' port: one egress rule on the caller and one ingress rule on the callee. */
	const dials = (from: AwsPlatformTask, to: AwsPlatformServiceTask, why: string): void => {
		egress(from, AWS_PLATFORM_SERVICE_PORT, { group: groupId(to) }, `to ${to}, ${why}`)
		ingress(to, AWS_PLATFORM_SERVICE_PORT, groupId(from), `from ${from}, ${why}`)
	}

	// The platform proxy: from the platform balancer alone, to the three services.
	for (const port of [AWS_PLATFORM_PROXY_PORT, AWS_PLATFORM_PROXY_HEALTH_PORT]) {
		ingress(
			'proxy',
			port,
			input.balancers.platformBalancerGroupId,
			port === AWS_PLATFORM_PROXY_PORT ? 'the platform balancer' : 'the balancer health checks',
		)
	}
	for (const service of SERVICE_TASKS) dials('proxy', service, 'behind the proxy')
	dials('control', 'iam', 'its RPC')
	dials('operations', 'iam', 'its RPC')
	dials('iam', 'control', 'the mail relay')
	dials('control', 'operations', 'the catalog sync')
	// Everyone: the internet on HTTPS; the services and the setup the database's subnets.
	for (const task of AWS_PLATFORM_TASKS) egress(task, HTTPS_PORT, { cidr: '0.0.0.0/0' }, 'HTTPS')
	for (const task of [...SERVICE_TASKS, 'setup'] satisfies AwsPlatformTask[]) {
		for (const cidr of databaseSubnets) egress(task, POSTGRES_PORT, { cidr }, 'the database')
	}

	const repository = (name: string) => `arn:aws:ecr:${r}:${a}:repository/${name}`
	const parameter = (path: string) => `arn:aws:ssm:${r}:${a}:parameter${path}`
	for (const task of AWS_PLATFORM_TASKS) {
		const logGroup = awsPlatformLogGroup(task)
		resources[`${GROUPS[task].replace('Group', '')}LogGroup`] = {
			Type: 'AWS::Logs::LogGroup',
			Properties: { LogGroupName: logGroup, RetentionInDays: AWS_LOG_RETENTION_DAYS },
		}
		const parameters = [parameter(`${awsPlatformParameters(task)}*`)]
		// A service reads its whole database URL from its own path; the setup alone reads the database's path.
		if (task === 'setup') parameters.push(parameter(`${AWS_DATABASE_PARAMETERS}*`))
		resources[`${GROUPS[task].replace('Group', '')}ExecutionRole`] = {
			Type: 'AWS::IAM::Role',
			Properties: {
				RoleName: awsPlatformExecutionRole(task),
				Path: AWS_PLATFORM_PATH,
				AssumeRolePolicyDocument: trust('ecs-tasks.amazonaws.com', a, { like: `arn:aws:ecs:${r}:${a}:*` }),
				Policies: [
					policy('execution', [
						allow(['ecr:GetAuthorizationToken'], ['*']),
						allow(
							['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
							[repository(task === 'proxy' ? AWS_PLATFORM_PROXY_REPOSITORY : AWS_SERVICES_REPOSITORY)],
						),
						allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [`arn:aws:logs:${r}:${a}:log-group:${logGroup}:*`]),
						allow(['ssm:GetParameters'], parameters),
					]),
				],
			},
		}
	}

	Object.assign(resources, bucketResources('RunLogsBucket', awsRunLogsBucket(a)), bucketResources('OperationsBucket', awsOperationsBucket(a)))
	resources['OperationsTaskRole'] = {
		Type: 'AWS::IAM::Role',
		Properties: {
			RoleName: AWS_OPERATIONS_TASK_ROLE,
			Path: AWS_PLATFORM_PATH,
			AssumeRolePolicyDocument: trust('ecs-tasks.amazonaws.com', a, { like: `arn:aws:ecs:${r}:${a}:*` }),
			Policies: [
				policy('blobs', [
					ownBucket(['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], [`arn:aws:s3:::${awsOperationsBucket(a)}/*`], a),
					ownBucket(['s3:ListBucket'], [`arn:aws:s3:::${awsOperationsBucket(a)}`], a),
				]),
			],
		},
	}

	const outputs: Record<string, JsonValue> = { NamespaceArn: { Value: { 'Fn::GetAtt': ['Namespace', 'Arn'] } } }
	for (const task of AWS_PLATFORM_TASKS) outputs[`${GROUPS[task]}Id`] = { Value: groupId(task) }
	return {
		stackName: AWS_RUNTIME_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: "fabrika: the platform services' foundation",
			Resources: resources,
			Outputs: outputs,
		},
		tags: { 'fabrika:platform': 'runtime' },
	}
}

/** What the foundation's stack created under names AWS chose. */
export interface AwsRuntimeOutputs {
	/** The platform's Service Connect namespace, which Control's role is denied naming. */
	readonly namespaceArn: string
	/** Each task's security group. */
	readonly groupIds: Readonly<Record<AwsPlatformTask, string>>
}

/** A Cloud Map namespace's ARN. */
const NAMESPACE_ARN = /^arn:aws(?:-[a-z]{1,10}){0,2}:servicediscovery:[a-z0-9-]{1,32}:\d{12}:namespace\/ns-[a-z0-9]{1,64}$/

/** The foundation's outputs as the stack answers them, or an error naming the output of another form. */
export function awsRuntimeOutputs(outputs: Readonly<Record<string, string>>): AwsRuntimeOutputs {
	const read = (key: string, form: RegExp): string => {
		const value = outputs[key] ?? ''
		if (!form.test(value)) throw new Error(`aws: the runtime stack's ${key} output is of another form`)
		return value
	}
	const group = (task: AwsPlatformTask): string => read(`${GROUPS[task]}Id`, SECURITY_GROUP_ID)
	const groupIds = { iam: group('iam'), control: group('control'), operations: group('operations'), proxy: group('proxy'), setup: group('setup') }
	if (new Set(Object.values(groupIds)).size !== AWS_PLATFORM_TASKS.length) throw new Error("aws: the runtime stack's outputs name one group twice")
	return { namespaceArn: read('NamespaceArn', NAMESPACE_ARN), groupIds }
}
