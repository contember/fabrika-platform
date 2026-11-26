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
//   the `fabrika-platform-` stacks, a cluster of their own (`fabrika-platform`), task definition families of their own
//   (`fabrika_platform_`) and a balancer of their own, none of which a grant names; and explicit denies keep Control
//   off the platform's roles and task definitions whatever else is granted.
// - **The applications' network alone** (decided 2026-11-26, `network.ts`). ECS joins a service to the target group it
//   names with ECS's own role, and no condition key of this policy names a target group, so the platform's target
//   group is in a VPC of its own with no route from the applications'. A service Control creates or updates is held
//   to the applications' task subnets (`ecs:subnet`); a security group Control creates is in the applications' VPC
//   alone. `RunTask` takes no key on the subnets or the security groups, so Control's role is denied it (and
//   `StartTask`) outright: a one-off task is started by the task runner (`task-runner.ts`, decided 2026-11-26), which
//   Control may only invoke, and which places it in the applications' cluster and task subnets of its own
//   configuration.
// - **No role past the boundary.** `iam:CreateRole` and `iam:PutRolePolicy` only with `iam:PermissionsBoundary` equal to
//   the boundary, which allows only what an environment's and a namespace proxy's roles need. No `AttachRolePolicy`, so
//   no managed policy reaches a role Control writes. Control is denied removing or replacing a boundary, and every write
//   to a policy under `fabrika/`, so it can neither lift the boundary nor widen it. What the boundary does not hold is
//   who may take such a role: no condition key reads a trust policy, and the stacks need `CreateRole` and
//   `UpdateAssumeRolePolicy`. A misused Control could so write a bounded role another account may take, which outlives
//   its own credentials; within the boundary that reaches every application's parameters and repositories. Step 13
//   names the detection: IAM Access Analyzer's external access findings on `role/fabrika/apps/*` and
//   `role/fabrika/namespaces/*`.
// - **No tag written into its reach.** A grant reads a tag of ECS, EC2, Elastic Load Balancing and Cloud Map
//   resources alone, and a tag write of those is granted only in the call that creates the resource
//   (`ecs:CreateAction`, `ec2:CreateAction`, `elasticloadbalancing:CreateAction`); Cloud Map and ACM get none. IAM, ECR
//   and CloudWatch Logs tags are written standalone, and no grant reads one. The tag conditions test presence
//   (`fabrika:env`, `fabrika:namespace`), not an installation's value, so no stack of the platform's may carry either
//   key: none does, which a test pins.
// - **Actions that take no resource** (the `Describe*` of EC2 and Elastic Load Balancing, `ecr:GetAuthorizationToken`,
//   `cloudformation:ListStacks`, ACM's request) are granted on `*`.
// - **Task definitions.** `RegisterTaskDefinition` is granted on `task-definition/*` with the platform's families
//   (`fabrika_platform_*`) denied, and so are `CreateService` and `UpdateService` naming one, as the task runner's role
//   is denied running one: no application family can take that name (one has exactly one `_`, a namespace's starts
//   `ns_`). A task definition Control registers can only pass the applications' and namespaces' roles (`iam:PassRole`).
// - **Not in the platform's Service Connect namespace.** IAM, Control and Operations address each other in a namespace
//   of their own (`runtime.ts`). A service Control creates or updates may name a Service Connect namespace, and
//   Control's Cloud Map grants are held by a tag the platform's namespace does not carry; so Control's role is denied
//   `CreateService` and `UpdateService` naming the platform's (`ecs:namespace`, by its ARN or its name). The remaining
//   reach, accepted: a service may also name Cloud Map services in `serviceRegistries`, no condition key reads that, and
//   ECS registers the tasks with its own role, so Control could perhaps register an application's tasks in a Cloud Map
//   service of the platform's namespace (`iam`, which ECS creates for Service Connect). No route joins the two VPCs, so
//   the effect is the platform's calls to such an address failing, never a request reaching the application. Step 13
//   settles whether ECS accepts such a registry from Control's role and whether Service Connect's clients take the
//   instance.
// - **No task started by Control.** See the applications' network above: the task runner starts an init task, and
//   every Lambda action on it but invoking it is denied, as on the certificate broker.
// - **No certificate on a listener.** Elastic Load Balancing scopes `AddListenerCertificates` by the listener alone, so a
//   role holding it could attach any certificate of the account, a platform host's among them, to the applications'
//   listener. Control's role holds neither listener certificate action: a namespace's certificates go on through the
//   certificate broker (`certificate-broker.ts`, decided 2026-11-26), which it may only invoke, and which refuses any
//   certificate naming an installation host. Every other Lambda action on the broker is denied.
//
// The grants follow the plan's step 11, narrowed to what the code calls: Control deletes no stack and reads no stack
// event, so neither is granted.
//
// UNVERIFIED, like the plan's grants: the actions CloudFormation's resource handlers call with the caller's
// credentials, which condition keys each service evaluates, that a SecureString under the AWS-managed key needs no KMS
// grant, and that each managed policy fits IAM's 6,144 characters as AWS counts them. The live check (step 13) settles
// them before an installation relies on the policy.

import type { JsonValue } from '@fabrika/provider-contract'
import { CERTIFICATE_HOST } from '../aws/acm'
import { LISTENER_ARN } from '../aws/elb'
import { allow, awsAppsPermissionsBoundary } from '../environment-stack'
import type { AwsStack } from '../stack'
import {
	AWS_CERTIFICATE_BROKER,
	AWS_CERTIFICATE_BROKER_RUNTIME,
	AWS_CERTIFICATE_BROKER_SOURCE,
	AWS_MAX_INLINE_SOURCE,
	awsCertificateBrokerArn,
} from './certificate-broker'
import { AWS_TASK_RUNNER, AWS_TASK_RUNNER_SOURCE, awsTaskRunnerArn } from './task-runner'

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
/**
 * The platform's task definition families start with it: two `_`, which no application family holds (exactly one) and
 * no namespace proxy's starts with (`ns_`). Control is denied every task definition action on them.
 */
export const AWS_PLATFORM_FAMILY_PREFIX = 'fabrika_platform_'
/** How long an uploaded source archive is kept: a build fetches it within the hour, a retry within the day. */
export const AWS_SOURCES_DAYS = 7
/** The most characters IAM takes in one managed policy. */
export const AWS_MAX_MANAGED_POLICY = 6144

/** The sources bucket's name: one installation per account, so the account names it. */
export function awsSourcesBucket(accountId: string): string {
	return `fabrika-sources-${accountId}`
}

/** Control's run logs bucket (the runtime stack's, `runtime.ts`), which Control's role alone writes. */
export function awsRunLogsBucket(accountId: string): string {
	return `fabrika-run-logs-${accountId}`
}

/**
 * The platform's Service Connect namespace (the runtime stack's), which IAM, Control and Operations address each other
 * in. Control's role is denied naming it on a service it creates or updates.
 */
export const AWS_PLATFORM_NAMESPACE = 'fabrika-platform'

export interface AwsAccessInput {
	readonly accountId: string
	readonly region: string
	/** The applications' HTTPS listener (`balancers.ts`), the only listener Control's role reaches. */
	readonly appsListenerArn: string
	/** The applications' VPC (`network.ts`), the only one Control creates a security group in. */
	readonly vpcId: string
	/** The applications' task subnets (`network.ts`), the only ones a service Control creates or updates runs in. */
	readonly taskSubnetIds: readonly string[]
	/**
	 * The installation's own hosts (`awsBalancersEnvironment`'s `FABRIKA_AWS_INSTALLATION_HOSTS`): the certificate broker
	 * attaches no certificate naming one. Lower-case.
	 */
	readonly installationHosts: readonly string[]
	/** The platform's Service Connect namespace (`runtime.ts`'s output), which Control's role is denied naming. */
	readonly platformNamespaceArn: string
}

const ACCOUNT_ID = /^\d{12}$/
/** A Cloud Map namespace's ARN. */
const NAMESPACE_ARN = /^arn:aws(?:-[a-z]{1,10}){0,2}:servicediscovery:[a-z0-9-]{1,32}:\d{12}:namespace\/ns-[a-z0-9]{1,64}$/
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/

/** `input` as given, or an error naming the part of another form (never a value). */
export function checkAwsAccessInput(input: AwsAccessInput): AwsAccessInput {
	if (!ACCOUNT_ID.test(input.accountId)) throw new Error('aws: the account id is not twelve digits')
	if (!REGION.test(input.region)) throw new Error('aws: the region is not of the form AWS names one')
	if (!LISTENER_ARN.test(input.appsListenerArn) || !input.appsListenerArn.includes(`:${input.region}:${input.accountId}:`)) {
		throw new Error("aws: the applications' listener is not a listener of this account and region")
	}
	if (!/^vpc-[0-9a-f]{8,17}$/.test(input.vpcId)) throw new Error("aws: the installation's VPC id is of another form")
	const subnets = input.taskSubnetIds
	if (subnets.length === 0 || !subnets.every((id) => /^subnet-[0-9a-f]{8,17}$/.test(id)) || new Set(subnets).size !== subnets.length) {
		throw new Error("aws: the applications' task subnets are none, one twice, or one of another form")
	}
	const hosts = input.installationHosts
	if (hosts.length === 0 || !hosts.every((host) => CERTIFICATE_HOST.test(host)) || new Set(hosts).size !== hosts.length) {
		throw new Error("aws: the installation's own hosts are none, one twice, or one that is not a lower-case host name")
	}
	if (!NAMESPACE_ARN.test(input.platformNamespaceArn) || !input.platformNamespaceArn.includes(`:${input.region}:${input.accountId}:`)) {
		throw new Error("aws: the platform's namespace is not a Cloud Map namespace of this account and region")
	}
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
	const services = `arn:aws:ecs:${r}:${a}:service/${AWS_APPS_CLUSTER}/*`
	const taskDefinitions = `arn:aws:ecs:${r}:${a}:task-definition/*`
	const platformTaskDefinitions = `arn:aws:ecs:${r}:${a}:task-definition/${AWS_PLATFORM_FAMILY_PREFIX}*`
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
	const ownAccount: JsonValue = { StringEquals: { 's3:ResourceAccount': a } }

	return [
		{
			name: 'fabrika-control-runtime',
			statements: [
				// A service in the applications' task subnets alone: named on its create (its key present, every value one
				// of them), and on an update that names any (one that names none keeps the subnets its create was held to).
				allowIf(['ecs:CreateService'], [services], {
					'ForAllValues:StringEquals': { 'ecs:subnet': [...input.taskSubnetIds] },
					Null: { 'ecs:subnet': 'false' },
				}),
				allowIf(['ecs:UpdateService'], [services], { 'ForAllValues:StringEquals': { 'ecs:subnet': [...input.taskSubnetIds] } }),
				allow(['ecs:DescribeServices'], [services]),
				allow(['ecs:DescribeServiceDeployments'], [`arn:aws:ecs:${r}:${a}:service-deployment/${AWS_APPS_CLUSTER}/*`]),
				allow(['ecs:DescribeServiceRevisions'], [`arn:aws:ecs:${r}:${a}:service-revision/${AWS_APPS_CLUSTER}/*`]),
				allow(['ecs:DescribeTasks'], [`arn:aws:ecs:${r}:${a}:task/${AWS_APPS_CLUSTER}/*`]),
				// An init task through the task runner alone: `RunTask` is denied below.
				allow(['lambda:InvokeFunction'], [awsTaskRunnerArn(a, r)]),
				// What a registered definition can pass is held by `iam:PassRole` below; the platform's families are denied.
				allow(['ecs:RegisterTaskDefinition'], [taskDefinitions]),
				// Tags only as ECS creates the service or the task definition they belong to.
				allowIf(['ecs:TagResource'], ['*'], { StringEquals: { 'ecs:CreateAction': ['CreateService', 'RegisterTaskDefinition'] } }),
				allowIf(['iam:PassRole'], roles, { StringEquals: { 'iam:PassedToService': ['ecs-tasks.amazonaws.com', 'codebuild.amazonaws.com'] } }),
				allow(['ecr:DescribeImages'], repositories),
				allow(['ssm:PutParameter', 'ssm:DeleteParameter'], both((prefix) => `arn:aws:ssm:${r}:${a}:parameter/fabrika/${prefix}/*`)),
				// A one-level listing of a path; Parameter Store scopes no listing by resource.
				allow(['ssm:DescribeParameters'], ['*']),
				allow(['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild', 'codebuild:ListBuildsForProject'], projects),
				// The uploads, and the presigned read a build fetches its archive with, signed by Control. Every S3 grant is
				// held to this account's buckets (`s3:ResourceAccount`): a name is global, so a grant by name alone would
				// reach another account's bucket of that name if this one were ever gone.
				allowIf(['s3:PutObject', 's3:GetObject', 's3:AbortMultipartUpload'], [`arn:aws:s3:::${awsSourcesBucket(a)}/sources/*`], ownAccount),
				// The run logs Control keeps (`FABRIKA_CONTROL_RUN_LOGS_*`), in a bucket of their own.
				allowIf(['s3:PutObject', 's3:GetObject', 's3:DeleteObject', 's3:AbortMultipartUpload'], [`arn:aws:s3:::${awsRunLogsBucket(a)}/*`], ownAccount),
				allowIf(['s3:ListBucket'], [`arn:aws:s3:::${awsRunLogsBucket(a)}`], ownAccount),
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
				// The applications' listener alone: a namespace's host rules. Its certificates go on through the broker.
				allow(['elasticloadbalancing:CreateRule'], [appsListenerArn]),
				allow(['lambda:InvokeFunction'], [awsCertificateBrokerArn(appsListenerArn)]),
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
				// The broker: invoked, nothing else (its code, its configuration, its permissions stay the operator's).
				{ Effect: 'Deny', NotAction: ['lambda:InvokeFunction'], Resource: [awsCertificateBrokerArn(appsListenerArn)] },
				// No listener certificate, whatever else is granted: only the broker attaches one.
				deny(['elasticloadbalancing:AddListenerCertificates', 'elasticloadbalancing:RemoveListenerCertificates'], ['*']),
				// No task Control starts itself, whatever else is granted: neither call takes a key on the network.
				deny(['ecs:RunTask', 'ecs:StartTask'], ['*']),
				// The task runner: invoked, nothing else.
				{ Effect: 'Deny', NotAction: ['lambda:InvokeFunction'], Resource: [awsTaskRunnerArn(a, r)] },
				// The platform's task definitions: never registered into, or named by a service of Control's.
				deny(['ecs:RegisterTaskDefinition'], [platformTaskDefinitions]),
				{
					Effect: 'Deny',
					Action: ['ecs:CreateService', 'ecs:UpdateService'],
					Resource: ['*'],
					// The request may name the definition by its ARN or by its family (`family` or `family:revision`), so
					// both forms; `StringLike`, as `ArnLike` would not match a bare family.
					Condition: { StringLike: { 'ecs:task-definition': [platformTaskDefinitions, `${AWS_PLATFORM_FAMILY_PREFIX}*`] } },
				},
				{
					Effect: 'Deny',
					Action: ['ecs:CreateService', 'ecs:UpdateService'],
					Resource: ['*'],
					// The platform's Service Connect namespace, by its ARN or its name, whichever the request names: no
					// application's or namespace proxy's task joins the platform's services.
					Condition: { StringLike: { 'ecs:namespace': [input.platformNamespaceArn, AWS_PLATFORM_NAMESPACE] } },
				},
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
				// An ECS task of this account and region takes it: the source ARN is any ECS one here. What keeps an
				// application's task from taking it is that no one but the operator's stacks may pass it (Control is denied
				// `iam:PassRole` on the platform's roles). Narrowing the source to the platform's cluster waits on step 13
				// showing which source ARN ECS sends.
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
			// Kept when the stack goes: its name is global and predictable, so a deleted one could be another account's next.
			DeletionPolicy: 'Retain',
			UpdateReplacePolicy: 'Retain',
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
	// The certificate broker: its role reaches the applications' listener's certificates and the certificates' names,
	// nothing else; its configuration is the listener and the installation's hosts, never a request's.
	if (AWS_CERTIFICATE_BROKER_SOURCE.length > AWS_MAX_INLINE_SOURCE) {
		throw new Error("aws: the certificate broker's source is past CloudFormation's inline bound")
	}
	resources['CertificateBrokerLogGroup'] = {
		Type: 'AWS::Logs::LogGroup',
		Properties: { LogGroupName: `/aws/lambda/${AWS_CERTIFICATE_BROKER}`, RetentionInDays: 30 },
	}
	resources['CertificateBrokerRole'] = {
		Type: 'AWS::IAM::Role',
		Properties: {
			RoleName: AWS_CERTIFICATE_BROKER,
			Path: AWS_PLATFORM_PATH,
			// Lambda takes an execution role without the confused-deputy keys; only a principal that may pass this role (the
			// operator's stack, never Control, which is denied `iam:PassRole` on the platform's roles) can give it a function.
			AssumeRolePolicyDocument: {
				Version: '2012-10-17',
				Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
			},
			Policies: [{
				PolicyName: 'broker',
				PolicyDocument: {
					Version: '2012-10-17',
					Statement: [
						allow(['elasticloadbalancing:AddListenerCertificates', 'elasticloadbalancing:RemoveListenerCertificates'], [input.appsListenerArn]),
						allow(['acm:DescribeCertificate'], [`arn:aws:acm:${region}:${accountId}:certificate/*`]),
						allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${AWS_CERTIFICATE_BROKER}:*`]),
					],
				},
			}],
		},
	}
	resources['CertificateBroker'] = {
		Type: 'AWS::Lambda::Function',
		DependsOn: ['CertificateBrokerLogGroup'],
		Properties: {
			FunctionName: AWS_CERTIFICATE_BROKER,
			Runtime: AWS_CERTIFICATE_BROKER_RUNTIME,
			Handler: 'index.handler',
			Role: { 'Fn::GetAtt': ['CertificateBrokerRole', 'Arn'] },
			Timeout: 30,
			MemorySize: 128,
			Code: { ZipFile: AWS_CERTIFICATE_BROKER_SOURCE },
			Environment: { Variables: { LISTENER_ARN: input.appsListenerArn, RESERVED_HOSTS: input.installationHosts.join(',') } },
		},
	}
	// The task runner: its role runs an application's or a namespace's task definition in the applications' cluster and
	// passes their roles, nothing else; its configuration is that cluster and the applications' task subnets.
	if (AWS_TASK_RUNNER_SOURCE.length > AWS_MAX_INLINE_SOURCE) {
		throw new Error("aws: the task runner's source is past CloudFormation's inline bound")
	}
	const appsCluster = `arn:aws:ecs:${region}:${accountId}:cluster/${AWS_APPS_CLUSTER}`
	resources['TaskRunnerLogGroup'] = {
		Type: 'AWS::Logs::LogGroup',
		Properties: { LogGroupName: `/aws/lambda/${AWS_TASK_RUNNER}`, RetentionInDays: 30 },
	}
	resources['TaskRunnerRole'] = {
		Type: 'AWS::IAM::Role',
		Properties: {
			RoleName: AWS_TASK_RUNNER,
			Path: AWS_PLATFORM_PATH,
			// As the broker's: only the operator's stack may pass it.
			AssumeRolePolicyDocument: {
				Version: '2012-10-17',
				Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
			},
			Policies: [{
				PolicyName: 'runner',
				PolicyDocument: {
					Version: '2012-10-17',
					Statement: [
						allowIf(['ecs:RunTask'], [`arn:aws:ecs:${region}:${accountId}:task-definition/*`], { ArnEquals: { 'ecs:cluster': appsCluster } }),
						deny(['ecs:RunTask'], [`arn:aws:ecs:${region}:${accountId}:task-definition/${AWS_PLATFORM_FAMILY_PREFIX}*`]),
						allowIf(
							['iam:PassRole'],
							['apps', 'namespaces'].map((prefix) => `arn:aws:iam::${accountId}:role/fabrika/${prefix}/*`),
							{ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
						),
						allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [`arn:aws:logs:${region}:${accountId}:log-group:/aws/lambda/${AWS_TASK_RUNNER}:*`]),
					],
				},
			}],
		},
	}
	resources['TaskRunner'] = {
		Type: 'AWS::Lambda::Function',
		DependsOn: ['TaskRunnerLogGroup'],
		Properties: {
			FunctionName: AWS_TASK_RUNNER,
			Runtime: AWS_CERTIFICATE_BROKER_RUNTIME,
			Handler: 'index.handler',
			Role: { 'Fn::GetAtt': ['TaskRunnerRole', 'Arn'] },
			Timeout: 30,
			MemorySize: 128,
			Code: { ZipFile: AWS_TASK_RUNNER_SOURCE },
			Environment: { Variables: { CLUSTER: AWS_APPS_CLUSTER, SUBNETS: input.taskSubnetIds.join(',') } },
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
