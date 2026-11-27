// The platform's stacks in order over an in-memory CloudFormation: each stack's input from the outputs before it, the
// database's passwords written once before the database, the images between their stack and the setup's, the setup run
// and awaited before the parameters and the services, a second run changing nothing, and a failed setup stopping the
// run before any service moves.

import { describe, expect, test } from 'bun:test'
import type { CloudFormationClient, StackStatus } from '../../aws/cloudformation'
import type { EcsPlatformTasks, EcsPlatformTaskStart, EcsTaskRun } from '../../aws/ecs'
import { AWS_ACCESS_STACK } from '../access'
import { applyAwsPlatform, AWS_SETUP_STARTED_BY, awsDatabasePassword, type AwsPlatformApplyInput, type AwsPlatformPlan } from '../apply'
import { AWS_BALANCERS_STACK } from '../balancers'
import { AWS_DATABASE_STACK } from '../database'
import { AWS_IMAGES_STACK } from '../images'
import { AWS_NETWORK_STACKS } from '../network'
import { AWS_RUNTIME_STACK } from '../runtime'
import { AWS_SERVICES_STACK, AWS_SETUP_STACK } from '../services'

const certificate = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const plan: AwsPlatformPlan = {
	accountId: '123456789012',
	region: 'eu-central-1',
	vpcCidrs: { apps: '10.80.0.0/16', platform: '10.81.0.0/16' },
	hosts: { iam: 'iam.example.com', control: 'control.example.com', operations: 'operations.example.com' },
	certificates: { iam: certificate(1), control: certificate(2), operations: certificate(3) },
	appsDefault: { host: 'apps.example.com', certificate: certificate(4) },
}
const SETUP_DEFINITION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/fabrika_platform_setup:1'
const TASK = `arn:aws:ecs:eu-central-1:123456789012:task/fabrika-platform/${'c'.repeat(32)}`
const OUTPUTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	[AWS_NETWORK_STACKS.apps]: {
		VpcId: 'vpc-0123456789abcdef0',
		VpcCidr: '10.80.0.0/16',
		TaskSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
		TaskSubnetCidrs: '10.80.0.0/20,10.80.16.0/20',
		BalancerSubnetIds: 'subnet-0123456789abcdef2,subnet-0123456789abcdef3',
		BalancerSubnetCidrs: '10.80.240.0/24,10.80.241.0/24',
	},
	[AWS_NETWORK_STACKS.platform]: {
		VpcId: 'vpc-0123456789abcdef9',
		VpcCidr: '10.81.0.0/16',
		TaskSubnetIds: 'subnet-0123456789abcdef4,subnet-0123456789abcdef5',
		TaskSubnetCidrs: '10.81.0.0/20,10.81.16.0/20',
		BalancerSubnetIds: 'subnet-0123456789abcdef6,subnet-0123456789abcdef7',
		BalancerSubnetCidrs: '10.81.240.0/24,10.81.241.0/24',
	},
	[AWS_BALANCERS_STACK]: {
		AppsBalancerGroupId: 'sg-0123456789abcdef1',
		AppsHttpsListenerArn: 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210',
		AppsBalancerDnsName: 'fabrika-apps-1234567890.eu-central-1.elb.amazonaws.com',
		PlatformBalancerGroupId: 'sg-0123456789abcdef2',
		PlatformProxyTargetGroupArn: 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/fabri-Platf-1A2B3C4D/0123456789abcdef',
		PlatformBalancerDnsName: 'fabrika-platform-1234567890.eu-central-1.elb.amazonaws.com',
	},
	[AWS_DATABASE_STACK]: {
		DatabaseHost: 'fabrika-database-abcdefgh.c1a2b3c4d5e6.eu-central-1.rds.amazonaws.com',
		DatabasePort: '5432',
		DatabaseClientGroupId: 'sg-0123456789abcdefa',
	},
	[AWS_RUNTIME_STACK]: {
		NamespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-0123456789abcdef',
		IamGroupId: 'sg-0123456789abcdef3',
		ControlGroupId: 'sg-0123456789abcdef4',
		OperationsGroupId: 'sg-0123456789abcdef5',
		ProxyGroupId: 'sg-0123456789abcdef6',
		SetupGroupId: 'sg-0123456789abcdef7',
	},
	[AWS_SETUP_STACK]: { SetupTaskDefinitionArn: SETUP_DEFINITION },
}
const ORDER = [
	AWS_NETWORK_STACKS.apps,
	AWS_NETWORK_STACKS.platform,
	AWS_BALANCERS_STACK,
	AWS_DATABASE_STACK,
	AWS_RUNTIME_STACK,
	AWS_ACCESS_STACK,
	AWS_IMAGES_STACK,
	AWS_SETUP_STACK,
	AWS_SERVICES_STACK,
]

/** One account's CloudFormation in memory: every write settles at once, with the outputs `OUTPUTS` names. */
function fakeCloudFormation(events: string[]) {
	const stacks = new Map<string, { id: string; body: string; status: StackStatus }>()
	const nameOf = (id: string) => [...stacks.entries()].find(([, stack]) => stack.id === id)?.[0] ?? ''
	const client: Pick<CloudFormationClient, 'findStack' | 'describeStack' | 'getTemplate' | 'createStack' | 'updateStack'> = {
		findStack: async (name) => {
			const stack = stacks.get(name)
			return stack === undefined ? null : { stackId: stack.id, status: stack.status }
		},
		describeStack: async (id) => {
			const name = nameOf(id)
			const stack = stacks.get(name)
			if (stack === undefined) throw new Error(`no stack ${id}`)
			return { stackId: id, status: stack.status, outputs: OUTPUTS[name] ?? {} }
		},
		getTemplate: async (name) => stacks.get(name)?.body ?? '',
		createStack: async ({ name, templateBody }) => {
			const id = `arn:aws:cloudformation:eu-central-1:123456789012:stack/${name}/${stacks.size}`
			stacks.set(name, { id, body: templateBody, status: 'CREATE_COMPLETE' })
			events.push(`create ${name}`)
			return id
		},
		updateStack: async ({ name, templateBody }) => {
			const stack = stacks.get(name)
			if (stack === undefined) throw new Error(`no stack ${name}`)
			stacks.set(name, { ...stack, body: templateBody, status: 'UPDATE_COMPLETE' })
			events.push(`update ${name}`)
			return stack.id
		},
	}
	return { client, stacks }
}

/** ECS's task calls: the setup is started, read once while it runs, and stops with `exitCode`. */
function fakeTasks(events: string[], exitCode: number | null) {
	const started: EcsPlatformTaskStart[] = []
	const tasks: EcsPlatformTasks = {
		runTask: async (start) => {
			started.push(start)
			events.push('run setup')
			return { arn: TASK, status: 'pending', exitCode: null, stopCode: null, reason: null }
		},
		describeTask: async (): Promise<EcsTaskRun> => ({
			arn: TASK,
			status: 'stopped',
			exitCode,
			stopCode: 'EssentialContainerExited',
			reason: exitCode === 0 ? null : 'Essential container in task exited',
		}),
	}
	return { tasks, started }
}

function run(
	options: { readonly events: string[]; readonly exitCode?: number | null; readonly cloudFormation?: ReturnType<typeof fakeCloudFormation> },
) {
	const { events } = options
	const cloudFormation = options.cloudFormation ?? fakeCloudFormation(events)
	const { tasks, started } = fakeTasks(events, options.exitCode === undefined ? 0 : options.exitCode)
	const written = new Set<string>()
	const lines: string[] = []
	const input: AwsPlatformApplyInput = {
		plan,
		cloudFormation: cloudFormation.client,
		tasks,
		secrets: {
			putSecretOnce: async (name) => {
				events.push(`password ${name}`)
				if (written.has(name)) return false
				written.add(name)
				return true
			},
		},
		images: async (state) => {
			events.push(`images ${state.platform.balancerSubnetCidrs.join(',')}`)
			return { services: `sha256:${'a'.repeat(64)}`, proxy: `sha256:${'b'.repeat(64)}` }
		},
		parameters: async (state) => {
			events.push(`parameters ${state.database.host}`)
			return { iam: ['FABRIKA_IAM_DATABASE_URL'], control: ['FABRIKA_CONTROL_DATABASE_URL'], operations: ['FABRIKA_OPERATIONS_DATABASE_URL'], proxy: [] }
		},
		signal: new AbortController().signal,
		sleep: async () => {},
		log: (line) => lines.push(line),
		newPassword: () => 'A'.repeat(40),
	}
	return { input, cloudFormation, started, lines, written }
}

describe("the platform's stacks in order", () => {
	test('each stack after the ones it needs; the passwords before the database, the setup before the parameters and the services', async () => {
		const events: string[] = []
		const { input, lines } = run({ events })
		const applied = await applyAwsPlatform(input)
		const passwords = [
			'/fabrika/platform/database/admin-password',
			'/fabrika/platform/database/iam-password',
			'/fabrika/platform/database/control-password',
			'/fabrika/platform/database/operations-password',
		]
		expect(events).toEqual([
			`create ${AWS_NETWORK_STACKS.apps}`,
			`create ${AWS_NETWORK_STACKS.platform}`,
			`create ${AWS_BALANCERS_STACK}`,
			...passwords.map((name) => `password ${name}`),
			`create ${AWS_DATABASE_STACK}`,
			`create ${AWS_RUNTIME_STACK}`,
			`create ${AWS_ACCESS_STACK}`,
			`create ${AWS_IMAGES_STACK}`,
			// The images learn the platform balancer's subnets, which the proxy trusts.
			'images 10.81.240.0/24,10.81.241.0/24',
			`create ${AWS_SETUP_STACK}`,
			'run setup',
			`parameters ${OUTPUTS[AWS_DATABASE_STACK]?.['DatabaseHost']}`,
			`create ${AWS_SERVICES_STACK}`,
		])
		expect(applied.balancers.platformBalancerDnsName).toBe('fabrika-platform-1234567890.eu-central-1.elb.amazonaws.com')
		expect(lines.at(-1)).toBe(
			'aws: the platform serves; point iam.example.com, control.example.com, operations.example.com at fabrika-platform-1234567890.eu-central-1.elb.amazonaws.com',
		)
		// No password is ever logged, only its parameter's name.
		expect(lines.join('\n')).not.toContain('A'.repeat(40))
	})

	test("the setup runs in the platform's cluster and task subnets, under its group and the database's client group", async () => {
		const { input, started } = run({ events: [] })
		await applyAwsPlatform(input)
		expect(started).toHaveLength(1)
		expect(started[0]).toMatchObject({
			cluster: 'fabrika-platform',
			taskDefinitionArn: SETUP_DEFINITION,
			container: 'setup',
			network: {
				subnets: ['subnet-0123456789abcdef4', 'subnet-0123456789abcdef5'],
				securityGroups: ['sg-0123456789abcdef7', 'sg-0123456789abcdefa'],
				publicIp: true,
			},
			startedBy: AWS_SETUP_STARTED_BY,
		})
	})

	test('a second run creates nothing and writes no password again; the setup runs again, as on every upgrade', async () => {
		const first: string[] = []
		const once = run({ events: first })
		await applyAwsPlatform(once.input)
		const second: string[] = []
		const again = run({ events: second, cloudFormation: once.cloudFormation })
		// The same account: its parameters exist.
		for (const name of once.written) again.written.add(name)
		await applyAwsPlatform(again.input)
		expect(second.filter((event) => event.startsWith('create ') || event.startsWith('update '))).toEqual([])
		expect(second).toContain('run setup')
		expect(again.lines.filter((line) => line.startsWith('aws: wrote'))).toEqual([])
		expect([...once.cloudFormation.stacks.keys()]).toEqual(ORDER)
	})

	test('a failed setup stops the run before the parameters and the services, naming its exit and stop code', async () => {
		const events: string[] = []
		const { input } = run({ events, exitCode: 1 })
		await expect(applyAwsPlatform(input)).rejects.toThrow(`aws: the database setup ${TASK} failed (exit code 1; EssentialContainerExited;`)
		expect(events.at(-1)).toBe('run setup')
		const unrun = run({ events: [], exitCode: null })
		await expect(applyAwsPlatform(unrun.input)).rejects.toThrow('no exit code')
	})

	test('overlapping networks are refused before anything is sent', async () => {
		const events: string[] = []
		const { input } = run({ events })
		await expect(applyAwsPlatform({ ...input, plan: { ...plan, vpcCidrs: { apps: '10.80.0.0/16', platform: '10.80.0.0/16' } } })).rejects.toThrow(
			'overlap',
		)
		expect(events).toEqual([])
	})
})

describe('awsDatabasePassword', () => {
	test('forty letters and digits, a new one each time', () => {
		const passwords = Array.from({ length: 20 }, () => awsDatabasePassword())
		for (const password of passwords) expect(password).toMatch(/^[A-Za-z0-9]{40}$/)
		expect(new Set(passwords).size).toBe(passwords.length)
	})
})
