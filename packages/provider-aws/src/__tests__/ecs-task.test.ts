// The task definition of one application environment, from an image `containerImage` rendered: the init containers in
// order before the server, the server's health check on the contract's health endpoint, and that the ECS client takes
// what it renders (every check of `registerTaskDefinition` runs over it).

import { containerImage, type ContainerImageInput } from '@fabrika/app/build'
import { describe, expect, test } from 'bun:test'
import { ecsClient } from '../aws/ecs'
import { ECS } from '../aws/json'
import { AWS_APPLICATION_PORT, awsTaskDefinition, type AwsTaskDefinitionInput, SERVER_CONTAINER } from '../ecs-task'
import { fakeAws } from './helpers/fake-aws'

const imageInput: ContainerImageInput = {
	recipe: {
		appId: 'notes',
		checkRelease: '0.9.1',
		sourceRoot: '/src',
		runtimeRoot: '/app',
		database: { schemaChecks: 'init' },
		sourceMaps: false,
		jobs: [],
		files: false,
		scan: false,
	},
	baseImage: `oven/bun:1.4.4-alpine@sha256:${'b'.repeat(64)}`,
	spaCommands: [],
	runtimePackages: [],
	runtimeFiles: [],
	sourceMapUpload: null,
	runtimeUser: '1000:1000',
}
const rendered = containerImage(imageInput)
const IMAGE = `123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/notes-prod@sha256:${'a'.repeat(64)}`
const PARAMETER = 'arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/main/apps/notes/prod/STRIPE_KEY'

const input: AwsTaskDefinitionInput = {
	family: 'notes-prod',
	image: IMAGE,
	rendered,
	healthPath: '/__fabrika/health',
	environment: { FABRIKA_APP_ID: 'notes', LOG_LEVEL: 'info' },
	secrets: { STRIPE_KEY: PARAMETER },
	taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika-apps-notes-prod',
	executionRoleArn: 'arn:aws:iam::123456789012:role/fabrika-apps-notes-prod-execution',
	cpu: 512,
	memory: 1024,
	log: { group: '/fabrika/apps/notes-prod', region: 'eu-central-1' },
	tags: { 'fabrika:app': 'notes' },
}

describe('awsTaskDefinition', () => {
	test('runs each init command in order in a container of its own before the server', () => {
		// With a database the recipe migrates and then checks the schema at container start.
		expect(rendered.init.length).toBe(2)
		const definition = awsTaskDefinition(input)
		expect(definition.containers.map((container) => [container.name, container.essential, container.dependsOn ?? []])).toEqual([
			['init-1', false, []],
			['init-2', false, [{ container: 'init-1', condition: 'SUCCESS' }]],
			[SERVER_CONTAINER, true, [{ container: 'init-2', condition: 'SUCCESS' }]],
		])
		expect(definition.containers.map((container) => container.command)).toEqual([...rendered.init, rendered.start])
		for (const container of definition.containers) {
			expect(container.image).toBe(IMAGE)
			expect(container.environment).toEqual(input.environment)
			expect(container.secrets).toEqual(input.secrets)
			expect(container.log).toEqual({ ...input.log, streamPrefix: container.name })
		}
		expect(definition).toMatchObject({
			family: 'notes-prod',
			taskRoleArn: input.taskRoleArn,
			executionRoleArn: input.executionRoleArn,
			cpu: 512,
			memory: 1024,
			tags: input.tags,
		})
	})

	test("checks the server's health on the contract's health endpoint over the loopback", () => {
		const server = awsTaskDefinition(input).containers.at(-1)
		expect(server?.port).toBe(AWS_APPLICATION_PORT)
		expect(server?.healthCheck).toEqual({
			command: ['CMD', 'bun', '-e', 'fetch("http://127.0.0.1:3000/__fabrika/health").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'],
			intervalSeconds: 10,
			timeoutSeconds: 5,
			retries: 3,
			startPeriodSeconds: 60,
		})
	})

	test('without a database the server runs alone', () => {
		const alone = containerImage({ ...imageInput, recipe: { ...imageInput.recipe, database: false } })
		const definition = awsTaskDefinition({ ...input, rendered: alone })
		expect(definition.containers.map((container) => container.name)).toEqual([SERVER_CONTAINER])
		expect(definition.containers[0]?.dependsOn).toBeUndefined()
	})

	test('the ECS client registers what it renders', async () => {
		const { options, calls } = fakeAws(ECS, {
			RegisterTaskDefinition: () => ({
				taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:7', family: 'notes-prod', revision: 7 },
			}),
		})
		expect(await ecsClient(options).registerTaskDefinition(awsTaskDefinition(input))).toMatchObject({ revision: 7 })
		expect(calls[0]?.body).toMatchObject({
			family: 'notes-prod',
			containerDefinitions: [
				{ name: 'init-1', essential: false },
				{ name: 'init-2', essential: false, dependsOn: [{ containerName: 'init-1', condition: 'SUCCESS' }] },
				{
					name: SERVER_CONTAINER,
					essential: true,
					portMappings: [{ containerPort: 3000, protocol: 'tcp' }],
					secrets: [{ name: 'STRIPE_KEY', valueFrom: PARAMETER }],
				},
			],
		})
	})

	test('refuses what it cannot render', () => {
		const refusals: readonly [Partial<AwsTaskDefinitionInput>, string][] = [
			[{ image: IMAGE.replace(/@sha256:.*/, ':latest') }, 'the image (by digest)'],
			[{ healthPath: 'health' }, 'the health path'],
			[{ healthPath: '/a/../b' }, 'the health path'],
			[{ rendered: { init: [], start: [] } }, 'the image commands'],
			[{ rendered: { init: [[]], start: rendered.start } }, 'the image commands'],
			[{ environment: { PORT: '8080' } }, 'the variable PORT'],
			[{ secrets: { PORT: PARAMETER } }, 'the variable PORT'],
		]
		for (const [change, message] of refusals) expect(() => awsTaskDefinition({ ...input, ...change })).toThrow(message)
	})
})
