// The task definitions of one application environment, from an image `containerImage` rendered: the service's carries
// the server alone with its health check on the contract's health endpoint, the init definition carries the commands
// the deploy runs once before the update, a framework credential never goes as a plain value, and the ECS client takes
// what it renders (every check of `registerTaskDefinition` runs over it).

import { containerImage, type ContainerImageInput } from '@fabrika/app/build'
import { describe, expect, test } from 'bun:test'
import { ecsClient } from '../aws/ecs'
import { ECS } from '../aws/json'
import {
	AWS_APPLICATION_PORT,
	type AwsTaskDefinitionInput,
	awsTaskDefinitions,
	INIT_CONTAINER,
	INIT_FAMILY_SUFFIX,
	SERVER_CONTAINER,
} from '../ecs-task'
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
	environment: { FABRIKA_APP_ID: 'notes', FABRIKA_IAM_RPC_URL: 'http://iam.fabrika.local:3000', LOG_LEVEL: 'info' },
	secrets: { STRIPE_KEY: PARAMETER },
	taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika-apps-notes-prod',
	executionRoleArn: 'arn:aws:iam::123456789012:role/fabrika-apps-notes-prod-execution',
	cpu: 512,
	memory: 1024,
	log: { group: '/fabrika/apps/notes-prod', region: 'eu-central-1' },
	tags: { 'fabrika:app': 'notes' },
}

describe('awsTaskDefinitions', () => {
	test("the service's definition carries the server alone, with its health check on the contract's health endpoint", () => {
		const { service } = awsTaskDefinitions(input)
		expect(service.containers.length).toBe(1)
		const [server] = service.containers
		expect(server).toEqual({
			name: SERVER_CONTAINER,
			image: IMAGE,
			essential: true,
			port: AWS_APPLICATION_PORT,
			command: [...rendered.start],
			environment: input.environment,
			secrets: input.secrets,
			healthCheck: {
				command: ['CMD', 'bun', '-e', 'fetch("http://127.0.0.1:3000/__fabrika/health").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'],
				intervalSeconds: 10,
				timeoutSeconds: 5,
				retries: 3,
				startPeriodSeconds: 60,
			},
			log: { ...input.log, streamPrefix: SERVER_CONTAINER },
		})
		expect(service).toMatchObject({
			family: 'notes-prod',
			taskRoleArn: input.taskRoleArn,
			executionRoleArn: input.executionRoleArn,
			cpu: 512,
			memory: 1024,
			tags: input.tags,
		})
	})

	test('the init commands are a one-off definition the deploy runs once per command, never a container of every task', () => {
		// With a database the recipe migrates and then checks the schema at container start.
		expect(rendered.init.length).toBe(2)
		const { service, init } = awsTaskDefinitions(input)
		expect(service.containers.some((container) => container.dependsOn !== undefined)).toBe(false)
		expect(init?.commands).toEqual(rendered.init.map((command) => [...command]))
		expect(init?.definition.family).toBe(`notes-prod${INIT_FAMILY_SUFFIX}`)
		expect(init?.definition.containers).toEqual([{
			name: INIT_CONTAINER,
			image: IMAGE,
			essential: true,
			command: [...(rendered.init[0] ?? [])],
			environment: input.environment,
			secrets: input.secrets,
			log: { ...input.log, streamPrefix: INIT_CONTAINER },
		}])
		expect(init?.definition).toMatchObject({ taskRoleArn: input.taskRoleArn, executionRoleArn: input.executionRoleArn, cpu: 512, memory: 1024 })
	})

	test('without a database there is no init definition', () => {
		const alone = containerImage({ ...imageInput, recipe: { ...imageInput.recipe, database: false } })
		expect(awsTaskDefinitions({ ...input, rendered: alone }).init).toBeNull()
	})

	test('the ECS client registers both definitions', async () => {
		const { options, calls } = fakeAws(ECS, {
			RegisterTaskDefinition: (body) => {
				const family = JSON.stringify(body).includes(INIT_FAMILY_SUFFIX) ? `notes-prod${INIT_FAMILY_SUFFIX}` : 'notes-prod'
				return { taskDefinition: { taskDefinitionArn: `arn:aws:ecs:eu-central-1:123456789012:task-definition/${family}:7`, family, revision: 7 } }
			},
		})
		const ecs = ecsClient(options)
		const { service, init } = awsTaskDefinitions(input)
		expect(await ecs.registerTaskDefinition(service)).toMatchObject({ family: 'notes-prod', revision: 7 })
		if (init === null) throw new Error('an application with a database has init commands')
		expect(await ecs.registerTaskDefinition(init.definition)).toMatchObject({ family: `notes-prod${INIT_FAMILY_SUFFIX}` })
		expect(calls[0]?.body).toMatchObject({
			containerDefinitions: [{
				name: SERVER_CONTAINER,
				portMappings: [{ containerPort: 3000, protocol: 'tcp' }],
				secrets: [{ name: 'STRIPE_KEY', valueFrom: PARAMETER }],
			}],
		})
		expect(calls[1]?.body).toMatchObject({ containerDefinitions: [{ name: INIT_CONTAINER, essential: true }] })
	})

	test('refuses what it cannot render, and a framework credential as a plain value', () => {
		const refusals: readonly [Partial<AwsTaskDefinitionInput>, string][] = [
			[{ family: 'x'.repeat(251) }, 'the family'],
			[{ image: IMAGE.replace(/@sha256:.*/, ':latest') }, 'the image (by digest)'],
			[{ healthPath: 'health' }, 'the health path'],
			[{ healthPath: '/a/../b' }, 'the health path'],
			[{ rendered: { init: [], start: [] } }, 'the image commands'],
			[{ rendered: { init: [[]], start: rendered.start } }, 'the image commands'],
			[{ environment: { PORT: '8080' } }, 'the variable PORT'],
			[{ secrets: { PORT: PARAMETER } }, 'the variable PORT'],
			[{ environment: { FABRIKA_PROXY_SECRET: 'not-to-be-quoted' } }, 'the plain variable FABRIKA_PROXY_SECRET (a credential)'],
			[{ environment: { FABRIKA_IAM_RPC_KEY: 'not-to-be-quoted' } }, 'the plain variable FABRIKA_IAM_RPC_KEY'],
			// Fail closed: a framework name not known to be public is a credential.
			[{ environment: { FABRIKA_SOMETHING_NEW: 'x' } }, 'the plain variable FABRIKA_SOMETHING_NEW'],
		]
		for (const [change, message] of refusals) expect(() => awsTaskDefinitions({ ...input, ...change })).toThrow(message)
		expect(() => awsTaskDefinitions({ ...input, environment: { FABRIKA_PROXY_SECRET: 'not-to-be-quoted' } })).not.toThrow('not-to-be-quoted')
	})
})
