// The AWS `ControlProvider` over fakes of its AWS calls and of Control's source: a deploy writes the secrets to Parameter
// Store and names them by ARN in the task, uploads the run's commit in parts, deletes a secret no longer handed after a
// successful rollout, and refuses before any call what this version does not deploy. A cancel goes to the shared run.

import { contractDigest } from '@fabrika/auth-core'
import type { JsonValue, ProviderDeployInput, ProviderEnvironment, ProviderRunEvents } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { EcsService } from '../aws/ecs'
import { awsAppArtifactCodec, type AwsAppTarget, awsAppTargetCodec } from '../codecs'
import { type AwsControlClients, type AwsSourcePort, awsSourceRepository, awsTaskValues, createAwsControlProvider } from '../control'

const COMMIT = 'c'.repeat(40)
const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const BUILD_ID = `fabrika-build:${TOKEN}`
const REVISION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:42'
const DEPLOYMENT = 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/notes-prod/r2ZTbPmlNM0uqVbg2nTT4'
const SERVICE_ARN = 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/notes-prod'
const BASE_IMAGE = `oven/bun:1.4.4-alpine@sha256:${'b'.repeat(64)}`

const target: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	service: 'notes-prod',
	sourcesBucket: 'fabrika-sources-123456789012',
	buildProject: 'fabrika-build',
	repository: 'fabrika/notes-prod',
	parameterPath: '/fabrika/notes/prod',
	logGroup: '/fabrika/notes/prod',
	taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika/notes-prod-task',
	executionRoleArn: 'arn:aws:iam::123456789012:role/fabrika/notes-prod-execution',
}
/** The notes contract without what this version refuses: a database, jobs, file collections. */
const contract = { ...notesArtifact, tables: {}, jobs: {}, files: {}, fileKinds: {} }

const environmentOf = (change: Partial<ProviderEnvironment> = {}, payload: AwsAppTarget = target): ProviderEnvironment => ({
	appId: 'notes',
	env: 'prod',
	target: { provider: 'aws', version: 1, payload: awsAppTargetCodec.encode(payload) },
	artifact: { provider: 'aws', version: 1, payload: awsAppArtifactCodec.encode({ contractDigest: contractDigest(contract), healthPath: '/healthz' }) },
	access: { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract), checker: '0.9.1' },
	...change,
})

class Recorder implements ProviderRunEvents {
	readonly lines: string[] = []
	log(line: string): void {
		this.lines.push(line)
	}
	async externalId(): Promise<void> {}
	async checkpoint(): Promise<void> {}
	async boundary(): Promise<void> {}
}

/** Fakes of every call, each recorded; the parameters Parameter Store holds. */
class Fake {
	readonly calls: string[] = []
	readonly parameters = new Map<string, string>([['/fabrika/notes/prod/env/OLD_SECRET', 'old']])
	readonly registered: { environment: Readonly<Record<string, string>>; secrets: Readonly<Record<string, string>> }[] = []
	readonly uploads: string[] = []
	expiresAt: number | undefined = undefined

	readonly source: AwsSourcePort = {
		resolve: async (input) => {
			this.calls.push(`resolve ${input.repository.owner}/${input.repository.name} ${input.requestedRef}`)
			return { commitSha: COMMIT }
		},
		upload: async (input) => {
			this.uploads.push(`${input.repository.owner}/${input.repository.name}@${input.commitSha} ${input.archive.kind}`)
			await input.parts.complete({ last: new Uint8Array([1]), parts: 1, bytes: 1 }, input.signal)
		},
	}

	private service(): EcsService {
		return {
			name: 'notes-prod',
			arn: SERVICE_ARN,
			status: 'active',
			taskDefinitionArn: REVISION,
			deployments: [],
			currentDeploymentArn: DEPLOYMENT,
			network: { subnets: ['subnet-0123456789abcdef0'], securityGroups: ['sg-0123456789abcdef0'], publicIp: false },
			events: [],
		}
	}

	readonly clients = (_target: AwsAppTarget): AwsControlClients => ({
		ecr: {
			ensureRepository: async (name) => {
				this.calls.push(`ensureRepository ${name}`)
				return { name, uri: `123456789012.dkr.ecr.eu-central-1.amazonaws.com/${name}`, arn: `arn:aws:ecr:eu-central-1:123456789012:repository/${name}` }
			},
			keepNewestImages: async () => {},
			findImage: async () => ({ digest: `sha256:${'a'.repeat(64)}`, tags: [`run-${TOKEN}`], pushedAt: new Date() }),
		},
		codeBuild: {
			startBuild: async () => {
				this.calls.push('startBuild')
				return { id: BUILD_ID, status: 'in_progress', phase: 'QUEUED', log: null }
			},
			findBuild: async () => null,
			getBuild: async (id) => ({ id, status: 'succeeded', phase: 'COMPLETED', log: null }),
			stopBuild: async (id) => {
				this.calls.push(`stopBuild ${id}`)
				return null
			},
		},
		ecs: {
			registerTaskDefinition: async (definition) => {
				const server = definition.containers[0]
				this.registered.push({ environment: server?.environment ?? {}, secrets: server?.secrets ?? {} })
				return { arn: REVISION, family: definition.family, revision: 42 }
			},
			updateService: async (_address, taskDefinitionArn) => {
				this.calls.push('updateService')
				return { ...this.service(), taskDefinitionArn }
			},
			describeService: async () => this.service(),
			describeServiceDeployment: async (arn) => ({ arn, serviceArn: SERVICE_ARN, status: 'successful', statusReason: null, targetRevisionArn: null }),
			describeServiceRevision: async () => null,
			runTask: async () => {
				throw new Error('no init task without a database')
			},
			describeTask: async () => null,
		},
		logs: { readForward: async () => null },
		ssm: {
			putSecret: async (name, value) => {
				this.calls.push(`putSecret ${name}`)
				this.parameters.set(name, value)
				return 1
			},
			deleteSecret: async (name) => {
				this.calls.push(`deleteSecret ${name}`)
				return this.parameters.delete(name)
			},
			listNames: async (path) => [...this.parameters.keys()].filter((name) => name.startsWith(`${path}/`)).sort(),
		},
		s3PartWriter: () => ({ partBytes: 8 * 1024 * 1024, writePart: async () => {}, complete: async () => {}, abort: async () => {} }),
	})

	provider() {
		return createAwsControlProvider({
			credentials: {
				current: async () => ({
					accessKeyId: 'AKIDEXAMPLE',
					secretAccessKey: 'secret',
					...(this.expiresAt === undefined ? {} : { expiresAt: this.expiresAt }),
				}),
			},
			baseImage: BASE_IMAGE,
			source: this.source,
			clients: this.clients,
			sleep: async () => {},
		})
	}
}

const deployInput = (change: Partial<ProviderDeployInput> = {}): ProviderDeployInput => ({
	runId: 'run-1',
	app: { id: 'notes', source: { repoUrl: 'https://github.com/Example/Notes.git', ref: COMMIT } },
	environment: environmentOf(),
	secrets: { API_TOKEN: 'token-value' },
	vars: { GREETING: 'hello' },
	managedEnvironment: {
		FABRIKA_APP_ID: { value: 'notes', credential: false },
		FABRIKA_IAM_RPC_KEY: { value: 'rpc-key', credential: true },
		FABRIKA_RELEASE: { value: null, credential: false },
	},
	dryRun: false,
	signal: new AbortController().signal,
	events: new Recorder(),
	...change,
})

describe('the AWS control provider', () => {
	test('a deploy writes the secrets, names them by ARN, uploads the commit and deletes a secret no longer handed', async () => {
		const fake = new Fake()
		const outcome = await fake.provider().deploy(deployInput())
		expect(outcome).toEqual({ state: 'succeeded', artifactState: 'not_applicable' })
		expect(fake.calls.filter((call) => call.startsWith('putSecret /fabrika/notes/prod/env/'))).toEqual([
			'putSecret /fabrika/notes/prod/env/API_TOKEN',
			'putSecret /fabrika/notes/prod/env/FABRIKA_IAM_RPC_KEY',
		])
		// Written before the build starts, deleted only after the rollout.
		expect(fake.calls.indexOf('putSecret /fabrika/notes/prod/env/API_TOKEN')).toBeLessThan(fake.calls.indexOf('startBuild'))
		expect(fake.calls.indexOf('deleteSecret /fabrika/notes/prod/env/OLD_SECRET')).toBeGreaterThan(fake.calls.indexOf('updateService'))
		expect([...fake.parameters.keys()].filter((name) => name.includes('/env/'))).toEqual([
			'/fabrika/notes/prod/env/API_TOKEN',
			'/fabrika/notes/prod/env/FABRIKA_IAM_RPC_KEY',
		])
		expect(fake.registered).toEqual([{
			environment: { FABRIKA_APP_ID: 'notes', GREETING: 'hello' },
			secrets: {
				API_TOKEN: 'arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/notes/prod/env/API_TOKEN',
				FABRIKA_IAM_RPC_KEY: 'arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/notes/prod/env/FABRIKA_IAM_RPC_KEY',
			},
		}])
		expect(fake.uploads).toEqual([`example/notes@${COMMIT} application`])
		expect(fake.calls).toContain('ensureRepository fabrika/notes-prod')
	})

	test('a dry run writes no secret and calls nothing', async () => {
		const fake = new Fake()
		expect((await fake.provider().deploy(deployInput({ dryRun: true }))).state).toBe('succeeded')
		expect(fake.calls).toEqual([])
		expect(fake.uploads).toEqual([])
	})

	test('what this version does not deploy is refused before any call', async () => {
		const refusals: readonly { readonly input: ProviderDeployInput; readonly message: string }[] = [
			{ input: deployInput({ environment: environmentOf({ access: undefined }) }), message: 'no approved contract' },
			{
				input: deployInput({ environment: environmentOf({ access: { ...(environmentOf().access ?? fail()), contract: notesArtifact } }) }),
				message: 'database',
			},
			{ input: deployInput({ environment: environmentOf({ kind: 'dev' }) }), message: 'dev environment' },
			{ input: deployInput({ vars: { FABRIKA_APP_ID: 'other' } }), message: 'the platform manages' },
			{ input: deployInput({ vars: { API_TOKEN: 'plain' } }), message: 'both a variable and a secret' },
			{ input: deployInput({ app: { id: 'notes', source: { repoUrl: 'https://github.com/example/notes', ref: 'main' } } }), message: 'exact commit' },
			{ input: deployInput({ app: { id: 'notes', source: { repoUrl: 'https://gitlab.com/example/notes', ref: COMMIT } } }), message: 'GitHub' },
			{
				input: deployInput({
					environment: environmentOf({}, { ...target, taskRoleArn: 'arn:aws-cn:iam::123456789012:role/notes-task' }),
				}),
				message: 'commercial partition',
			},
		]
		for (const { input, message } of refusals) {
			const fake = new Fake()
			await expect(fake.provider().deploy(input)).rejects.toThrow(message)
			expect(fake.calls).toEqual([])
		}
	})

	test('credentials that expire before the source URL fail the run before the build starts', async () => {
		const fake = new Fake()
		fake.expiresAt = Date.now() + 10 * 60 * 1000
		const events = new Recorder()
		expect((await fake.provider().deploy(deployInput({ events }))).state).toBe('failed')
		expect(fake.calls).not.toContain('startBuild')
		expect(events.lines.join('\n')).toContain('expire before the build')
	})

	test('a source resolves through the repository the app names, and a different commit than recorded is refused', async () => {
		const fake = new Fake()
		const provider = fake.provider()
		const input = { runId: 'run-1', app: deployInput().app, environment: environmentOf(), signal: new AbortController().signal }
		expect(await provider.resolveSource?.({ ...input, app: { id: 'notes', source: { repoUrl: 'github.com/example/notes', ref: 'main' } } }))
			.toEqual({ commitSha: COMMIT })
		expect(fake.calls).toEqual(['resolve example/notes main'])
		await expect(provider.resolveSource?.({ ...input, expectedCommitSha: 'd'.repeat(40) })).rejects.toThrow('another commit')
	})

	test('a cancel of an unsubmitted run stops its build through the shared run', async () => {
		const fake = new Fake()
		const providerState: JsonValue = { buildToken: TOKEN, buildId: BUILD_ID }
		const outcome = await fake.provider().cancel?.({
			runId: 'run-1',
			externalId: TOKEN,
			environment: environmentOf(),
			providerState,
			startedAtMs: Date.now(),
			signal: new AbortController().signal,
		})
		expect(outcome).toEqual({ state: 'settled', outcome: 'failed' })
		expect(fake.calls).toContain(`stopBuild ${BUILD_ID}`)
		expect(fake.calls).toContain(`deleteSecret /fabrika/notes/prod/builds/${TOKEN}/source-url`)
	})

	test('the task values split managed credentials from public ones and skip a removed one', () => {
		expect(awsTaskValues(deployInput())).toEqual({
			plain: { GREETING: 'hello', FABRIKA_APP_ID: 'notes' },
			secret: { API_TOKEN: 'token-value', FABRIKA_IAM_RPC_KEY: 'rpc-key' },
		})
	})

	test('a repository URL is read in its one GitHub form', () => {
		expect(awsSourceRepository('https://github.com/Example/Notes.git')).toEqual({ owner: 'example', name: 'notes' })
		for (
			const url of [
				'http://github.com/a/b',
				'https://github.com/a',
				'https://github.com/a/b/c',
				'https://user@github.com/a/b',
				'https://github.com/a/b?x=1',
			]
		) {
			expect(() => awsSourceRepository(url)).toThrow('HTTPS GitHub')
		}
	})
})

function fail(): never {
	throw new Error('the fixture has no access')
}
