// The AWS `ControlProvider` over fakes of its AWS calls and of Control's source: a deploy derives every resource of the
// environment from its application id and environment, writes the secrets as the run's own parameters and names them
// by ARN in the task, uploads the run's commit in parts, prunes the parameters no revision reads, and refuses before
// any call (and before publication) what this version does not deploy. A cancel goes to the shared run.

import { contractDigest } from '@fabrika/auth-core'
import type { JsonValue, ProviderApprovedAccess, ProviderDeployInput, ProviderEnvironment, ProviderRunEvents } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { EcsService } from '../aws/ecs'
import { awsAppArtifactCodec, type AwsAppTarget, awsAppTargetCodec } from '../codecs'
import {
	type AwsControlClients,
	awsEnvironmentResources,
	type AwsSourcePort,
	awsSourceRepository,
	awsTaskValues,
	createAwsControlProvider,
} from '../control'

const COMMIT = 'c'.repeat(40)
const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const BUILD_ID = `fabrika-build:${TOKEN}`
const REVISION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes_prod:42'
const DEPLOYMENT = 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/notes_prod/r2ZTbPmlNM0uqVbg2nTT4'
const SERVICE_ARN = 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/notes_prod'
const BASE_IMAGE = `oven/bun:1.4.4-alpine@sha256:${'b'.repeat(64)}`
/** Control's run ids (UUIDv7): the oldest first; `RUN` is the deploy's own. */
const OLDEST = '01900000-0000-7000-8000-000000000001'
const OLDER = '01900000-0000-7000-8000-000000000002'
const PREVIOUS = '01900000-0000-7000-8000-000000000003'
const RUN = '01900000-0000-7000-8000-000000000009'
const ENV_PATH = '/fabrika/apps/notes/prod/env'

const target: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	sourcesBucket: 'fabrika-sources-123456789012',
	buildProject: 'fabrika-build',
}
/** The notes contract without what this version refuses: a database, jobs, file collections. */
const contract = { ...notesArtifact, tables: {}, jobs: {}, files: {}, fileKinds: {} }
const access: ProviderApprovedAccess = { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract), checker: '0.9.1' }

const environmentOf = (change: Partial<ProviderEnvironment> = {}): ProviderEnvironment => ({
	appId: 'notes',
	env: 'prod',
	target: { provider: 'aws', version: 1, payload: awsAppTargetCodec.encode(target) },
	artifact: { provider: 'aws', version: 1, payload: awsAppArtifactCodec.encode({ contractDigest: contractDigest(contract), healthPath: '/healthz' }) },
	access,
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

/** Fakes of every call, each recorded; the parameters Parameter Store holds, three earlier runs' and one of another form. */
class Fake {
	readonly calls: string[] = []
	readonly parameters = new Map<string, string>([
		[`${ENV_PATH}/${OLDEST}.API_TOKEN`, 'oldest'],
		[`${ENV_PATH}/${OLDER}.API_TOKEN`, 'older'],
		[`${ENV_PATH}/${PREVIOUS}.API_TOKEN`, 'previous'],
		[`${ENV_PATH}/LEGACY`, 'not a run parameter'],
	])
	readonly registered: { family: string; environment: Readonly<Record<string, string>>; secrets: Readonly<Record<string, string>> }[] = []
	readonly uploads: string[] = []
	expiresAt: number | undefined = undefined
	buildStatus: 'succeeded' | 'failed' = 'succeeded'
	rolloutStatus: 'successful' | 'rollback_successful' = 'successful'
	/** A parameter whose write fails, by the secret's name. */
	failPut: string | null = null

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
			name: 'notes_prod',
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
			getBuild: async (id) => ({ id, status: this.buildStatus, phase: 'COMPLETED', log: null }),
			stopBuild: async (id) => {
				this.calls.push(`stopBuild ${id}`)
				return null
			},
		},
		ecs: {
			registerTaskDefinition: async (definition) => {
				const server = definition.containers[0]
				this.registered.push({ family: definition.family, environment: server?.environment ?? {}, secrets: server?.secrets ?? {} })
				return { arn: REVISION, family: definition.family, revision: 42 }
			},
			updateService: async (address, taskDefinitionArn) => {
				this.calls.push(`updateService ${address.cluster}/${address.service}`)
				return { ...this.service(), taskDefinitionArn }
			},
			describeService: async () => this.service(),
			describeServiceDeployment: async (arn) => ({
				arn,
				serviceArn: SERVICE_ARN,
				status: this.rolloutStatus,
				statusReason: null,
				targetRevisionArn: null,
			}),
			describeServiceRevision: async () => null,
			runTask: async () => {
				throw new Error('no init task without a database')
			},
			describeTask: async () => null,
		},
		logs: { readForward: async () => null },
		ssm: {
			putSecret: async (name, value) => {
				if (this.failPut !== null && name.endsWith(`.${this.failPut}`)) throw new Error('the write failed')
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
			installation: target,
			source: this.source,
			clients: this.clients,
			sleep: async () => {},
		})
	}

	envParameters(): string[] {
		return [...this.parameters.keys()].filter((name) => name.startsWith(`${ENV_PATH}/`)).sort()
	}
}

const deployInput = (change: Partial<ProviderDeployInput> = {}): ProviderDeployInput => ({
	runId: RUN,
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
	test("a deploy writes the run's own parameters, names them by ARN, uploads the commit and keeps the rollback's", async () => {
		const fake = new Fake()
		const events = new Recorder()
		const outcome = await fake.provider().deploy(deployInput({ events }))
		expect({ outcome, log: outcome.state === 'succeeded' ? [] : events.lines }).toEqual({
			outcome: { state: 'succeeded', artifactState: 'not_applicable' },
			log: [],
		})
		expect(fake.calls.filter((call) => call.startsWith(`putSecret ${ENV_PATH}/`))).toEqual([
			`putSecret ${ENV_PATH}/${RUN}.API_TOKEN`,
			`putSecret ${ENV_PATH}/${RUN}.FABRIKA_IAM_RPC_KEY`,
		])
		// Written before the build starts; the oldest earlier run's pruned only after the rollout.
		expect(fake.calls.indexOf(`putSecret ${ENV_PATH}/${RUN}.API_TOKEN`)).toBeLessThan(fake.calls.indexOf('startBuild'))
		expect(fake.calls.indexOf(`deleteSecret ${ENV_PATH}/${OLDEST}.API_TOKEN`)).toBeGreaterThan(
			fake.calls.indexOf('updateService fabrika-apps/notes_prod'),
		)
		// This run's, the two newest earlier runs' (a rollback's revision reads them) and a name of another form stay.
		expect(fake.envParameters()).toEqual([
			`${ENV_PATH}/${OLDER}.API_TOKEN`,
			`${ENV_PATH}/${PREVIOUS}.API_TOKEN`,
			`${ENV_PATH}/${RUN}.API_TOKEN`,
			`${ENV_PATH}/${RUN}.FABRIKA_IAM_RPC_KEY`,
			`${ENV_PATH}/LEGACY`,
		])
		expect(fake.registered).toEqual([{
			family: 'notes_prod',
			environment: { FABRIKA_APP_ID: 'notes', GREETING: 'hello' },
			secrets: {
				API_TOKEN: `arn:aws:ssm:eu-central-1:123456789012:parameter${ENV_PATH}/${RUN}.API_TOKEN`,
				FABRIKA_IAM_RPC_KEY: `arn:aws:ssm:eu-central-1:123456789012:parameter${ENV_PATH}/${RUN}.FABRIKA_IAM_RPC_KEY`,
			},
		}])
		expect(fake.uploads).toEqual([`example/notes@${COMMIT} application`])
		expect(fake.calls).toContain('ensureRepository fabrika/apps/notes/prod')
	})

	test('a run that fails before the update deletes its own parameters and leaves every earlier one', async () => {
		const fake = new Fake()
		fake.buildStatus = 'failed'
		expect((await fake.provider().deploy(deployInput())).state).toBe('failed')
		expect(fake.calls).not.toContain('updateService fabrika-apps/notes_prod')
		expect(fake.envParameters()).toEqual([
			`${ENV_PATH}/${OLDEST}.API_TOKEN`,
			`${ENV_PATH}/${OLDER}.API_TOKEN`,
			`${ENV_PATH}/${PREVIOUS}.API_TOKEN`,
			`${ENV_PATH}/LEGACY`,
		])
	})

	test('a run that throws while writing its secrets deletes what it wrote', async () => {
		const fake = new Fake()
		fake.failPut = 'FABRIKA_IAM_RPC_KEY'
		await expect(fake.provider().deploy(deployInput())).rejects.toThrow('the write failed')
		expect(fake.calls).toContain(`deleteSecret ${ENV_PATH}/${RUN}.API_TOKEN`)
		expect(fake.envParameters()).not.toContain(`${ENV_PATH}/${RUN}.API_TOKEN`)
	})

	test('a run that failed after asking for the update keeps its parameters: the update may still land', async () => {
		const fake = new Fake()
		fake.rolloutStatus = 'rollback_successful'
		expect((await fake.provider().deploy(deployInput())).state).toBe('failed')
		expect(fake.calls).toContain('updateService fabrika-apps/notes_prod')
		expect(fake.envParameters()).toContain(`${ENV_PATH}/${RUN}.API_TOKEN`)
		expect(fake.calls.filter((call) => call.startsWith(`deleteSecret ${ENV_PATH}/`))).toEqual([])
	})

	test("the installation's coordinates replace a registrant's, and a stored target that differs is refused", async () => {
		const provider = new Fake().provider()
		const submitted = environmentOf({
			target: { provider: 'aws', version: 1, payload: awsAppTargetCodec.encode({ ...target, accountId: '999999999999', cluster: 'other' }) },
		})
		const normalized = provider.normalizeRegistration?.({ app: deployInput().app, environment: submitted })
		expect(normalized?.environment.target).toEqual(environmentOf().target)
		for (const field of ['accountId', 'region', 'cluster', 'sourcesBucket', 'buildProject']) {
			const other = { ...target, [field]: field === 'accountId' ? '999999999999' : field === 'region' ? 'us-east-1' : 'other-name' }
			const fake = new Fake()
			const stored = environmentOf({ target: { provider: 'aws', version: 1, payload: awsAppTargetCodec.encode(other) } })
			await expect(fake.provider().deploy(deployInput({ environment: stored }))).rejects.toThrow(`another ${field}`)
			expect(fake.calls).toEqual([])
		}
	})

	test('a dry run writes no secret and calls nothing', async () => {
		const fake = new Fake()
		expect((await fake.provider().deploy(deployInput({ dryRun: true }))).state).toBe('succeeded')
		expect(fake.calls).toEqual([])
		expect(fake.uploads).toEqual([])
	})

	test("an environment's resources come from its application id and environment, never from the registration", () => {
		expect(awsEnvironmentResources('notes', 'prod', '123456789012')).toEqual({
			service: 'notes_prod',
			repository: 'fabrika/apps/notes/prod',
			parameterPath: '/fabrika/apps/notes/prod',
			logGroup: '/fabrika/apps/notes/prod',
			taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika/apps/notes_prod_task',
			executionRoleArn: 'arn:aws:iam::123456789012:role/fabrika/apps/notes_prod_execution',
		})
		// A hyphen moved between the id and the name derives other names, because `_` and `/` join them.
		const a = awsEnvironmentResources('a-b', 'c', '123456789012')
		const b = awsEnvironmentResources('a', 'b-c', '123456789012')
		const keys: readonly (keyof typeof a)[] = ['service', 'repository', 'parameterPath', 'logGroup', 'taskRoleArn', 'executionRoleArn']
		for (const key of keys) {
			expect(a[key]).not.toBe(b[key])
		}
		expect(() => awsEnvironmentResources('notes', 'prod_x', '123456789012')).toThrow('not one this provider names')
		expect(() => awsEnvironmentResources('notes/x', 'prod', '123456789012')).toThrow('not one this provider names')
		expect(() => awsEnvironmentResources('n'.repeat(30), 'p'.repeat(30), '123456789012')).toThrow('too long')
	})

	test('what this version does not deploy is refused before any call', async () => {
		const refusals: readonly { readonly input: ProviderDeployInput; readonly message: string }[] = [
			{ input: deployInput({ environment: environmentOf({ access: undefined }) }), message: 'no approved contract' },
			{ input: deployInput({ environment: environmentOf({ access: { ...access, contract: notesArtifact } }) }), message: 'database' },
			{ input: deployInput({ environment: environmentOf({ kind: 'dev' }) }), message: 'dev environment' },
			{ input: deployInput({ environment: environmentOf({ appId: 'other' }) }), message: 'another application' },
			{ input: deployInput({ environment: environmentOf({ env: 'prod_x' }) }), message: 'not one this provider names' },
			{ input: deployInput({ runId: 'run-1' }), message: 'run id' },
			{ input: deployInput({ vars: { FABRIKA_APP_ID: 'other' } }), message: 'the platform manages' },
			{ input: deployInput({ vars: { API_TOKEN: 'plain' } }), message: 'both a variable and a secret' },
			{ input: deployInput({ secrets: { API_TOKEN: '' } }), message: 'empty' },
			{ input: deployInput({ app: { id: 'notes', source: { repoUrl: 'https://github.com/example/notes', ref: 'main' } } }), message: 'exact commit' },
			{ input: deployInput({ app: { id: 'notes', source: { repoUrl: 'https://gitlab.com/example/notes', ref: COMMIT } } }), message: 'GitHub' },
		]
		for (const { input, message } of refusals) {
			const fake = new Fake()
			await expect(fake.provider().deploy(input)).rejects.toThrow(message)
			expect(fake.calls).toEqual([])
		}
	})

	test('a contract this version does not deploy is refused before Control publishes it', () => {
		const provider = new Fake().provider()
		const validate = provider.validateAccess ?? fail
		expect(() => validate({ environment: environmentOf(), access })).not.toThrow()
		expect(() => validate({ environment: environmentOf(), access: { ...access, contract: notesArtifact } })).toThrow('not deployed on AWS yet')
		expect(() => validate({ environment: environmentOf({ env: 'prod_x' }), access })).toThrow('not one this provider names')
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
		const input = { runId: RUN, app: deployInput().app, environment: environmentOf(), signal: new AbortController().signal }
		expect(await provider.resolveSource?.({ ...input, app: { id: 'notes', source: { repoUrl: 'github.com/example/notes', ref: 'main' } } }))
			.toEqual({ commitSha: COMMIT })
		expect(fake.calls).toEqual(['resolve example/notes main'])
		await expect(provider.resolveSource?.({ ...input, expectedCommitSha: 'd'.repeat(40) })).rejects.toThrow('another commit')
	})

	test("a cancel of an unsubmitted run stops its build and deletes its source URL's parameter", async () => {
		const fake = new Fake()
		fake.parameters.set(`${ENV_PATH}/${RUN}.API_TOKEN`, 'left by a crash')
		const providerState: JsonValue = { buildToken: TOKEN, buildId: BUILD_ID }
		const outcome = await fake.provider().cancel?.({
			runId: RUN,
			externalId: TOKEN,
			environment: environmentOf(),
			providerState,
			startedAtMs: Date.now(),
			signal: new AbortController().signal,
		})
		expect(outcome).toEqual({ state: 'settled', outcome: 'failed' })
		expect(fake.calls).toContain(`stopBuild ${BUILD_ID}`)
		expect(fake.calls).toContain(`deleteSecret /fabrika/apps/notes/prod/builds/${TOKEN}/source-url`)
		// The discard also deletes the run's own secret parameters, which a crash left behind.
		expect(fake.calls).toContain(`deleteSecret ${ENV_PATH}/${RUN}.API_TOKEN`)
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
	throw new Error('the provider has no validateAccess')
}
