// The installation's database (the AWS idea's checklist, step 11): one RDS PostgreSQL instance that IAM, Control and
// Operations share, from one stack the operator applies.
//
// - **One instance, a database and a user for each.** IAM, Control and Operations each connect as a user of their own
//   (`fabrika_iam`, `fabrika_control`, `fabrika_operations`) that owns a database of the same name and can connect to
//   no other, so a misused Control reads none of IAM's tables (its users, sessions and keys) nor Operations'. The
//   instance's master user (`fabrika_admin`) creates them and is no service's: its password is read only by the
//   operator's command, which runs `awsDatabaseSetupSteps` as a one-off task in the platform's network on install and
//   on every upgrade (idempotent: it creates what is missing and sets each password to its parameter's). RDS backs the
//   instance up daily with point-in-time recovery, so one instance serves the three.
// - **In the platform's network** (`network.ts`), which no route joins to the applications': nothing an application or
//   Control places can reach it, whatever group it carries.
// - **Private subnets of its own.** Two /24s of the platform VPC's range, one per zone, apart from its tasks' and its
//   balancer's subnets, with no route out: they use the VPC's main route table, which holds the local route alone.
// - **Reached by the platform's services alone.** The database's group admits PostgreSQL only from the clients' group,
//   which the platform's services carry and no application's stack names.
// - **No password in a template.** The operator's command generates each (the master's and one per service) into a
//   Parameter Store SecureString under `/fabrika/platform/database/`, out of Control's reach; the instance reads the
//   master's through a dynamic reference. Each service's task reads its own parameter alone (the services' step).
//
// UNVERIFIED: the resources' properties, that `{{resolve:ssm-secure:…}}` is accepted for `MasterUserPassword`, the
// engine version's availability and that RDS enforces TLS by default for PostgreSQL 15 and later follow the RDS and
// CloudFormation references; that RDS's master user may grant itself `SET` on a role it created and so create a
// database that role owns follows PostgreSQL 16's rules for `CREATEROLE`. None was checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import { blockAt, blocksOverlap } from '../cidr'
import type { AwsStack } from '../stack'
import { AWS_PLATFORM_PATH } from './access'
import { type AwsNetworkOutputs, checkAwsNetworkLayout } from './network'

/** The database's stack's name: under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_DATABASE_STACK = 'fabrika-platform-database'
/** The instance's master user: it creates the services' users and databases, and no service connects as it. */
export const AWS_DATABASE_ADMIN = 'fabrika_admin'
/** The platform's Parameter Store path of the database's passwords, which no grant of Control's role names. */
export const AWS_DATABASE_PARAMETERS = `${AWS_PLATFORM_PATH}database/`
/** The SecureString the master's password is read from. */
export const AWS_DATABASE_ADMIN_PASSWORD_PARAMETER = `${AWS_DATABASE_PARAMETERS}admin-password`

/** A platform service with a database and a user of its own. */
export type AwsDatabaseService = 'iam' | 'control' | 'operations'
export const AWS_DATABASE_SERVICES: readonly AwsDatabaseService[] = ['iam', 'control', 'operations']

/** A service's user, and the database it owns: the same name. */
export function awsDatabaseRole(service: AwsDatabaseService): string {
	return `fabrika_${service}`
}

/** The SecureString a service's password is read from, by the operator's command and that service's task alone. */
export function awsDatabasePasswordParameter(service: AwsDatabaseService): string {
	return `${AWS_DATABASE_PARAMETERS}${service}-password`
}

/**
 * A password the operator's command generates: letters and digits alone, so it stands in a SQL literal and a URL as
 * it is, and RDS takes it for the master (which refuses `/`, `'`, `"` and `@`).
 */
const PASSWORD = /^[A-Za-z0-9]{32,128}$/

function checkPassword(password: string, whose: string): string {
	if (!PASSWORD.test(password)) throw new Error(`aws: ${whose} database password is not 32 to 128 letters and digits`)
	return password
}
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
			// No initial database: the setup creates one per service, and the master works in `postgres`.
			MasterUsername: AWS_DATABASE_ADMIN,
			MasterUserPassword: `{{resolve:ssm-secure:${AWS_DATABASE_ADMIN_PASSWORD_PARAMETER}}}`,
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
 * The URL a service connects with: as its own user, to its own database, TLS required. It holds the password, so it
 * is built where the password is read and never printed.
 */
export function awsDatabaseUrl(outputs: AwsDatabaseOutputs, service: AwsDatabaseService, password: string): string {
	const role = awsDatabaseRole(service)
	return `postgres://${role}:${checkPassword(password, `${service}'s`)}@${outputs.host}:${outputs.port}/${role}?sslmode=require`
}

/** The master's URL, for the setup alone: to the `postgres` database, TLS required. */
export function awsDatabaseAdminUrl(outputs: AwsDatabaseOutputs, password: string): string {
	return `postgres://${AWS_DATABASE_ADMIN}:${checkPassword(password, "the master's")}@${outputs.host}:${outputs.port}/postgres?sslmode=require`
}

/**
 * One step of the setup: a statement, or a probe that decides between creating an object and bringing an existing one
 * to the same state. `label` names the object and never a password, so an error can carry it.
 */
export type AwsDatabaseSetupStep =
	| { readonly kind: 'run'; readonly label: string; readonly statement: string }
	| {
		readonly kind: 'ensure'
		readonly label: string
		/** Answers a row when the object exists. */
		readonly probe: string
		readonly params: readonly string[]
		readonly create: string
		readonly update: string
	}

/**
 * The setup the master runs, connected to `postgres`: for each service its user (created, or its password set to the
 * parameter's), the master's `SET` on it (PostgreSQL 16 and later create a database another role owns only for a role
 * that may `SET ROLE` to it), its database owned by it, and `CONNECT` on that database taken from everyone else.
 * Idempotent, so install and every upgrade run it whole. Role and database names are this module's own; a password is
 * letters and digits alone.
 */
export function awsDatabaseSetupSteps(passwords: Readonly<Record<AwsDatabaseService, string>>): readonly AwsDatabaseSetupStep[] {
	return AWS_DATABASE_SERVICES.flatMap((service): AwsDatabaseSetupStep[] => {
		const role = awsDatabaseRole(service)
		const password = checkPassword(passwords[service], `${service}'s`)
		return [
			{
				kind: 'ensure',
				label: `the user ${role}`,
				probe: 'SELECT 1 FROM pg_roles WHERE rolname = $1',
				params: [role],
				create: `CREATE ROLE "${role}" WITH LOGIN PASSWORD '${password}'`,
				update: `ALTER ROLE "${role}" WITH LOGIN PASSWORD '${password}'`,
			},
			{ kind: 'run', label: `the master's SET on ${role}`, statement: `GRANT "${role}" TO CURRENT_USER WITH SET TRUE, INHERIT FALSE` },
			{
				kind: 'ensure',
				label: `the database ${role}`,
				probe: 'SELECT 1 FROM pg_database WHERE datname = $1',
				params: [role],
				create: `CREATE DATABASE "${role}" OWNER "${role}"`,
				update: `ALTER DATABASE "${role}" OWNER TO "${role}"`,
			},
			{ kind: 'run', label: `the database ${role} closed to others`, statement: `REVOKE ALL ON DATABASE "${role}" FROM PUBLIC` },
		]
	})
}

/** The connection the setup runs on: the master's, to `postgres`, one statement at a time and outside a transaction. */
export interface AwsDatabaseSession {
	/** How many rows `text` answers with `params` bound. */
	count(text: string, params: readonly string[]): Promise<number>
	/** Runs one statement that takes no parameter. */
	execute(statement: string): Promise<void>
}

/**
 * Runs the setup's steps in order. A failing step is reported by its label alone: a statement carries a password, and
 * a driver's error may quote it.
 */
export async function runAwsDatabaseSetup(session: AwsDatabaseSession, steps: readonly AwsDatabaseSetupStep[]): Promise<void> {
	for (const step of steps) {
		try {
			if (step.kind === 'run') await session.execute(step.statement)
			else await session.execute((await session.count(step.probe, step.params)) > 0 ? step.update : step.create)
		} catch {
			throw new Error(`aws: the database setup failed at ${step.label}`)
		}
	}
}
