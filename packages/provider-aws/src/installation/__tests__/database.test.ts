// The installation's database: private subnets of its own apart from the tasks' and the balancers', reached only
// from the clients' group, its passwords read from Parameter Store under the platform's path and never in the template,
// kept on delete; its outputs read back; a user and a database for each service, which the setup creates and closes to
// the others, and the URL each service connects with.

import { describe, expect, test } from 'bun:test'
import { blocksOverlap } from '../../cidr'
import { awsControlPolicies } from '../access'
import {
	AWS_DATABASE_ADMIN_PASSWORD_PARAMETER,
	AWS_DATABASE_SERVICES,
	AWS_DATABASE_STACK,
	awsDatabaseAdminUrl,
	awsDatabaseOutputs,
	awsDatabasePasswordParameter,
	type AwsDatabaseService,
	type AwsDatabaseSession,
	awsDatabaseSetupSteps,
	awsDatabaseStack,
	awsDatabaseSubnetCidrs,
	awsDatabaseUrl,
	runAwsDatabaseSetup,
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

	test('the instance: private, encrypted, backed up, protected from deletion, its passwords references Control cannot read', () => {
		expect(stack.stackName).toBe(AWS_DATABASE_STACK)
		expect(resources.Database).toMatchObject({ DeletionPolicy: 'Snapshot', UpdateReplacePolicy: 'Snapshot' })
		expect(resources.Database.Properties).toMatchObject({
			Engine: 'postgres',
			PubliclyAccessible: false,
			StorageEncrypted: true,
			DeletionProtection: true,
			BackupRetentionPeriod: 7,
			MasterUsername: 'fabrika_admin',
			MasterUserPassword: '{{resolve:ssm-secure:/fabrika/platform/database/admin-password}}',
		})
		expect(resources.Database.Properties.DBName).toBeUndefined()
		for (const parameter of [AWS_DATABASE_ADMIN_PASSWORD_PARAMETER, ...AWS_DATABASE_SERVICES.map(awsDatabasePasswordParameter)]) {
			expect(parameter.startsWith('/fabrika/platform/database/')).toBe(true)
		}
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

	test('the outputs are read back, one of another form refused, and each URL names its own user and database over TLS', () => {
		const outputs = awsDatabaseOutputs(OUTPUTS)
		expect(outputs).toEqual({ host: OUTPUTS.DatabaseHost, port: 5432, clientGroupId: 'sg-0123456789abcdef4' })
		expect(() => awsDatabaseOutputs({ ...OUTPUTS, DatabaseHost: 'example.com' })).toThrow('DatabaseHost')
		expect(() => awsDatabaseOutputs({ ...OUTPUTS, DatabasePort: 'x' })).toThrow('DatabasePort')
		expect(() => awsDatabaseOutputs({ ...OUTPUTS, DatabaseClientGroupId: '' })).toThrow('DatabaseClientGroupId')
		expect(awsDatabaseUrl(outputs, 'iam', PASSWORDS.iam)).toBe(
			`postgres://fabrika_iam:${PASSWORDS.iam}@${OUTPUTS.DatabaseHost}:5432/fabrika_iam?sslmode=require`,
		)
		expect(awsDatabaseUrl(outputs, 'operations', PASSWORDS.operations)).toContain('/fabrika_operations?sslmode=require')
		expect(awsDatabaseAdminUrl(outputs, ADMIN_PASSWORD)).toBe(
			`postgres://fabrika_admin:${ADMIN_PASSWORD}@${OUTPUTS.DatabaseHost}:5432/postgres?sslmode=require`,
		)
		// Letters and digits alone, 32 at least: nothing to escape in a literal or a URL.
		expect(() => awsDatabaseUrl(outputs, 'iam', 'short')).toThrow('32 to 128 letters and digits')
		expect(() => awsDatabaseUrl(outputs, 'iam', `${PASSWORDS.iam}'`)).toThrow('letters and digits')
	})
})

const PASSWORDS: Readonly<Record<AwsDatabaseService, string>> = {
	iam: 'Iam0123456789abcdefghijABCDEFGHIJ',
	control: 'Control0123456789abcdefghijABCDE',
	operations: 'Operations0123456789abcdefghijAB',
}
const ADMIN_PASSWORD = 'Admin0123456789abcdefghijABCDEFG'

/** A session that answers each probe from a set of existing names and records what ran. */
function fakeSession(existing: ReadonlySet<string>, failOn?: string): { session: AwsDatabaseSession; ran: string[] } {
	const ran: string[] = []
	const session: AwsDatabaseSession = {
		count: async (_text, params) => (params.some((param) => existing.has(param)) ? 1 : 0),
		execute: async (statement) => {
			if (failOn !== undefined && statement.includes(failOn)) throw new Error(`driver error quoting ${statement}`)
			ran.push(statement)
		},
	}
	return { session, ran }
}

describe("the services' users and databases", () => {
	test('a fresh instance: each service gets a user, the master SET on it, a database it owns, closed to everyone else', async () => {
		const { session, ran } = fakeSession(new Set())
		await runAwsDatabaseSetup(session, awsDatabaseSetupSteps(PASSWORDS))
		expect(ran.slice(0, 4)).toEqual([
			`CREATE ROLE "fabrika_iam" WITH LOGIN PASSWORD '${PASSWORDS.iam}'`,
			'GRANT "fabrika_iam" TO CURRENT_USER WITH SET TRUE, INHERIT FALSE',
			'CREATE DATABASE "fabrika_iam" OWNER "fabrika_iam"',
			'REVOKE ALL ON DATABASE "fabrika_iam" FROM PUBLIC',
		])
		expect(ran).toHaveLength(12)
		for (const service of ['control', 'operations']) expect(ran).toContain(`CREATE DATABASE "fabrika_${service}" OWNER "fabrika_${service}"`)
		// No service's user is granted another's role or database.
		expect(ran.filter((statement) => statement.startsWith('GRANT')).every((statement) => statement.includes('TO CURRENT_USER'))).toBe(true)
	})

	test('an upgrade: what exists is brought to the same state, each password set to its parameter', async () => {
		const { session, ran } = fakeSession(new Set(['fabrika_iam', 'fabrika_control', 'fabrika_operations']))
		await runAwsDatabaseSetup(session, awsDatabaseSetupSteps(PASSWORDS))
		expect(ran.some((statement) => statement.startsWith('CREATE'))).toBe(false)
		expect(ran).toContain(`ALTER ROLE "fabrika_control" WITH LOGIN PASSWORD '${PASSWORDS.control}'`)
		expect(ran).toContain('ALTER DATABASE "fabrika_control" OWNER TO "fabrika_control"')
	})

	test('a failing step is named by its label, never by its statement, which carries a password', async () => {
		const { session } = fakeSession(new Set(), 'CREATE ROLE "fabrika_control"')
		const failure = await runAwsDatabaseSetup(session, awsDatabaseSetupSteps(PASSWORDS)).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(Error)
		expect(String(failure)).toContain('the user fabrika_control')
		expect(String(failure)).not.toContain(PASSWORDS.control)
	})

	test('a password of another form is refused before any statement is built', () => {
		expect(() => awsDatabaseSetupSteps({ ...PASSWORDS, operations: "x'; DROP DATABASE fabrika_iam; --" })).toThrow('letters and digits')
	})
})
