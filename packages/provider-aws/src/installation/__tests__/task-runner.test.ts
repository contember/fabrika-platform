// The task runner's own source, run as Lambda would load it (CommonJS) against a fake `RunTask`: it starts a task in the
// cluster and the subnets of its own configuration whatever the request names, overrides one command and nothing else,
// refuses a platform task definition and every value of another form before anything runs, refuses everything while
// unconfigured, and answers only what the deploy reads.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AWS_TASK_RUNNER_SOURCE, awsTaskRunnerArn } from '../task-runner'

const DEFINITION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes_prod-init:7'
const TASK = `arn:aws:ecs:eu-central-1:123456789012:task/fabrika-apps/${'a'.repeat(32)}`
const SUBNETS = 'subnet-0123456789abcdef0,subnet-0123456789abcdef1'

type Run = (input: Readonly<Record<string, unknown>>) => Promise<unknown>
type Handler = (event: unknown) => Promise<unknown>

let directory = ''
let make: (run: Run) => Handler = () => async () => undefined

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'fabrika-runner-'))
	const file = join(directory, 'index.cjs')
	writeFileSync(file, AWS_TASK_RUNNER_SOURCE)
	const loaded: unknown = await import(file)
	const exported: unknown = Reflect.get(Object(loaded), 'make') ?? Reflect.get(Object(Reflect.get(Object(loaded), 'default')), 'make')
	if (typeof exported !== 'function') throw new Error('the runner exports no make')
	make = (run) => {
		const handler: unknown = Reflect.apply(exported, undefined, [run])
		if (typeof handler !== 'function') throw new Error('make answers no handler')
		return (event) => Promise.resolve(Reflect.apply(handler, undefined, [event]))
	}
})

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
	delete process.env['CLUSTER']
	delete process.env['SUBNETS']
})

function configure(): void {
	process.env['CLUSTER'] = 'fabrika-apps'
	process.env['SUBNETS'] = SUBNETS
}

/** A `RunTask` that answers `answer` and records every input. */
function fake(answer: unknown): { readonly run: Run; readonly inputs: unknown[] } {
	const inputs: unknown[] = []
	return {
		inputs,
		run: async (input) => {
			inputs.push(input)
			return answer
		},
	}
}

const request = {
	taskDefinition: DEFINITION,
	container: 'init',
	command: ['sh', '/app/fabrika/migrate.generated.sh'],
	securityGroups: ['sg-0123456789abcdef0'],
	publicIp: false,
	clientToken: 'token-init-1',
	startedBy: 'fabrika-run-token',
}

describe('the task runner', () => {
	test('starts the task in its own cluster and subnets, whatever the request names, and answers what the deploy reads', async () => {
		configure()
		const ecs = fake({
			tasks: [{
				taskArn: TASK,
				lastStatus: 'PROVISIONING',
				createdAt: new Date(0),
				attachments: [{ id: 'x' }],
				containers: [{ name: 'init', containerArn: 'c', networkInterfaces: [] }],
			}],
			failures: [],
			$metadata: { requestId: 'r' },
		})
		const answer = await make(ecs.run)({
			...request,
			cluster: 'fabrika-platform',
			subnets: ['subnet-00000000000000009'],
			overrides: { taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika/platform/fabrika-control' },
			enableExecuteCommand: true,
		})
		expect(ecs.inputs).toEqual([{
			cluster: 'fabrika-apps',
			taskDefinition: DEFINITION,
			launchType: 'FARGATE',
			count: 1,
			clientToken: 'token-init-1',
			startedBy: 'fabrika-run-token',
			networkConfiguration: {
				awsvpcConfiguration: { subnets: SUBNETS.split(','), securityGroups: ['sg-0123456789abcdef0'], assignPublicIp: 'DISABLED' },
			},
			overrides: { containerOverrides: [{ name: 'init', command: ['sh', '/app/fabrika/migrate.generated.sh'] }] },
		}])
		expect(JSON.parse(JSON.stringify(answer))).toEqual({
			tasks: [{ taskArn: TASK, lastStatus: 'PROVISIONING', containers: [{ name: 'init' }] }],
			failures: [],
		})
	})

	test('refuses a platform task definition and every value of another form before anything runs', async () => {
		configure()
		const ecs = fake({ tasks: [] })
		const refusals: readonly [Readonly<Record<string, unknown>>, string][] = [
			[{ taskDefinition: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/fabrika_platform_control:3' }, 'a platform task definition'],
			[{ taskDefinition: 'notes_prod-init:7' }, 'the task definition'],
			[{ taskDefinition: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes_prod-init' }, 'the task definition'],
			[{ container: 'has space' }, 'the container'],
			[{ command: [] }, 'the command'],
			[{ command: ['sh', 1] }, 'the command'],
			[{ securityGroups: ['sg-x'] }, 'the security groups'],
			[{ securityGroups: Array.from({ length: 6 }, (_, index) => `sg-0123456789abcdef${index}`) }, 'the security groups'],
			[{ clientToken: 'x'.repeat(65) }, 'the client token'],
			[{ startedBy: 'has space' }, 'the starter'],
		]
		for (const [change, reason] of refusals) {
			const failure = await make(ecs.run)({ ...request, ...change }).catch((error: unknown) => error)
			expect(failure).toMatchObject({ name: 'TaskRunnerRefused', message: `refused: ${reason}` })
		}
		expect(ecs.inputs).toEqual([])
	})

	test('refuses everything while it is not configured', async () => {
		const ecs = fake({ tasks: [] })
		for (const missing of ['CLUSTER', 'SUBNETS']) {
			configure()
			delete process.env[missing]
			const failure = await make(ecs.run)(request).catch((error: unknown) => error)
			expect(failure).toMatchObject({ name: 'TaskRunnerRefused', message: 'refused: the runner is not configured' })
		}
		expect(ecs.inputs).toEqual([])
	})

	test('a public address only when asked for one; an error of RunTask passes through with its name', async () => {
		configure()
		const ecs = fake({ tasks: [] })
		await make(ecs.run)({ ...request, publicIp: true })
		expect(JSON.stringify(ecs.inputs[0])).toContain('"assignPublicIp":"ENABLED"')
		const throttled = new Error('Rate exceeded')
		throttled.name = 'ThrottlingException'
		const failure = await make(async () => {
			throw throttled
		})(request).catch((error: unknown) => error)
		expect(failure).toBe(throttled)
		expect(awsTaskRunnerArn('123456789012', 'eu-central-1')).toBe('arn:aws:lambda:eu-central-1:123456789012:function:fabrika-task-runner')
	})
})
