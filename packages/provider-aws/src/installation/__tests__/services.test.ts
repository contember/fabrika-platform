// The platform's services: each task under the platform's family, image by digest, its variables secrets of its own
// path and no installation value in the template, its own role, group and log group; the three services in the
// platform's Service Connect namespace with their scheduled job beside them, the proxy a client behind the platform
// balancer, and the setup a task of its own stack, which the operator's command runs with the database's passwords
// alone before it applies the services.

import { describe, expect, test } from 'bun:test'
import type { AwsStack } from '../../stack'
import { awsDatabaseOutputs } from '../database'
import { runDatabaseSetupTask } from '../database-setup-main'
import { awsNetworkOutputs } from '../network'
import { awsRuntimeOutputs } from '../runtime'
import {
	AWS_SERVICES_STACK,
	AWS_SETUP_STACK,
	awsDatabaseSetupRun,
	type AwsServicesInput,
	awsServicesStack,
	type AwsSetupInput,
	awsSetupStack,
	checkAwsServicesInput,
	checkAwsSetupInput,
} from '../services'

const platform = awsNetworkOutputs({
	VpcId: 'vpc-0123456789abcdef9',
	VpcCidr: '10.81.0.0/16',
	TaskSubnetIds: 'subnet-0123456789abcdef4,subnet-0123456789abcdef5',
	TaskSubnetCidrs: '10.81.0.0/20,10.81.16.0/20',
	BalancerSubnetIds: 'subnet-0123456789abcdef6,subnet-0123456789abcdef7',
	BalancerSubnetCidrs: '10.81.240.0/24,10.81.241.0/24',
})
const NAMESPACE = 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-0123456789abcdef'
const runtime = awsRuntimeOutputs({
	NamespaceArn: NAMESPACE,
	IamGroupId: 'sg-0123456789abcdef1',
	ControlGroupId: 'sg-0123456789abcdef2',
	OperationsGroupId: 'sg-0123456789abcdef3',
	ProxyGroupId: 'sg-0123456789abcdef4',
	SetupGroupId: 'sg-0123456789abcdef5',
})
const database = awsDatabaseOutputs({
	DatabaseHost: 'fabrika-database-abcdefgh.c1a2b3c4d5e6.eu-central-1.rds.amazonaws.com',
	DatabasePort: '5432',
	DatabaseClientGroupId: 'sg-0123456789abcdef6',
})
const TARGET_GROUP = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/fabrika-platform-proxy/0123456789abcdef'
const SERVICES_DIGEST = `sha256:${'a'.repeat(64)}`
const PROXY_DIGEST = `sha256:${'b'.repeat(64)}`
const input: AwsServicesInput = {
	accountId: '123456789012',
	region: 'eu-central-1',
	platform,
	runtime,
	database,
	balancers: { platformProxyTargetGroupArn: TARGET_GROUP },
	images: { services: SERVICES_DIGEST, proxy: PROXY_DIGEST },
	variables: {
		iam: ['FABRIKA_IAM_DATABASE_URL', 'ISSUER', 'FABRIKA_IAM_SIGNING_KEYS'],
		control: ['FABRIKA_CONTROL_DATABASE_URL', 'FABRIKA_CONTROL_VAULT_KEY', 'FABRIKA_AWS_REGION'],
		operations: ['FABRIKA_OPERATIONS_DATABASE_URL', 'OPERATIONS_SYNC_KEY'],
		proxy: ['FABRIKA_IAM_ISSUER', 'FABRIKA_IAM_KEY'],
	},
}

interface Container {
	readonly Name: string
	readonly Image: string
	readonly Command?: readonly string[]
	readonly Environment?: readonly { Name: string; Value: string }[]
	readonly Secrets?: readonly { Name: string; ValueFrom: string }[]
	readonly DependsOn?: readonly { ContainerName: string; Condition: string }[]
	readonly LinuxParameters?: { readonly InitProcessEnabled?: boolean }
}

type Resources = Record<string, { Type: string; Properties: Record<string, unknown> }>
const resourcesOf = (stack: AwsStack): Resources => JSON.parse(JSON.stringify(stack.template)).Resources
const stack = awsServicesStack(input)
const setupInput: AwsSetupInput = { accountId: input.accountId, region: input.region, database, images: { services: SERVICES_DIGEST } }
const setupStack = awsSetupStack(setupInput)
const resources = { ...resourcesOf(stack), ...resourcesOf(setupStack) }
const containersOf = (logical: string): readonly Container[] =>
	JSON.parse(JSON.stringify(resources[logical]?.Properties['ContainerDefinitions'] ?? []))

describe("the platform's services", () => {
	test('the setup is a stack of its own, so the operator runs it before the services exist or move', () => {
		expect(stack.stackName).toBe(AWS_SERVICES_STACK)
		expect(setupStack.stackName).toBe(AWS_SETUP_STACK)
		expect(Object.keys(resourcesOf(setupStack))).toEqual(['SetupTaskDefinition'])
		expect(JSON.parse(JSON.stringify(setupStack.template)).Outputs).toEqual({ SetupTaskDefinitionArn: { Value: { Ref: 'SetupTaskDefinition' } } })
		// The services' stack holds no setup resource and needs nothing of the setup's.
		expect(Object.keys(resourcesOf(stack)).filter((logical) => logical.startsWith('Setup'))).toEqual([])
		expect(JSON.stringify(stack.template)).not.toContain('database-setup-main')
		expect(JSON.stringify(stack.template)).not.toContain('/fabrika/platform/database/')
	})

	test("every task is the platform's: its family, its execution role, its image by digest", () => {
		for (const task of ['Iam', 'Control', 'Operations', 'Proxy', 'Setup']) {
			const properties = resources[`${task}TaskDefinition`]?.Properties
			expect(properties?.['Family']).toBe(`fabrika_platform_${task.toLowerCase()}`)
			expect(properties?.['ExecutionRoleArn']).toBe(`arn:aws:iam::123456789012:role/fabrika/platform/fabrika-platform-${task.toLowerCase()}-execution`)
			for (const container of containersOf(`${task}TaskDefinition`)) {
				// By digest, never by a tag the lifecycle policy can free.
				expect(container.Image).toMatch(
					/^123456789012\.dkr\.ecr\.eu-central-1\.amazonaws\.com\/fabrika\/platform\/(?:services|proxy)@sha256:[0-9a-f]{64}$/,
				)
			}
		}
		expect(containersOf('ProxyTaskDefinition')[0]?.Image.endsWith(`fabrika/platform/proxy@${PROXY_DIGEST}`)).toBe(true)
		expect(containersOf('IamTaskDefinition')[0]?.Image.endsWith(`fabrika/platform/services@${SERVICES_DIGEST}`)).toBe(true)
	})

	test("each variable is a secret of the task's own path; the template holds no installation value", () => {
		expect(containersOf('IamTaskDefinition')[0]?.Secrets).toEqual(
			input.variables.iam.map((name) => ({ Name: name, ValueFrom: `arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/platform/iam/${name}` })),
		)
		expect(containersOf('ProxyTaskDefinition')[0]?.Secrets?.every((secret) => secret.ValueFrom.includes(':parameter/fabrika/platform/proxy/'))).toBe(
			true,
		)
		// The plain variables are the fixed addresses alone.
		expect(containersOf('ControlTaskDefinition')[0]?.Environment).toEqual([
			{ Name: 'PORT', Value: '3000' },
			{ Name: 'FABRIKA_CONTROL_ASSETS_DIR', Value: 'packages/dashboard/dist' },
			{ Name: 'FABRIKA_IAM_RPC_URL', Value: 'http://iam:3000' },
			{ Name: 'FABRIKA_OPERATIONS_URL', Value: 'http://operations:3000' },
		])
		expect(containersOf('IamTaskDefinition')[0]?.Environment).toEqual([{ Name: 'PORT', Value: '3000' }, {
			Name: 'FABRIKA_CONTROL_URL',
			Value: 'http://control:3000',
		}])
		// A variable the template sets itself, one twice, or a digest of another form is refused.
		expect(() => checkAwsServicesInput({ ...input, variables: { ...input.variables, control: ['FABRIKA_IAM_RPC_URL'] } })).toThrow("template's own")
		expect(() => checkAwsServicesInput({ ...input, variables: { ...input.variables, iam: ['ISSUER', 'ISSUER'] } })).toThrow('one twice')
		expect(() => checkAwsServicesInput({ ...input, variables: { ...input.variables, iam: ['lower'] } })).toThrow('another form')
		expect(() => checkAwsServicesInput({ ...input, images: { ...input.images, services: 'latest' } })).toThrow('digest')
		// A name the proxy image fixes would be replaced by the secret.
		for (const baked of ['FABRIKA_PROXY_MANIFEST', 'FABRIKA_PROXY_PORT']) {
			expect(() => checkAwsServicesInput({ ...input, variables: { ...input.variables, proxy: [baked] } })).toThrow("its image's own")
		}
		// What every ARN is built from is checked as the runtime stack checks it.
		expect(() => checkAwsServicesInput({ ...input, accountId: '12345' })).toThrow('account id or region')
		expect(() => checkAwsServicesInput({ ...input, region: 'eu-central-1:x' })).toThrow('account id or region')
		expect(() => checkAwsServicesInput({ ...input, balancers: { platformProxyTargetGroupArn: 'arn:aws:iam::123456789012:role/x' } })).toThrow(
			'target group',
		)
		expect(() => checkAwsSetupInput({ ...setupInput, region: 'nowhere' })).toThrow('account id or region')
		expect(() => checkAwsSetupInput({ ...setupInput, images: { services: 'latest' } })).toThrow('digest')
	})

	test('the three services: migrations then the server, their job once healthy, their own roles', () => {
		const [server, job] = containersOf('OperationsTaskDefinition')
		expect(server?.Command).toEqual(['sh', '-c', 'bun packages/operations/src/node/migrate.ts && exec bun packages/operations/src/node/server.ts'])
		expect(job?.Command).toEqual(['sh', '-c', 'while true; do bun packages/operations/src/node/cron.ts; sleep 60; done'])
		expect(job?.DependsOn).toEqual([{ ContainerName: 'server', Condition: 'HEALTHY' }])
		// An init process as PID 1, so a task's SIGTERM reaches the shell instead of being ignored.
		for (const container of [server, job, containersOf('SetupTaskDefinition')[0]]) {
			expect(container?.LinuxParameters).toEqual({ InitProcessEnabled: true })
		}
		expect(containersOf('ControlTaskDefinition')[1]?.Command?.[2]).toContain('bun packages/control/src/aws/cron.ts; sleep 300')
		expect(containersOf('IamTaskDefinition')[1]?.Command?.[2]).toContain('bun packages/iam/src/node/prune.ts; sleep 86400')
		expect(resources['ControlTaskDefinition']?.Properties['TaskRoleArn']).toBe('arn:aws:iam::123456789012:role/fabrika/platform/fabrika-control')
		expect(resources['OperationsTaskDefinition']?.Properties['TaskRoleArn']).toBe(
			'arn:aws:iam::123456789012:role/fabrika/platform/fabrika-platform-operations',
		)
		for (const task of ['Iam', 'Proxy', 'Setup']) expect(resources[`${task}TaskDefinition`]?.Properties['TaskRoleArn']).toBeUndefined()
	})

	test("in the platform's cluster and network, each task its own group, the database's client group beside the services'", () => {
		const configuration = (logical: string) => JSON.parse(JSON.stringify(resources[logical]?.Properties['NetworkConfiguration'])).AwsvpcConfiguration
		expect(configuration('IamService')).toEqual({
			Subnets: platform.taskSubnetIds,
			SecurityGroups: [runtime.groupIds.iam, database.clientGroupId],
			AssignPublicIp: 'ENABLED',
		})
		expect(configuration('ProxyService').SecurityGroups).toEqual([runtime.groupIds.proxy])
		for (const service of ['IamService', 'ControlService', 'OperationsService', 'ProxyService']) {
			expect(resources[service]?.Properties).toMatchObject({ Cluster: 'fabrika-platform', LaunchType: 'FARGATE', EnableExecuteCommand: false })
		}
		expect(awsDatabaseSetupRun(input)).toEqual({
			cluster: 'fabrika-platform',
			network: { subnets: platform.taskSubnetIds, securityGroups: [runtime.groupIds.setup, database.clientGroupId], publicIp: true },
		})
	})

	test("Service Connect: the services publish their names in the platform's namespace, the proxy dials them behind the balancer", () => {
		expect(resources['ControlService']?.Properties['ServiceConnectConfiguration']).toEqual({
			Enabled: true,
			Namespace: NAMESPACE,
			Services: [{
				PortName: 'http',
				DiscoveryName: 'control',
				ClientAliases: [{ Port: 3000, DnsName: 'control' }],
				// No 15 s cap on a whole response.
				Timeout: { PerRequestTimeoutSeconds: 0, IdleTimeoutSeconds: 300 },
			}],
		})
		expect(resources['ProxyService']?.Properties['ServiceConnectConfiguration']).toEqual({ Enabled: true, Namespace: NAMESPACE })
		expect(resources['ProxyService']?.Properties['LoadBalancers']).toEqual([{
			ContainerName: 'proxy',
			ContainerPort: 8080,
			TargetGroupArn: TARGET_GROUP,
		}])
	})

	test("the setup: no service, the database's address plain and its passwords secrets of the database's path", () => {
		expect(resources['SetupService']).toBeUndefined()
		const [setup] = containersOf('SetupTaskDefinition')
		expect(setup?.Command).toEqual(['bun', 'packages/provider-aws/src/installation/database-setup-main.ts'])
		expect(setup?.Environment).toEqual([{ Name: 'FABRIKA_AWS_DATABASE_HOST', Value: database.host }, {
			Name: 'FABRIKA_AWS_DATABASE_PORT',
			Value: '5432',
		}])
		const parameter = (name: string) => `arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/platform/database/${name}`
		expect(setup?.Secrets).toEqual([
			{ Name: 'FABRIKA_AWS_DATABASE_ADMIN_PASSWORD', ValueFrom: parameter('admin-password') },
			{ Name: 'FABRIKA_AWS_DATABASE_IAM_PASSWORD', ValueFrom: parameter('iam-password') },
			{ Name: 'FABRIKA_AWS_DATABASE_CONTROL_PASSWORD', ValueFrom: parameter('control-password') },
			{ Name: 'FABRIKA_AWS_DATABASE_OPERATIONS_PASSWORD', ValueFrom: parameter('operations-password') },
		])
	})

	test("the setup's entry refuses a missing variable by its name before it connects", async () => {
		await expect(runDatabaseSetupTask({ FABRIKA_AWS_DATABASE_PORT: '5432' })).rejects.toThrow('FABRIKA_AWS_DATABASE_HOST is not set')
		await expect(runDatabaseSetupTask({ FABRIKA_AWS_DATABASE_PORT: '5432', FABRIKA_AWS_DATABASE_HOST: database.host })).rejects.toThrow(
			'FABRIKA_AWS_DATABASE_IAM_PASSWORD is not set',
		)
		for (const port of ['five', '0', '65536', '54.32']) {
			await expect(runDatabaseSetupTask({ FABRIKA_AWS_DATABASE_PORT: port, FABRIKA_AWS_DATABASE_HOST: database.host })).rejects.toThrow(
				'FABRIKA_AWS_DATABASE_PORT is not a port',
			)
		}
	})
})
