// The installation's access: the boundary covers every grant of the roles Control's stacks create (rendered here from
// the real stacks), Control's role can create no role without it and lift or widen it never, reaches nothing of the
// platform's own, writes a tag only as it creates the resource, and grants on `*` only the actions that take no
// resource; every policy fits IAM's bound.

import type { JsonValue } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { awsAppsPermissionsBoundary, awsEnvironmentStack } from '../../environment-stack'
import { awsNamespaceStack } from '../../namespace'
import {
	AWS_ACCESS_STACK,
	AWS_APPS_CLUSTER,
	AWS_MAX_MANAGED_POLICY,
	AWS_PLATFORM_CLUSTER,
	AWS_PLATFORM_FAMILY_PREFIX,
	AWS_PLATFORM_NAMESPACE,
	awsAccessEnvironment,
	type AwsAccessInput,
	awsAccessStack,
	awsAppsBoundaryStatements,
	awsControlPolicies,
	awsSourcesBucket,
	checkAwsAccessInput,
} from '../access'
import { awsBalancersStack } from '../balancers'
import { AWS_DEFAULT_PLATFORM_VPC_CIDR, awsNetworkLayout, awsNetworkOutputs, awsNetworkStack } from '../network'
import { awsRuntimeStack } from '../runtime'
import { AWS_TASK_RUNNER_SOURCE } from '../task-runner'

const certificate = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
/** A network's outputs over `prefix.0.0/16`, its subnet ids numbered from `first`. */
const outputsOf = (prefix: string, first: number) => {
	const subnet = (n: number) => `subnet-0123456789abcde${(first + n).toString(16)}`
	return awsNetworkOutputs({
		VpcId: `vpc-0123456789abcdef${first}`,
		VpcCidr: `${prefix}.0.0/16`,
		TaskSubnetIds: [subnet(0), subnet(1)].join(','),
		TaskSubnetCidrs: `${prefix}.0.0/20,${prefix}.16.0/20`,
		BalancerSubnetIds: [subnet(2), subnet(3)].join(','),
		BalancerSubnetCidrs: `${prefix}.240.0/24,${prefix}.241.0/24`,
	})
}

const LISTENER = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210'
const BROKER = 'arn:aws:lambda:eu-central-1:123456789012:function:fabrika-certificate-broker'
const RUNNER = 'arn:aws:lambda:eu-central-1:123456789012:function:fabrika-task-runner'
const NAMESPACE = 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-0123456789abcdef'
const HOSTS = ['iam.example.com', 'control.example.com', 'operations.example.com', 'apps.example.com']
const input: AwsAccessInput = {
	accountId: '123456789012',
	region: 'eu-central-1',
	appsListenerArn: LISTENER,
	vpcId: 'vpc-0123456789abcdef0',
	taskSubnetIds: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'],
	installationHosts: HOSTS,
	platformNamespaceArn: NAMESPACE,
}
const installation = { accountId: '123456789012', region: 'eu-central-1', cluster: AWS_APPS_CLUSTER, sourcesBucket: awsSourcesBucket('123456789012') }

interface Statement {
	readonly Effect: string
	/** Empty for a statement of `NotAction`. */
	readonly Action: readonly string[]
	readonly NotAction?: readonly string[]
	readonly Resource: readonly string[]
	readonly Condition?: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>
}

/** The statements as IAM reads them: one action and one resource list each. */
function statementsOf(statements: readonly JsonValue[]): readonly Statement[] {
	const parsed: readonly (Omit<Statement, 'Action'> & { readonly Action?: readonly string[] })[] = JSON.parse(JSON.stringify(statements))
	return parsed.map((statement) => ({ ...statement, Action: statement.Action ?? [] }))
}

/** Whether IAM's pattern `pattern` (`*` any run, `?` one character) matches `value`. */
function matches(pattern: string, value: string): boolean {
	const source = [...pattern].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.\\+^$|()[\]{}]/g, '\\$&'))).join('')
	return new RegExp(`^${source}$`).test(value)
}

/** Every grant of the IAM roles in a rendered template: its role's inline policies, resolved where they are literals. */
function roleGrants(template: JsonValue): readonly Statement[] {
	const parsed = JSON.parse(JSON.stringify(template))
	const grants: Statement[] = []
	for (
		const resource of Object.values<{ Type: string; Properties: { Policies?: { PolicyDocument: { Statement: Statement[] } }[] } }>(parsed.Resources)
	) {
		if (resource.Type !== 'AWS::IAM::Role') continue
		for (const inline of resource.Properties.Policies ?? []) grants.push(...inline.PolicyDocument.Statement)
	}
	return grants
}

const control = awsControlPolicies(input).flatMap((managed) => statementsOf(managed.statements))
const allows = control.filter((statement) => statement.Effect === 'Allow')

describe("the installation's access", () => {
	test("the boundary covers every action, on its resource, that an environment's and a namespace proxy's roles are granted", () => {
		const boundary = statementsOf(awsAppsBoundaryStatements(input))
		const environment = awsEnvironmentStack('notes', 'prod', installation, { vpcId: input.vpcId }, { securityGroupId: 'sg-0123456789abcdef1' })
		const namespace = awsNamespaceStack({ id: 'shared', env: 'prod' }, installation, { vpcId: input.vpcId }, {
			securityGroupId: 'sg-0123456789abcdef1',
			vpcCidr: '10.80.0.0/16',
			listenerArn: LISTENER,
			installationHosts: ['iam.example.com'],
			balancerSubnetCidrs: ['10.80.240.0/24', '10.80.241.0/24'],
		})
		const grants = [...roleGrants(environment.template), ...roleGrants(namespace.template)]
		expect(grants.length).toBeGreaterThan(0)
		for (const grant of grants) {
			for (const action of grant.Action) {
				for (const resource of grant.Resource) {
					const covered = boundary.some((statement) =>
						statement.Action.includes(action) && statement.Resource.some((pattern) => matches(pattern, resource))
					)
					expect({ action, resource, covered }).toEqual({ action, resource, covered: true })
				}
			}
		}
	})

	test('every role Control creates, and every policy it writes on one, carries the boundary; no managed policy reaches one', () => {
		const roleWrites = allows.filter((statement) => statement.Action.some((action) => action === 'iam:CreateRole' || action === 'iam:PutRolePolicy'))
		expect(roleWrites.length).toBeGreaterThan(0)
		for (const statement of roleWrites) {
			expect(statement.Condition).toEqual({ StringEquals: { 'iam:PermissionsBoundary': awsAppsPermissionsBoundary(input.accountId) } })
		}
		for (const action of ['iam:AttachRolePolicy', 'iam:PutRolePermissionsBoundary', 'iam:DeleteRolePermissionsBoundary', 'iam:CreatePolicyVersion']) {
			expect(allows.some((statement) => statement.Action.includes(action))).toBe(false)
		}
		const denies = control.filter((statement) => statement.Effect === 'Deny')
		expect(denies.find((statement) => statement.Action.includes('iam:DeleteRolePermissionsBoundary'))?.Resource).toEqual(['*'])
		expect(denies.find((statement) => statement.Action.includes('iam:CreatePolicyVersion'))?.Resource).toEqual([
			'arn:aws:iam::123456789012:policy/fabrika/*',
		])
		expect(denies.find((statement) => statement.Action.includes('iam:*'))?.Resource).toEqual(['arn:aws:iam::123456789012:role/fabrika/platform/*'])
	})

	test("no grant reaches the platform's own: its roles, stacks, cluster, parameters or balancer", () => {
		for (const statement of allows) {
			for (const resource of statement.Resource) {
				expect(resource).not.toContain('fabrika/platform')
				expect(resource).not.toContain('fabrika-platform')
				expect(resource).not.toContain(`/${AWS_PLATFORM_CLUSTER}/`)
				if (resource.includes(':listener/') || resource.includes(':listener-rule/')) {
					expect([LISTENER, `${LISTENER.replace(':listener/', ':listener-rule/')}/*`]).toContain(resource)
				}
			}
		}
	})

	test("a service Control creates or updates runs in the applications' task subnets alone", () => {
		const subnets = { 'ecs:subnet': ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'] }
		expect(allows.find((statement) => statement.Action.includes('ecs:CreateService'))?.Condition).toEqual({
			'ForAllValues:StringEquals': subnets,
			// Present on a create: a `ForAllValues` test of no value at all would pass.
			Null: { 'ecs:subnet': 'false' },
		})
		expect(allows.find((statement) => statement.Action.includes('ecs:UpdateService'))?.Condition).toEqual({ 'ForAllValues:StringEquals': subnets })
		expect(() => checkAwsAccessInput({ ...input, taskSubnetIds: [] })).toThrow('task subnets')
		expect(() => checkAwsAccessInput({ ...input, taskSubnetIds: ['subnet-X'] })).toThrow('task subnets')
	})

	test("the platform's task definitions are never registered into, or named by a service of Control's", () => {
		const platform = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/fabrika_platform_*'
		const denies = control.filter((statement) => statement.Effect === 'Deny')
		expect(denies.find((statement) => statement.Action.includes('ecs:RegisterTaskDefinition'))).toMatchObject({
			Action: ['ecs:RegisterTaskDefinition'],
			Resource: [platform],
		})
		expect(denies.find((statement) => statement.Action.includes('ecs:CreateService'))).toMatchObject({
			Action: ['ecs:CreateService', 'ecs:UpdateService'],
			Resource: ['*'],
			// By its ARN or by its family, whichever the request names.
			Condition: { StringLike: { 'ecs:task-definition': [platform, 'fabrika_platform_*'] } },
		})
		// No application or namespace family falls under the prefix: an application's has one `_`, a namespace's starts `ns_`.
		for (const family of ['notes_prod', 'notes_prod-init', 'ns_shared_prod_proxy', 'fabrika_prod']) {
			expect(matches(`${AWS_PLATFORM_FAMILY_PREFIX}*`, family)).toBe(false)
		}
		expect(matches('fabrika_platform_*', 'fabrika_platform_iam')).toBe(true)
	})

	test("no stack of the platform's tags a resource with a key Control's grants read", () => {
		const stacks = [
			awsNetworkStack(awsNetworkLayout(), 'apps'),
			awsNetworkStack(awsNetworkLayout(AWS_DEFAULT_PLATFORM_VPC_CIDR), 'platform'),
			awsAccessStack(input),
			// Its target group and groups above all: a tag-scoped grant on either would reach the platform's.
			awsBalancersStack({
				apps: outputsOf('10.80', 0),
				platform: outputsOf('10.81', 4),
				hosts: { iam: 'iam.example.com', control: 'control.example.com', operations: 'operations.example.com' },
				certificates: { iam: certificate(1), control: certificate(2), operations: certificate(3) },
				appsDefault: { host: 'apps.example.com', certificate: certificate(4) },
			}),
			// The platform services' groups, roles and namespace.
			awsRuntimeStack({
				accountId: '123456789012',
				region: 'eu-central-1',
				platform: outputsOf('10.81', 4),
				balancers: { platformBalancerGroupId: 'sg-0123456789abcdef9' },
			}),
		]
		for (const stack of stacks) {
			const keys = new Set(Object.keys(stack.tags))
			const resources = Object.values<{ Properties?: { Tags?: readonly { Key: string }[] } }>(JSON.parse(JSON.stringify(stack.template)).Resources)
			for (const resource of resources) for (const tag of resource.Properties?.Tags ?? []) keys.add(tag.Key)
			expect([...keys].filter((key) => key === 'fabrika:env' || key === 'fabrika:namespace')).toEqual([])
		}
	})

	test('Control attaches no certificate to a listener: only the broker does, which Control may invoke and nothing more', () => {
		for (const action of ['elasticloadbalancing:AddListenerCertificates', 'elasticloadbalancing:RemoveListenerCertificates']) {
			expect(allows.some((statement) => statement.Action.includes(action))).toBe(false)
			expect(control.find((statement) => statement.Effect === 'Deny' && statement.Action.includes(action))?.Resource).toEqual(['*'])
		}
		// The broker and the task runner are the only functions Control reaches, and it may only invoke them.
		const invoke = allows.filter((statement) => statement.Action.some((action) => action.startsWith('lambda:')))
		expect(invoke.map((statement) => [statement.Action, statement.Resource])).toEqual([
			[['lambda:InvokeFunction'], [RUNNER]],
			[['lambda:InvokeFunction'], [BROKER]],
		])
		const notActions = control.filter((statement) => statement.NotAction !== undefined)
		expect(notActions.map((statement) => [statement.Effect, statement.NotAction, statement.Resource])).toEqual([
			['Deny', ['lambda:InvokeFunction'], [BROKER]],
			['Deny', ['lambda:InvokeFunction'], [RUNNER]],
		])
	})

	test("no service of Control's joins the platform's Service Connect namespace, named by its ARN or its name", () => {
		const denies = control.filter((statement) => statement.Effect === 'Deny')
		expect(denies.find((statement) => JSON.stringify(statement.Condition ?? {}).includes('ecs:namespace'))).toMatchObject({
			Action: ['ecs:CreateService', 'ecs:UpdateService'],
			Resource: ['*'],
			Condition: { StringLike: { 'ecs:namespace': [NAMESPACE, AWS_PLATFORM_NAMESPACE] } },
		})
		expect(() => checkAwsAccessInput({ ...input, platformNamespaceArn: 'fabrika-platform' })).toThrow("platform's namespace")
		expect(() => checkAwsAccessInput({ ...input, platformNamespaceArn: NAMESPACE.replace('123456789012', '210987654321') })).toThrow(
			"platform's namespace",
		)
	})

	test("Control's run logs: its own bucket alone, the platform's other buckets out of reach", () => {
		const s3 = allows.filter((statement) => statement.Action.some((action) => action.startsWith('s3:')))
		expect(s3.flatMap((statement) => statement.Resource)).toEqual([
			`arn:aws:s3:::${awsSourcesBucket('123456789012')}/sources/*`,
			'arn:aws:s3:::fabrika-run-logs-123456789012/*',
			'arn:aws:s3:::fabrika-run-logs-123456789012',
		])
		// Each held to this account's buckets: a bucket's name is global.
		for (const statement of s3) expect(statement.Condition).toEqual({ StringEquals: { 's3:ResourceAccount': '123456789012' } })
		const bucket = JSON.parse(JSON.stringify(awsAccessStack(input).template)).Resources.SourcesBucket
		expect(bucket).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' })
	})

	test('Control starts no task itself: the task runner does, which Control may invoke and nothing more', () => {
		for (const action of ['ecs:RunTask', 'ecs:StartTask']) {
			expect(allows.some((statement) => statement.Action.includes(action))).toBe(false)
			expect(control.find((statement) => statement.Effect === 'Deny' && statement.Action.includes(action))?.Resource).toEqual(['*'])
		}
		const resources = JSON.parse(JSON.stringify(awsAccessStack(input).template)).Resources
		expect(resources.TaskRunner.Properties).toMatchObject({
			FunctionName: 'fabrika-task-runner',
			Handler: 'index.handler',
			// The applications' cluster and task subnets: the runner's own, never a request's.
			Environment: { Variables: { CLUSTER: AWS_APPS_CLUSTER, SUBNETS: input.taskSubnetIds.join(',') } },
		})
		expect(resources.TaskRunner.Properties.Code.ZipFile).toBe(AWS_TASK_RUNNER_SOURCE)
		expect(AWS_TASK_RUNNER_SOURCE.length).toBeLessThanOrEqual(4096)
		// The source's own platform prefix is the one the policies deny.
		expect(AWS_TASK_RUNNER_SOURCE).toContain(`const PLATFORM = '${AWS_PLATFORM_FAMILY_PREFIX}'`)
		expect(resources.TaskRunnerRole.Properties.Path).toBe('/fabrika/platform/')
		const grants = statementsOf(resources.TaskRunnerRole.Properties.Policies[0].PolicyDocument.Statement)
		expect(grants.map((statement) => [statement.Effect, statement.Action, statement.Resource, statement.Condition])).toEqual([
			[
				'Allow',
				['ecs:RunTask'],
				['arn:aws:ecs:eu-central-1:123456789012:task-definition/*'],
				{ ArnEquals: { 'ecs:cluster': `arn:aws:ecs:eu-central-1:123456789012:cluster/${AWS_APPS_CLUSTER}` } },
			],
			['Deny', ['ecs:RunTask'], ['arn:aws:ecs:eu-central-1:123456789012:task-definition/fabrika_platform_*'], undefined],
			[
				'Allow',
				['iam:PassRole'],
				['arn:aws:iam::123456789012:role/fabrika/apps/*', 'arn:aws:iam::123456789012:role/fabrika/namespaces/*'],
				{ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
			],
			[
				'Allow',
				['logs:CreateLogStream', 'logs:PutLogEvents'],
				['arn:aws:logs:eu-central-1:123456789012:log-group:/aws/lambda/fabrika-task-runner:*'],
				undefined,
			],
		])
	})

	test("the broker: the applications' listener's certificates and the certificates' names alone, configured with the installation's hosts", () => {
		const resources = JSON.parse(JSON.stringify(awsAccessStack(input).template)).Resources
		expect(resources.CertificateBroker.Properties).toMatchObject({
			FunctionName: 'fabrika-certificate-broker',
			Handler: 'index.handler',
			Environment: { Variables: { LISTENER_ARN: LISTENER, RESERVED_HOSTS: HOSTS.join(',') } },
		})
		expect(resources.CertificateBroker.Properties.Code.ZipFile.length).toBeLessThanOrEqual(4096)
		expect(resources.CertificateBrokerRole.Properties.Path).toBe('/fabrika/platform/')
		const grants = statementsOf(resources.CertificateBrokerRole.Properties.Policies[0].PolicyDocument.Statement)
		expect(grants.map((statement) => [statement.Action, statement.Resource])).toEqual([
			[['elasticloadbalancing:AddListenerCertificates', 'elasticloadbalancing:RemoveListenerCertificates'], [LISTENER]],
			[['acm:DescribeCertificate'], ['arn:aws:acm:eu-central-1:123456789012:certificate/*']],
			[['logs:CreateLogStream', 'logs:PutLogEvents'], ['arn:aws:logs:eu-central-1:123456789012:log-group:/aws/lambda/fabrika-certificate-broker:*']],
		])
		expect(() => checkAwsAccessInput({ ...input, installationHosts: [] })).toThrow("installation's own hosts")
		expect(() => checkAwsAccessInput({ ...input, installationHosts: ['IAM.example.com'] })).toThrow("installation's own hosts")
	})

	test('a tag is written only in the call that creates its resource, and never by ACM or Cloud Map', () => {
		const tagWrites: Record<string, string> = {
			'ecs:TagResource': 'ecs:CreateAction',
			'ec2:CreateTags': 'ec2:CreateAction',
			'elasticloadbalancing:AddTags': 'elasticloadbalancing:CreateAction',
		}
		for (const [action, key] of Object.entries(tagWrites)) {
			const statements = allows.filter((statement) => statement.Action.includes(action))
			expect(statements.length).toBeGreaterThan(0)
			for (const statement of statements) expect(Object.keys(statement.Condition?.['StringEquals'] ?? {})).toEqual([key])
		}
		for (const action of ['acm:AddTagsToCertificate', 'servicediscovery:TagResource', 'elasticloadbalancing:RemoveTags']) {
			expect(allows.some((statement) => statement.Action.includes(action))).toBe(false)
		}
	})

	test('a grant on `*` is an action that takes no resource, or one held by a condition', () => {
		const unscoped = new Set([
			'ecs:RegisterTaskDefinition',
			'ssm:DescribeParameters',
			'acm:RequestCertificate',
			'acm:DescribeCertificate',
			'elasticloadbalancing:DescribeRules',
			'elasticloadbalancing:DescribeListenerCertificates',
			'elasticloadbalancing:DescribeTargetGroups',
			'elasticloadbalancing:DescribeTargetGroupAttributes',
			'elasticloadbalancing:DescribeTags',
			'elasticloadbalancing:DescribeListeners',
			'elasticloadbalancing:DescribeLoadBalancers',
			'cloudformation:ListStacks',
			'logs:DescribeLogGroups',
			'ec2:DescribeSecurityGroups',
			'ec2:DescribeSecurityGroupRules',
			'ec2:DescribeVpcs',
			'servicediscovery:GetOperation',
		])
		for (const statement of allows.filter((candidate) => candidate.Resource.includes('*'))) {
			if (statement.Condition !== undefined) continue
			for (const action of statement.Action) expect(unscoped.has(action) ? action : `${action} on *`).toBe(action)
		}
	})

	test("services and security groups are created in the applications' cluster and the installation's VPC alone", () => {
		expect(allows.find((statement) => statement.Action.includes('ecs:CreateService'))?.Resource).toEqual([
			`arn:aws:ecs:eu-central-1:123456789012:service/${AWS_APPS_CLUSTER}/*`,
		])
		const groups = allows.filter((statement) => statement.Action.includes('ec2:CreateSecurityGroup')).flatMap((statement) => statement.Resource)
		expect(groups).toContain('arn:aws:ec2:eu-central-1:123456789012:vpc/vpc-0123456789abcdef0')
		expect(groups.some((resource) => resource.endsWith(':vpc/*'))).toBe(false)
		const passRole = allows.find((statement) => statement.Action.includes('iam:PassRole'))
		expect(passRole?.Resource).toEqual(['arn:aws:iam::123456789012:role/fabrika/apps/*', 'arn:aws:iam::123456789012:role/fabrika/namespaces/*'])
	})

	test("each of Control's policies, and the boundary, fits IAM's bound on a managed policy", () => {
		for (const managed of awsControlPolicies(input)) {
			const length = JSON.stringify({ Version: '2012-10-17', Statement: managed.statements }).length
			expect({ name: managed.name, fits: length <= AWS_MAX_MANAGED_POLICY }).toEqual({ name: managed.name, fits: true })
		}
		expect(JSON.stringify({ Version: '2012-10-17', Statement: awsAppsBoundaryStatements(input) }).length).toBeLessThanOrEqual(AWS_MAX_MANAGED_POLICY)
	})

	test("the stack: the boundary at the name every role names, Control's role taken by ECS tasks alone, both clusters, a private bucket", () => {
		const stack = awsAccessStack(input)
		expect(stack.stackName).toBe(AWS_ACCESS_STACK)
		const resources = JSON.parse(JSON.stringify(stack.template)).Resources
		// The applications' ceiling is the ceilings stack's (`ceilings.ts`), which the sidecar workflow's role may not change.
		expect(resources.AppsBoundary).toBeUndefined()
		// `policy/fabrika/fabrika-apps-boundary`: the ARN every role write requires.
		expect(awsAppsPermissionsBoundary('123456789012')).toBe('arn:aws:iam::123456789012:policy/fabrika/fabrika-apps-boundary')
		expect(resources.ControlRole.Properties.Path).toBe('/fabrika/platform/')
		// Every platform role here carries the platform's ceiling.
		for (const role of ['ControlRole', 'CertificateBrokerRole', 'TaskRunnerRole']) {
			expect({ role, boundary: resources[role].Properties.PermissionsBoundary }).toEqual({
				role,
				boundary: 'arn:aws:iam::123456789012:policy/fabrika/platform/fabrika-platform-boundary',
			})
		}
		expect(resources.ControlRole.Properties.AssumeRolePolicyDocument.Statement[0]).toMatchObject({
			Principal: { Service: 'ecs-tasks.amazonaws.com' },
			Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' } },
		})
		const policies = Object.values<{ Type: string; Properties: { Roles?: unknown } }>(resources).filter((resource) =>
			resource.Type === 'AWS::IAM::ManagedPolicy' && resource.Properties.Roles !== undefined
		)
		expect(policies.length).toBe(awsControlPolicies(input).length)
		expect(resources.AppsCluster.Properties.ClusterName).toBe(AWS_APPS_CLUSTER)
		expect(resources.PlatformCluster.Properties.ClusterName).toBe(AWS_PLATFORM_CLUSTER)
		expect(resources.SourcesBucket.Properties.PublicAccessBlockConfiguration).toEqual({
			BlockPublicAcls: true,
			BlockPublicPolicy: true,
			IgnorePublicAcls: true,
			RestrictPublicBuckets: true,
		})
		expect(resources.SourcesBucketPolicy.Properties.PolicyDocument.Statement[0]).toMatchObject({
			Effect: 'Deny',
			Condition: { Bool: { 'aws:SecureTransport': 'false' } },
		})
	})

	test("an input of another form is refused, and Control's coordinates come from it", () => {
		expect(() => checkAwsAccessInput({ ...input, accountId: '1234' })).toThrow('account')
		expect(() => checkAwsAccessInput({ ...input, region: 'Frankfurt' })).toThrow('region')
		// Another account's listener, or another region's.
		expect(() => checkAwsAccessInput({ ...input, appsListenerArn: LISTENER.replace('123456789012', '210987654321') })).toThrow('listener')
		expect(() => checkAwsAccessInput({ ...input, appsListenerArn: LISTENER.replace('eu-central-1', 'us-east-1') })).toThrow('listener')
		expect(() => checkAwsAccessInput({ ...input, vpcId: 'vpc-X' })).toThrow('VPC')
		expect(awsAccessEnvironment(input)).toEqual({
			FABRIKA_AWS_ACCOUNT_ID: '123456789012',
			FABRIKA_AWS_REGION: 'eu-central-1',
			FABRIKA_AWS_CLUSTER: AWS_APPS_CLUSTER,
			FABRIKA_AWS_SOURCES_BUCKET: 'fabrika-sources-123456789012',
		})
	})
})
