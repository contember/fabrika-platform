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
	awsAccessEnvironment,
	type AwsAccessInput,
	awsAccessStack,
	awsAppsBoundaryStatements,
	awsControlPolicies,
	awsSourcesBucket,
	checkAwsAccessInput,
} from '../access'

const LISTENER = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210'
const BROKER = 'arn:aws:lambda:eu-central-1:123456789012:function:fabrika-certificate-broker'
const HOSTS = ['iam.example.com', 'control.example.com', 'operations.example.com', 'apps.example.com']
const input: AwsAccessInput = {
	accountId: '123456789012',
	region: 'eu-central-1',
	appsListenerArn: LISTENER,
	vpcId: 'vpc-0123456789abcdef0',
	installationHosts: HOSTS,
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

	test('Control attaches no certificate to a listener: only the broker does, which Control may invoke and nothing more', () => {
		for (const action of ['elasticloadbalancing:AddListenerCertificates', 'elasticloadbalancing:RemoveListenerCertificates']) {
			expect(allows.some((statement) => statement.Action.includes(action))).toBe(false)
			expect(control.find((statement) => statement.Effect === 'Deny' && statement.Action.includes(action))?.Resource).toEqual(['*'])
		}
		const invoke = allows.filter((statement) => statement.Action.some((action) => action.startsWith('lambda:')))
		expect(invoke.map((statement) => [statement.Action, statement.Resource])).toEqual([[['lambda:InvokeFunction'], [BROKER]]])
		expect(control.find((statement) => statement.NotAction !== undefined)).toEqual({
			Effect: 'Deny',
			Action: [],
			NotAction: ['lambda:InvokeFunction'],
			Resource: [BROKER],
		})
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

	test("tasks run, and services and security groups are created, in the applications' cluster and the installation's VPC alone", () => {
		const runTask = allows.find((statement) => statement.Action.includes('ecs:RunTask'))
		expect(runTask?.Condition).toEqual({ ArnEquals: { 'ecs:cluster': `arn:aws:ecs:eu-central-1:123456789012:cluster/${AWS_APPS_CLUSTER}` } })
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
		expect(resources.AppsBoundary.Properties).toMatchObject({ ManagedPolicyName: 'fabrika-apps-boundary', Path: '/fabrika/' })
		// `policy/fabrika/fabrika-apps-boundary`: the ARN every role write requires.
		expect(awsAppsPermissionsBoundary('123456789012')).toBe('arn:aws:iam::123456789012:policy/fabrika/fabrika-apps-boundary')
		expect(resources.ControlRole.Properties.Path).toBe('/fabrika/platform/')
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
