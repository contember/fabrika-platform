// The platform services' foundation: one group per task whose rules are exactly who calls whom, one execution role per
// task that reads its own parameters alone, Operations' task role on its bucket alone, two private buckets, the
// platform's own Service Connect namespace, and nothing of it in Control's reach.

import { describe, expect, test } from 'bun:test'
import { awsControlPolicies } from '../access'
import { awsNetworkOutputs } from '../network'
import {
	AWS_PLATFORM_NAMESPACE,
	AWS_PLATFORM_TASKS,
	AWS_RUNTIME_STACK,
	awsPlatformExecutionRole,
	awsPlatformLogGroup,
	awsPlatformParameters,
	type AwsPlatformTask,
	awsPlatformTaskFamily,
	awsRuntimeOutputs,
	awsRuntimeStack,
} from '../runtime'

const platform = awsNetworkOutputs({
	VpcId: 'vpc-0123456789abcdef9',
	VpcCidr: '10.81.0.0/16',
	TaskSubnetIds: 'subnet-0123456789abcdef4,subnet-0123456789abcdef5',
	TaskSubnetCidrs: '10.81.0.0/20,10.81.16.0/20',
	BalancerSubnetIds: 'subnet-0123456789abcdef6,subnet-0123456789abcdef7',
	BalancerSubnetCidrs: '10.81.240.0/24,10.81.241.0/24',
})
const BALANCER_GROUP = 'sg-0123456789abcdef9'
const stack = awsRuntimeStack({ accountId: '123456789012', region: 'eu-central-1', platform, balancers: { platformBalancerGroupId: BALANCER_GROUP } })
const resources: Record<string, { Type: string; Properties: Record<string, unknown> }> = JSON.parse(JSON.stringify(stack.template)).Resources

interface Rule {
	readonly GroupId: { 'Fn::GetAtt': [string, string] }
	readonly FromPort: number
	readonly SourceSecurityGroupId?: string | { 'Fn::GetAtt': [string, string] }
	readonly DestinationSecurityGroupId?: { 'Fn::GetAtt': [string, string] }
	readonly CidrIp?: string
}

const rules = (type: string): readonly Rule[] =>
	Object.values(resources).filter((resource) => resource.Type === type).map((resource) => JSON.parse(JSON.stringify(resource.Properties)))
const groupOf = (reference: Rule['SourceSecurityGroupId']): string => (typeof reference === 'string' ? reference : reference?.['Fn::GetAtt'][0] ?? '')

/** `group`'s rules as `port from|to peer` lines, sorted. */
function lines(group: string, type: 'AWS::EC2::SecurityGroupIngress' | 'AWS::EC2::SecurityGroupEgress'): readonly string[] {
	return rules(type)
		.filter((rule) => rule.GroupId['Fn::GetAtt'][0] === group)
		.map((rule) => `${rule.FromPort} ${rule.CidrIp ?? groupOf(rule.SourceSecurityGroupId ?? rule.DestinationSecurityGroupId)}`)
		.sort()
}

/** Whether IAM's pattern `pattern` (`*` any run, `?` one character) matches `value`. */
function matches(pattern: string, value: string): boolean {
	const source = [...pattern].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.\\+^$|()[\]{}]/g, '\\$&'))).join('')
	return new RegExp(`^${source}$`).test(value)
}

describe("the platform services' foundation", () => {
	test("its names are the platform's: the stack, the families, the parameters, the log groups, the roles", () => {
		expect(stack.stackName).toBe(AWS_RUNTIME_STACK)
		for (const task of AWS_PLATFORM_TASKS) {
			expect(awsPlatformTaskFamily(task)).toBe(`fabrika_platform_${task}`)
			expect(awsPlatformParameters(task)).toBe(`/fabrika/platform/${task}/`)
			expect(awsPlatformLogGroup(task).startsWith('/fabrika/platform/')).toBe(true)
			expect(awsPlatformExecutionRole(task).startsWith('fabrika-platform-')).toBe(true)
		}
		expect(resources['Namespace']?.Properties).toMatchObject({ Name: AWS_PLATFORM_NAMESPACE })
	})

	test('the platform proxy admits the platform balancer alone, and each service only who calls it', () => {
		expect(lines('ProxyGroup', 'AWS::EC2::SecurityGroupIngress')).toEqual([`8080 ${BALANCER_GROUP}`, `8081 ${BALANCER_GROUP}`])
		expect(lines('IamGroup', 'AWS::EC2::SecurityGroupIngress')).toEqual(['3000 ControlGroup', '3000 OperationsGroup', '3000 ProxyGroup'])
		expect(lines('ControlGroup', 'AWS::EC2::SecurityGroupIngress')).toEqual(['3000 IamGroup', '3000 ProxyGroup'])
		expect(lines('OperationsGroup', 'AWS::EC2::SecurityGroupIngress')).toEqual(['3000 ControlGroup', '3000 ProxyGroup'])
		expect(lines('SetupGroup', 'AWS::EC2::SecurityGroupIngress')).toEqual([])
		// No group admits an address range: only groups.
		expect(rules('AWS::EC2::SecurityGroupIngress').some((rule) => rule.CidrIp !== undefined)).toBe(false)
	})

	test('each task reaches what it calls, the database its subnets on 5432, the internet on 443 alone', () => {
		const database = ['5432 10.81.32.0/24', '5432 10.81.33.0/24']
		expect(lines('ProxyGroup', 'AWS::EC2::SecurityGroupEgress')).toEqual([
			'3000 ControlGroup',
			'3000 IamGroup',
			'3000 OperationsGroup',
			'443 0.0.0.0/0',
		])
		expect(lines('IamGroup', 'AWS::EC2::SecurityGroupEgress')).toEqual(['3000 ControlGroup', '443 0.0.0.0/0', ...database])
		expect(lines('ControlGroup', 'AWS::EC2::SecurityGroupEgress')).toEqual(['3000 IamGroup', '3000 OperationsGroup', '443 0.0.0.0/0', ...database])
		expect(lines('OperationsGroup', 'AWS::EC2::SecurityGroupEgress')).toEqual(['3000 IamGroup', '443 0.0.0.0/0', ...database])
		expect(lines('SetupGroup', 'AWS::EC2::SecurityGroupEgress')).toEqual(['443 0.0.0.0/0', ...database])
		// Every group's default egress replaced, so the rules above are all it reaches.
		for (const group of ['ProxyGroup', 'IamGroup', 'ControlGroup', 'OperationsGroup', 'SetupGroup']) {
			expect(resources[group]?.Properties['SecurityGroupEgress']).toEqual([{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'none' }])
			expect(resources[group]?.Properties['VpcId']).toBe(platform.vpcId)
		}
		// EC2 refuses an apostrophe in a group's or a rule's description.
		expect(JSON.stringify(resources).match(/"(?:GroupDescription|Description)":"[^"]*'/)).toBeNull()
	})

	test('each execution role pulls its own image, writes its own logs and reads its own parameters alone', () => {
		const grantsOf = (task: AwsPlatformTask) => {
			const role = Object.values(resources).find((resource) => resource.Properties['RoleName'] === awsPlatformExecutionRole(task))
			const inline: readonly { PolicyDocument: { Statement: readonly { Action: readonly string[]; Resource: readonly string[] }[] } }[] = JSON.parse(
				JSON.stringify(role?.Properties['Policies'] ?? []),
			)
			const statements = inline.flatMap((entry) => entry.PolicyDocument.Statement)
			return (action: string) => statements.filter((statement) => statement.Action.includes(action)).flatMap((statement) => statement.Resource)
		}
		const parameter = (path: string) => `arn:aws:ssm:eu-central-1:123456789012:parameter${path}`
		// A service reads its database URL from its own path, never the database's.
		expect(grantsOf('iam')('ssm:GetParameters')).toEqual([parameter('/fabrika/platform/iam/*')])
		expect(grantsOf('control')('ssm:GetParameters')).toEqual([parameter('/fabrika/platform/control/*')])
		expect(grantsOf('operations')('ssm:GetParameters')).toEqual([parameter('/fabrika/platform/operations/*')])
		expect(grantsOf('proxy')('ssm:GetParameters')).toEqual([parameter('/fabrika/platform/proxy/*')])
		// The setup alone reads the master's password, and the services' it sets.
		expect(grantsOf('setup')('ssm:GetParameters')).toEqual([parameter('/fabrika/platform/setup/*'), parameter('/fabrika/platform/database/*')])
		expect(grantsOf('proxy')('ecr:BatchGetImage')).toEqual(['arn:aws:ecr:eu-central-1:123456789012:repository/fabrika/platform/proxy'])
		expect(grantsOf('iam')('ecr:BatchGetImage')).toEqual(['arn:aws:ecr:eu-central-1:123456789012:repository/fabrika/platform/services'])
		expect(grantsOf('operations')('logs:PutLogEvents')).toEqual(['arn:aws:logs:eu-central-1:123456789012:log-group:/fabrika/platform/operations:*'])
	})

	test("Operations' task role reaches its bucket alone; both buckets are private and TLS only", () => {
		const blobs = JSON.stringify(resources['OperationsTaskRole']?.Properties['Policies'])
		expect(blobs).toContain('arn:aws:s3:::fabrika-operations-123456789012/*')
		expect(blobs).not.toContain('run-logs')
		// Both grants held to this account's bucket, which is kept when the stack goes: its name is global.
		expect(blobs.split('"s3:ResourceAccount":"123456789012"')).toHaveLength(3)
		for (const bucket of ['RunLogsBucket', 'OperationsBucket']) {
			expect(resources[bucket]?.Properties['PublicAccessBlockConfiguration']).toEqual({
				BlockPublicAcls: true,
				BlockPublicPolicy: true,
				IgnorePublicAcls: true,
				RestrictPublicBuckets: true,
			})
			expect(JSON.stringify(resources[`${bucket}Policy`]?.Properties)).toContain('"aws:SecureTransport":"false"')
			expect(JSON.parse(JSON.stringify(stack.template)).Resources[bucket]).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' })
		}
		expect(resources['RunLogsBucket']?.Properties['BucketName']).toBe('fabrika-run-logs-123456789012')
	})

	test("Control's role reaches none of it but its run logs", () => {
		const statements: readonly { Effect: string; Action?: readonly string[]; Resource: readonly string[] }[] = JSON.parse(
			JSON.stringify(
				awsControlPolicies({
					accountId: '123456789012',
					region: 'eu-central-1',
					appsListenerArn: 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210',
					vpcId: 'vpc-0123456789abcdef0',
					taskSubnetIds: ['subnet-0123456789abcdef0'],
					installationHosts: ['iam.example.com'],
					platformNamespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-0123456789abcdef',
				}).flatMap((managed) => managed.statements),
			),
		)
		const targets: readonly [string, readonly string[]][] = [
			['arn:aws:iam::123456789012:role/fabrika/platform/fabrika-platform-iam-execution', ['iam:PassRole', 'iam:PutRolePolicy']],
			['arn:aws:iam::123456789012:role/fabrika/platform/fabrika-platform-operations', ['iam:PassRole']],
			['arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/platform/iam/FABRIKA_IAM_SIGNING_KEYS', ['ssm:GetParameters', 'ssm:PutParameter']],
			['arn:aws:logs:eu-central-1:123456789012:log-group:/fabrika/platform/control:log-stream:x', ['logs:GetLogEvents', 'logs:FilterLogEvents']],
			['arn:aws:s3:::fabrika-operations-123456789012/x', ['s3:GetObject', 's3:PutObject']],
		]
		for (const [resource, actions] of targets) {
			for (const action of actions) {
				const granted = statements.some((statement) =>
					statement.Effect === 'Allow' && (statement.Action ?? []).some((pattern) => matches(pattern, action))
					&& statement.Resource.some((pattern) => matches(pattern, resource))
				)
				expect({ action, resource, granted }).toEqual({ action, resource, granted: false })
			}
		}
	})

	test('the outputs are read back, one of another form refused', () => {
		const outputs = {
			NamespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-0123456789abcdef',
			IamGroupId: 'sg-0123456789abcdef1',
			ControlGroupId: 'sg-0123456789abcdef2',
			OperationsGroupId: 'sg-0123456789abcdef3',
			ProxyGroupId: 'sg-0123456789abcdef4',
			SetupGroupId: 'sg-0123456789abcdef5',
		}
		expect(awsRuntimeOutputs(outputs).groupIds.proxy).toBe('sg-0123456789abcdef4')
		expect(() => awsRuntimeOutputs({ ...outputs, NamespaceArn: 'fabrika-platform' })).toThrow('NamespaceArn')
		expect(() => awsRuntimeOutputs({ ...outputs, SetupGroupId: outputs.IamGroupId })).toThrow('one group twice')
	})
})
