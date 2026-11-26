// The installation's database (the AWS idea's checklist, step 11): one RDS PostgreSQL instance that IAM, Control and
// Operations share, from one stack the operator applies.
//
// - **One database for the three.** Their table names do not intersect, and each keeps its own migration ledger and
//   advisory lock (ADR-0017), so one database holds them without coordination, as Zerops' light installation does. RDS
//   backs it up daily with point-in-time recovery, so the reason Zerops gives Operations a database of its own (one
//   backup schedule per service) does not apply.
// - **In the platform's network** (`network.ts`), which no route joins to the applications': nothing an application or
//   Control places can reach it, whatever group it carries.
// - **Private subnets of its own.** Two /24s of the platform VPC's range, one per zone, apart from its tasks' and its
//   balancer's subnets, with no route out: they use the VPC's main route table, which holds the local route alone.
// - **Reached by the platform's services alone.** The database's group admits PostgreSQL only from the clients' group,
//   which the platform's services carry and no application's stack names.
// - **Its password never in a template.** The operator's command generates it into a Parameter Store SecureString
//   under `/fabrika/platform/`, out of Control's reach, and the instance reads it through a dynamic reference; the
//   services' database URLs are written beside it.
//
// UNVERIFIED: the resources' properties, that `{{resolve:ssm-secure:…}}` is accepted for `MasterUserPassword`, the
// engine version's availability and that RDS enforces TLS by default for PostgreSQL 15 and later follow the RDS and
// CloudFormation references; none was checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import { blockAt, blocksOverlap } from '../cidr'
import type { AwsStack } from '../stack'
import { AWS_PLATFORM_PATH } from './access'
import { type AwsNetworkOutputs, checkAwsNetworkLayout } from './network'

/** The database's stack's name: under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_DATABASE_STACK = 'fabrika-platform-database'
/** The database, and its master user, the three services connect as. */
export const AWS_DATABASE_NAME = 'fabrika'
export const AWS_DATABASE_USER = 'fabrika'
/** The SecureString the instance's password is read from: under the platform's path, out of Control's reach. */
export const AWS_DATABASE_PASSWORD_PARAMETER = `${AWS_PLATFORM_PATH}database-password`
/** The engine's major version. */
export const AWS_DATABASE_ENGINE_VERSION = '17'
/** A small installation's instance: burstable, two vCPUs, 1 GiB. */
export const AWS_DATABASE_CLASS = 'db.t4g.micro'
/** Daily backups kept this long, with point-in-time recovery within it. */
export const AWS_DATABASE_BACKUP_DAYS = 7

/** The database's subnets, one per zone: two /24s at a fixed place of the VPC's range, apart from every other subnet. */
export function awsDatabaseSubnetCidrs(network: Pick<AwsNetworkOutputs, 'vpcCidr' | 'taskSubnetCidrs' | 'balancerSubnetCidrs'>): readonly string[] {
	checkAwsNetworkLayout(network)
	const cidrs = [0, 1].map((zone) => blockAt(network.vpcCidr, (32 + zone) * 256, 24))
	const others = [...network.taskSubnetCidrs, ...network.balancerSubnetCidrs]
	if (cidrs.some((cidr) => others.some((other) => blocksOverlap(cidr, other)))) {
		throw new Error("aws: the database's subnets would overlap the tasks' or the balancers'")
	}
	return cidrs
}

const name = (value: string): JsonValue => [{ Key: 'Name', Value: value }]

/** The database's stack: its subnets and subnet group, its group and the clients' group, and the instance. */
export function awsDatabaseStack(network: AwsNetworkOutputs): AwsStack {
	const cidrs = awsDatabaseSubnetCidrs(network)
	const resources: Record<string, JsonValue> = {}
	cidrs.forEach((cidr, index) => {
		resources[`DatabaseSubnet${index}`] = {
			Type: 'AWS::EC2::Subnet',
			// No route table of its own: the VPC's main table, the local route alone.
			Properties: {
				VpcId: network.vpcId,
				CidrBlock: cidr,
				AvailabilityZone: { 'Fn::Select': [index, { 'Fn::GetAZs': '' }] },
				MapPublicIpOnLaunch: false,
				Tags: name(`fabrika-database-${index}`),
			},
		}
	})
	resources['DatabaseSubnets'] = {
		Type: 'AWS::RDS::DBSubnetGroup',
		Properties: {
			// No apostrophe in any description here: EC2 takes a group's and a rule's in a-z, A-Z, 0-9, spaces and
			// `._-:/()#,@[]+=&;{}!$*` alone.
			DBSubnetGroupDescription: 'fabrika: the platform database subnets',
			SubnetIds: cidrs.map((_, index) => ({ Ref: `DatabaseSubnet${index}` })),
		},
	}
	resources['DatabaseClientGroup'] = {
		Type: 'AWS::EC2::SecurityGroup',
		Properties: {
			GroupDescription: 'fabrika: the platform services, the only database clients',
			VpcId: network.vpcId,
			// Rules of its own are none: it only names its members to the database's group. Its egress stays EC2's default,
			// which the services' own groups decide over.
			Tags: name('fabrika-database-clients'),
		},
	}
	resources['DatabaseGroup'] = {
		Type: 'AWS::EC2::SecurityGroup',
		Properties: {
			GroupDescription: 'fabrika: the platform database',
			VpcId: network.vpcId,
			SecurityGroupIngress: [{
				IpProtocol: 'tcp',
				FromPort: 5432,
				ToPort: 5432,
				SourceSecurityGroupId: { 'Fn::GetAtt': ['DatabaseClientGroup', 'GroupId'] },
				Description: 'the platform services',
			}],
			// It answers; it starts nothing.
			SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'none' }],
			Tags: name('fabrika-database'),
		},
	}
	resources['Database'] = {
		Type: 'AWS::RDS::DBInstance',
		// Deleting the stack, or a change that replaces the instance, keeps a final snapshot.
		DeletionPolicy: 'Snapshot',
		UpdateReplacePolicy: 'Snapshot',
		Properties: {
			Engine: 'postgres',
			EngineVersion: AWS_DATABASE_ENGINE_VERSION,
			DBInstanceClass: AWS_DATABASE_CLASS,
			AllocatedStorage: '20',
			MaxAllocatedStorage: 100,
			StorageType: 'gp3',
			StorageEncrypted: true,
			DBName: AWS_DATABASE_NAME,
			MasterUsername: AWS_DATABASE_USER,
			MasterUserPassword: `{{resolve:ssm-secure:${AWS_DATABASE_PASSWORD_PARAMETER}}}`,
			DBSubnetGroupName: { Ref: 'DatabaseSubnets' },
			VPCSecurityGroups: [{ 'Fn::GetAtt': ['DatabaseGroup', 'GroupId'] }],
			PubliclyAccessible: false,
			MultiAZ: false,
			BackupRetentionPeriod: AWS_DATABASE_BACKUP_DAYS,
			CopyTagsToSnapshot: true,
			DeletionProtection: true,
			AutoMinorVersionUpgrade: true,
			Tags: name('fabrika'),
		},
	}
	return {
		stackName: AWS_DATABASE_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: "fabrika: the installation's database",
			Resources: resources,
			Outputs: {
				DatabaseHost: { Value: { 'Fn::GetAtt': ['Database', 'Endpoint.Address'] } },
				DatabasePort: { Value: { 'Fn::GetAtt': ['Database', 'Endpoint.Port'] } },
				DatabaseClientGroupId: { Value: { 'Fn::GetAtt': ['DatabaseClientGroup', 'GroupId'] } },
			},
		},
		tags: { 'fabrika:platform': 'database' },
	}
}

/** What the database's stack created under names AWS chose. */
export interface AwsDatabaseOutputs {
	readonly host: string
	readonly port: number
	/** The group the platform's services carry to reach the database. */
	readonly clientGroupId: string
}

/** An RDS endpoint's host: `<instance>.<id>.<region>.rds.amazonaws.com`. */
const DATABASE_HOST = /^[a-z][a-z0-9-]{0,62}\.[a-z0-9]{6,32}\.[a-z0-9-]{1,32}\.rds\.amazonaws\.com$/

/** The database's outputs as the stack answers them, or an error naming the output of another form. */
export function awsDatabaseOutputs(outputs: Readonly<Record<string, string>>): AwsDatabaseOutputs {
	const host = outputs['DatabaseHost'] ?? ''
	const port = Number(outputs['DatabasePort'] ?? '')
	const clientGroupId = outputs['DatabaseClientGroupId'] ?? ''
	if (!DATABASE_HOST.test(host)) throw new Error("aws: the database stack's DatabaseHost output is not an RDS endpoint")
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("aws: the database stack's DatabasePort output is not a port")
	if (!/^sg-[0-9a-f]{8,17}$/.test(clientGroupId)) throw new Error("aws: the database stack's DatabaseClientGroupId output is not a security group id")
	return { host, port, clientGroupId }
}

/**
 * The URL IAM, Control and Operations connect with: TLS required, the password escaped. It holds the password, so the
 * operator's command writes it into Parameter Store as a SecureString and never prints it.
 */
export function awsDatabaseUrl(outputs: AwsDatabaseOutputs, password: string): string {
	if (password.length < 16) throw new Error("aws: the database's password is shorter than 16 characters")
	return `postgres://${AWS_DATABASE_USER}:${encodeURIComponent(password)}@${outputs.host}:${outputs.port}/${AWS_DATABASE_NAME}?sslmode=require`
}
