// The installation's database: private subnets of its own apart from the tasks' and the balancers', reached only
// from the clients' group, its password read from Parameter Store under the platform's path and never in the template,
// kept on delete; its outputs read back, and the URL the platform's services connect with.

import { describe, expect, test } from 'bun:test'
import { blocksOverlap } from '../../cidr'
import { awsControlPolicies } from '../access'
import {
	AWS_DATABASE_PASSWORD_PARAMETER,
	AWS_DATABASE_STACK,
	awsDatabaseOutputs,
	awsDatabaseStack,
	awsDatabaseSubnetCidrs,
	awsDatabaseUrl,
} from '../database'
import { awsNetworkOutputs } from '../network'

// The platform's network: the database is never in the applications'.
const network = awsNetworkOutputs({
	VpcId: 'vpc-0123456789abcdef9',
	VpcCidr: '10.81.0.0/16',
	TaskSubnetIds: 'subnet-0123456789abcdef4,subnet-0123456789abcdef5',
	TaskSubnetCidrs: '10.81.0.0/20,10.81.16.0/20',
	BalancerSubnetIds: 'subnet-0123456789abcdef6,subnet-0123456789abcdef7',
	BalancerSubnetCidrs: '10.81.240.0/24,10.81.241.0/24',
})
const OUTPUTS = {
	DatabaseHost: 'fabrika-database-abcdefgh.c1a2b3c4d5e6.eu-central-1.rds.amazonaws.com',
	DatabasePort: '5432',
	DatabaseClientGroupId: 'sg-0123456789abcdef4',
}

describe("the installation's database", () => {
	const stack = awsDatabaseStack(network)
	const resources = JSON.parse(JSON.stringify(stack.template)).Resources

	test("its two subnets lie apart from the tasks' and the balancers', with no route of their own", () => {
		const cidrs = awsDatabaseSubnetCidrs(network)
		expect(cidrs).toEqual(['10.81.32.0/24', '10.81.33.0/24'])
		for (const cidr of cidrs) {
			for (const other of [...network.taskSubnetCidrs, ...network.balancerSubnetCidrs]) expect(blocksOverlap(cidr, other)).toBe(false)
		}
		expect(resources.DatabaseSubnet1.Properties).toMatchObject({ VpcId: network.vpcId, CidrBlock: '10.81.33.0/24', MapPublicIpOnLaunch: false })
		expect(Object.values(resources).some((resource) => JSON.stringify(resource).includes('SubnetRouteTableAssociation'))).toBe(false)
		// A task's subnet over where the database's go is refused, not overlapped.
		expect(() => awsDatabaseSubnetCidrs({ ...network, taskSubnetCidrs: ['10.81.0.0/20', '10.81.32.0/20'] })).toThrow('overlap')
	})

	test("PostgreSQL is reached from the clients' group alone, and the database's group starts nothing", () => {
		expect(resources.DatabaseGroup.Properties.SecurityGroupIngress).toEqual([{
			IpProtocol: 'tcp',
			FromPort: 5432,
			ToPort: 5432,
			SourceSecurityGroupId: { 'Fn::GetAtt': ['DatabaseClientGroup', 'GroupId'] },
			Description: 'the platform services',
		}])
		expect(resources.DatabaseGroup.Properties.SecurityGroupEgress).toEqual([{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'none' }])
		expect(resources.DatabaseClientGroup.Properties.SecurityGroupIngress).toBeUndefined()
	})

	test('the instance: private, encrypted, backed up, protected from deletion, its password a reference Control cannot read', () => {
		expect(stack.stackName).toBe(AWS_DATABASE_STACK)
		expect(resources.Database).toMatchObject({ DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Snapshot' })
		expect(resources.Database.Properties).toMatchObject({
			Engine: 'postgres',
			PubliclyAccessible: false,
			StorageEncrypted: true,
			DeletionProtection: true,
			BackupRetentionPeriod: 7,
			MasterUserPassword: '{{resolve:ssm-secure:/fabrika/platform/database-password}}',
		})
		expect(AWS_DATABASE_PASSWORD_PARAMETER.startsWith('/fabrika/platform/')).toBe(true)
		// No grant of Control's role reaches the platform's parameters.
		const grants = JSON.stringify(
			awsControlPolicies({
				accountId: '123456789012',
				region: 'eu-central-1',
				appsListenerArn: 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210',
				// Control's: the applications' network.
				vpcId: 'vpc-0123456789abcdef0',
				taskSubnetIds: ['subnet-0123456789abcdef0'],
				installationHosts: ['iam.example.com'],
			}).map((managed) => managed.statements.filter((statement) => JSON.stringify(statement).includes('"Allow"'))),
		)
		expect(grants).not.toContain('parameter/fabrika/platform')
	})

	test('the outputs are read back, one of another form refused, and the URL requires TLS with its password escaped', () => {
		const outputs = awsDatabaseOutputs(OUTPUTS)
		expect(outputs).toEqual({ host: OUTPUTS.DatabaseHost, port: 5432, clientGroupId: 'sg-0123456789abcdef4' })
		expect(() => awsDatabaseOutputs({ ...OUTPUTS, DatabaseHost: 'example.com' })).toThrow('DatabaseHost')
		expect(() => awsDatabaseOutputs({ ...OUTPUTS, DatabasePort: 'x' })).toThrow('DatabasePort')
		expect(() => awsDatabaseOutputs({ ...OUTPUTS, DatabaseClientGroupId: '' })).toThrow('DatabaseClientGroupId')
		expect(awsDatabaseUrl(outputs, 'p@ss/word:with#sigils')).toBe(
			`postgres://fabrika:p%40ss%2Fword%3Awith%23sigils@${OUTPUTS.DatabaseHost}:5432/fabrika?sslmode=require`,
		)
		expect(() => awsDatabaseUrl(outputs, 'short')).toThrow('16 characters')
	})
})
