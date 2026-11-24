// The AWS provider's `ControlProvider` (ADR-0011) over the deploy steps (`deploy.ts`) and the run attempt
// (`run-attempt.ts`): what Control hands a deploy becomes the steps' inputs, and a cancel or a reconcile goes to the
// shared run (`cancelRun`, `reconcileRun`) over the same attempt.
//
// What this first version deploys, and what it refuses before anything is sent:
// - A contract application with no database, no jobs and no files: a contract with table policies, a job or a file
//   collection is refused, because the namespace stack (checklist step 10) that would provide the database, the
//   schedule and the bucket is not built. No source maps either: the deploy reports its artifacts `not_applicable`.
// - The target names only what the installation shares (account, region, cluster, sources bucket, build project).
//   Everything of one environment's own (service, repository, parameter path, log group, task and execution roles) is
//   derived from its application id and environment (`awsEnvironmentResources`), so a registration cannot point a
//   deploy, which Control signs with its own role, at another environment's resources. The deploy creates none of
//   them but the repository.
// - The application's secrets and the managed credentials go to Parameter Store as the run's own parameters
//   (`<parameterPath>/env/<runId>.<NAME>`), written before the steps and read by ECS when a task starts: no write
//   touches a parameter a live revision reads. A run that does not succeed deletes its own; a successful one deletes
//   the parameters of all but the newest `AWS_KEPT_SECRET_RUNS` earlier runs, which a rollback may still need. A dry
//   run writes nothing.
// - No dev environment, no workspace sandbox, no managed secrets capability, no namespaces: Control refuses what a
//   provider does not offer.
//
// UNVERIFIED: that a fresh read of the ECS container credentials endpoint answers a set that outlives the source URL
// (`AWS_SOURCE_URL_SECONDS`); a set that does not fails the run before the build, never with a URL that dies early.

import { containerImage } from '@fabrika/app/build'
import { isManagedCredential, isManagedVariableName } from '@fabrika/auth-core'
import {
	cancelRun,
	type ControlProvider,
	decodeEnvelope,
	type ProviderDeployInput,
	type ProviderDeployOutcome,
	type ProviderEnvironment,
	type ProviderSourceBinding,
	reconcileRun,
} from '@fabrika/provider-contract'
import { codeBuildClient } from './aws/codebuild'
import { ecrClient } from './aws/ecr'
import { ecsClient } from './aws/ecs'
import { CODEBUILD, ECR, ECS, LOGS, SSM } from './aws/json'
import { logsClient } from './aws/logs'
import { s3BucketOrigin, type S3PartWriter, s3PartWriter } from './aws/s3'
import type { SigningCredentials } from './aws/sigv4'
import { parameterArn, type SsmClient, ssmClient } from './aws/ssm'
import { type AwsClientOptions, awsServiceOrigin } from './aws/transport'
import { AWS_PROVIDER, type AwsAppArtifact, awsAppArtifactCodec, type AwsAppTarget, awsAppTargetCodec } from './codecs'
import { awsDeploy, type AwsDeployClients, awsSourceUrlParameter } from './deploy'
import { AWS_SOURCE_URL_SECONDS, awsRunAttempt } from './run-attempt'

/** Fargate CPU units and memory in MiB of every task, until an application's size is authored. */
export const AWS_TASK_CPU = 512
export const AWS_TASK_MEMORY = 1024
/** How many images an environment's repository keeps. */
export const AWS_KEPT_IMAGES = 20
/** Where the build unpacks the source and where the image runs it; the runtime stage's user (the Bun image's `bun`). */
const SOURCE_ROOT = '/src'
const RUNTIME_ROOT = '/app'
const RUNTIME_USER = '1000:1000'
/** An exact commit: what Control hands a deploy once it resolved the ref. */
const IMMUTABLE_GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
/** A GitHub owner or repository name, lowercased. */
const GITHUB_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/
/**
 * An application id or environment name the derived names take: no `_`, `/` or `.`, which the names join them with,
 * so no two environments derive one name.
 */
const NAME_PART = /^[a-z0-9][a-z0-9-]{0,62}$/
/** A run id a parameter name carries: Control's UUIDv7, whose text order is its time order. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** An IAM role's name holds at most 64 characters. */
const MAX_ROLE_NAME = 64
/** How many earlier runs' secret parameters a successful run keeps: the revisions a rollback may return to. */
export const AWS_KEPT_SECRET_RUNS = 2

/** One application environment's own AWS resources, each named from its application id and environment alone. */
export interface AwsEnvironmentResources {
	readonly service: string
	readonly repository: string
	readonly parameterPath: string
	readonly logGroup: string
	readonly taskRoleArn: string
	readonly executionRoleArn: string
}

/**
 * The names of an environment's resources, under the prefixes the installation's policy for Control's role is scoped
 * to (`fabrika/apps/`): an ECS service `<app>_<env>`, a repository `fabrika/apps/<app>/<env>`, the parameter path and
 * log group `/fabrika/apps/<app>/<env>`, the roles `fabrika/apps/<app>_<env>_task` and `…_execution` (ADR-0004's AWS
 * invariant: two roles, never one). An id or name outside `NAME_PART`, or a role name past IAM's 64, is refused.
 */
export function awsEnvironmentResources(appId: string, env: string, accountId: string): AwsEnvironmentResources {
	if (!NAME_PART.test(appId) || !NAME_PART.test(env)) {
		throw new Error('aws: the application id or environment name is not one this provider names resources by')
	}
	const role = `${appId}_${env}`
	if (`${role}_execution`.length > MAX_ROLE_NAME) throw new Error('aws: the application id and environment name are too long for an IAM role name')
	return {
		service: role,
		repository: `fabrika/apps/${appId}/${env}`,
		parameterPath: `/fabrika/apps/${appId}/${env}`,
		logGroup: `/fabrika/apps/${appId}/${env}`,
		taskRoleArn: `arn:aws:iam::${accountId}:role/fabrika/apps/${role}_task`,
		executionRoleArn: `arn:aws:iam::${accountId}:role/fabrika/apps/${role}_execution`,
	}
}

/** Credentials as platform-node's `CredentialProvider` answers them: a temporary set says when it expires. */
export interface AwsExpiringCredentialSource {
	current(): Promise<SigningCredentials & { readonly expiresAt?: number }>
}

export interface AwsSourceRepository {
	readonly owner: string
	readonly name: string
}

/**
 * The repository source Control's composition hands the provider: its unbound GitHub source (`createUnboundGitHubSource`),
 * structurally, which renders no descriptor because the build comes from the contract alone.
 */
export interface AwsSourcePort {
	resolve(input: {
		readonly repository: AwsSourceRepository
		readonly requestedRef: string
		readonly expectedCommitSha?: string
		readonly privateBinding?: ProviderSourceBinding
		readonly signal: AbortSignal
	}): Promise<{ readonly commitSha: string }>
	upload(input: {
		readonly repository: AwsSourceRepository
		readonly commitSha: string
		readonly archive: { readonly kind: 'application'; readonly privateBinding?: ProviderSourceBinding }
		readonly parts: S3PartWriter
		readonly signal: AbortSignal
	}): Promise<unknown>
}

/** The calls of one target: the deploy's, and the listing that deletes a secret no longer handed. */
export type AwsControlClients = Omit<AwsDeployClients, 'credentials' | 'ssm'> & {
	readonly ssm: Pick<SsmClient, 'putSecret' | 'deleteSecret' | 'listNames'>
}

export interface AwsControlProviderOptions {
	/** What every call is signed with: Control's task role. */
	readonly credentials: AwsExpiringCredentialSource
	/**
	 * A fresh set for the build's presigned read, which must outlive the URL. Absent, `credentials` again; the
	 * composition reads the container endpoint anew, since a held set is refreshed only shortly before it expires.
	 */
	readonly presignCredentials?: () => AwsExpiringCredentialSource
	/** The Bun image both build stages start from, pinned by digest (`containerImage` refuses any other). */
	readonly baseImage: string
	readonly source: AwsSourcePort
	readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
	/** The clients of a target's region; absent, the package's own over `fetch`. Tests pass fakes. */
	readonly clients?: (target: AwsAppTarget) => AwsControlClients
	readonly now?: () => number
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** `https://github.com/<owner>/<name>[.git]` as the source names it, lowercased; any other form is refused. */
export function awsSourceRepository(repoUrl: string): AwsSourceRepository {
	let url: URL
	try {
		url = new URL(repoUrl.startsWith('github.com/') ? `https://${repoUrl}` : repoUrl)
	} catch {
		throw new Error('aws: the source repository must be an HTTPS GitHub repository URL')
	}
	const segments = url.pathname.split('/')
	const owner = (segments[1] ?? '').toLowerCase()
	const raw = (segments[2] ?? '').toLowerCase()
	const name = raw.endsWith('.git') ? raw.slice(0, -4) : raw
	if (
		url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== '' || url.username !== '' || url.password !== ''
		|| url.search !== '' || url.hash !== '' || segments.length !== 3 || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(name)
	) {
		throw new Error('aws: the source repository must be an HTTPS GitHub repository URL')
	}
	return { owner, name }
}

/** The private binding the source reads a repository with, as the source takes it. */
const bindingOf = (binding: ProviderSourceBinding | undefined): { readonly privateBinding?: ProviderSourceBinding } =>
	binding === undefined ? {} : { privateBinding: { connectionId: binding.connectionId, installationId: binding.installationId } }

/** The directory of an environment's secret parameters, one level deep, so `listNames` reads every run's. */
const secretsPath = (resources: AwsEnvironmentResources): string => `${resources.parameterPath}/env`

/**
 * The parameter one run stores a secret or managed credential under: its own, so writing it changes nothing a live
 * revision reads.
 */
export function awsSecretParameter(resources: AwsEnvironmentResources, runId: string, name: string): string {
	if (!RUN_ID.test(runId)) throw new Error('aws: the run id is not one a parameter name carries')
	return `${secretsPath(resources)}/${runId}.${name}`
}

/** The run a secret parameter belongs to, or null for a name of another form. */
function runOfParameter(resources: AwsEnvironmentResources, name: string): string | null {
	const prefix = `${secretsPath(resources)}/`
	if (!name.startsWith(prefix)) return null
	const runId = name.slice(prefix.length).split('.')[0] ?? ''
	return RUN_ID.test(runId) ? runId : null
}

/** A contract feature this version does not deploy: refused before publication (`validateAccess`) and before any call. */
function refuseUnsupported(access: ProviderEnvironment['access']): NonNullable<ProviderEnvironment['access']> {
	if (access === undefined) throw new Error('aws: the environment has no approved contract to deploy')
	const { contract } = access
	if (Object.keys(contract.tables).length > 0) throw new Error('aws: a contract with a database is not deployed on AWS yet')
	if (Object.keys(contract.jobs).length > 0) throw new Error('aws: a contract with jobs is not deployed on AWS yet')
	if (Object.keys(contract.files).length > 0 || Object.keys(contract.fileKinds ?? {}).length > 0) {
		throw new Error('aws: a contract with file collections is not deployed on AWS yet')
	}
	return access
}

/**
 * The task's plain values and the values it reads as secrets. Plain: the managed variables that carry no credential
 * and the application's own variables. Secret: the managed credentials (failing closed, `isManagedCredential`) and the
 * application's secrets. An authored name that Control manages, or one both a variable and a secret, is refused.
 */
export function awsTaskValues(input: Pick<ProviderDeployInput, 'vars' | 'secrets' | 'managedEnvironment'>): {
	readonly plain: Readonly<Record<string, string>>
	readonly secret: Readonly<Record<string, string>>
} {
	const plain: Record<string, string> = {}
	const secret: Record<string, string> = {}
	for (const name of [...Object.keys(input.vars), ...Object.keys(input.secrets)]) {
		if (isManagedVariableName(name)) throw new Error(`aws: \`${name}\` is a variable the platform manages; rename the application's own`)
	}
	for (const [name, value] of Object.entries(input.vars)) plain[name] = value
	for (const [name, value] of Object.entries(input.secrets)) {
		if (name in plain) throw new Error(`aws: \`${name}\` is both a variable and a secret`)
		secret[name] = value
	}
	for (const [name, entry] of Object.entries(input.managedEnvironment)) {
		if (entry.value === null) continue
		if (entry.credential || isManagedCredential(name)) secret[name] = entry.value
		else plain[name] = entry.value
	}
	return { plain, secret }
}

/** Waits `ms`, or rejects once `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		const stop = (): void => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop)
			resolve()
		}, ms)
		signal.addEventListener('abort', stop, { once: true })
	})
}

/** The AWS provider over Control's source, signing with the composition's credentials. */
export function createAwsControlProvider(options: AwsControlProviderOptions): ControlProvider {
	const now = options.now ?? Date.now
	const clientOptions = (origin: string, region: string, credentials: AwsExpiringCredentialSource = options.credentials): AwsClientOptions => ({
		origin,
		region,
		credentials,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	})
	const clientsOf = options.clients ?? ((target: AwsAppTarget): AwsControlClients => {
		const at = (service: { readonly service: string }) => clientOptions(awsServiceOrigin(service, target.region), target.region)
		return {
			ecr: ecrClient(at(ECR)),
			codeBuild: codeBuildClient(at(CODEBUILD)),
			ecs: ecsClient(at(ECS)),
			logs: logsClient(at(LOGS)),
			ssm: ssmClient(at(SSM)),
			s3PartWriter: (address) => s3PartWriter(clientOptions(s3BucketOrigin(target.sourcesBucket, target.region), target.region), address),
		}
	})
	const targetOf = (environment: ProviderEnvironment): AwsAppTarget => decodeEnvelope('target', AWS_PROVIDER, environment.target, awsAppTargetCodec)
	const artifactOf = (environment: ProviderEnvironment): AwsAppArtifact =>
		decodeEnvelope('artifact', AWS_PROVIDER, environment.artifact, awsAppArtifactCodec)
	const resourcesOf = (environment: ProviderEnvironment, target: AwsAppTarget): AwsEnvironmentResources =>
		awsEnvironmentResources(environment.appId, environment.env, target.accountId)
	const urlParameterPath = (resources: AwsEnvironmentResources): string => `${resources.parameterPath}/builds`
	const attemptOf = (environment: ProviderEnvironment) => {
		const target = targetOf(environment)
		const resources = resourcesOf(environment, target)
		const clients = clientsOf(target)
		return awsRunAttempt({
			codeBuild: clients.codeBuild,
			ecs: clients.ecs,
			buildProject: target.buildProject,
			service: { cluster: target.cluster, service: resources.service },
			sourceUrl: { ssm: clients.ssm, parameter: (token) => awsSourceUrlParameter(urlParameterPath(resources), token) },
		})
	}

	/**
	 * Deletes secret parameters no live revision may read, best effort: after a success, those of every run but this one,
	 * any later one and the newest `AWS_KEPT_SECRET_RUNS` earlier ones; after a run that never asked for the update, its
	 * own. A name left behind is read by no task, and the next successful deploy tries again.
	 */
	const pruneSecrets = async (
		clients: AwsControlClients,
		resources: AwsEnvironmentResources,
		runId: string,
		succeeded: boolean,
		input: ProviderDeployInput,
	) => {
		try {
			const names = await clients.ssm.listNames(secretsPath(resources), input.signal)
			const earlier = [...new Set(names.map((name) => runOfParameter(resources, name)).filter((run) => run !== null && run < runId))].sort().reverse()
			const kept = new Set(earlier.slice(0, AWS_KEPT_SECRET_RUNS))
			for (const name of names) {
				const run = runOfParameter(resources, name)
				if (run === null) continue
				const drop = succeeded ? run < runId && !kept.has(run) : run === runId
				if (drop) await clients.ssm.deleteSecret(name, input.signal)
			}
		} catch {
			input.events.log('warning: aws: some secret parameters no revision reads could not be deleted; the next deploy tries again')
		}
	}

	/** A set for the presigned read that outlives the URL, or the run fails here, before the build. */
	const lastingCredentials = (): AwsExpiringCredentialSource => {
		const source = options.presignCredentials?.() ?? options.credentials
		return {
			current: async () => {
				const credentials = await source.current()
				if (credentials.expiresAt !== undefined && credentials.expiresAt - now() < AWS_SOURCE_URL_SECONDS * 1000) {
					throw new Error("aws: Control's credentials expire before the build's source URL would; deploy again once they are refreshed")
				}
				return credentials
			},
		}
	}

	return {
		id: AWS_PROVIDER,
		// Before Control publishes the snapshot: a contract this version cannot deploy never becomes the approved one.
		validateAccess: ({ environment, access }) => {
			refuseUnsupported(access)
			resourcesOf(environment, targetOf(environment))
		},
		resolveSource: async (input) => {
			input.signal.throwIfAborted()
			targetOf(input.environment)
			const result = await options.source.resolve({
				repository: awsSourceRepository(input.app.source.repoUrl),
				requestedRef: input.app.source.ref,
				...(input.expectedCommitSha === undefined ? {} : { expectedCommitSha: input.expectedCommitSha }),
				...bindingOf(input.sourceBinding),
				signal: input.signal,
			})
			if (input.expectedCommitSha !== undefined && result.commitSha !== input.expectedCommitSha) {
				throw new Error('aws: the source resolved another commit than the run recorded')
			}
			return { commitSha: result.commitSha }
		},
		deploy: async (input: ProviderDeployInput): Promise<ProviderDeployOutcome> => {
			input.signal.throwIfAborted()
			if (input.environment.kind === 'dev' || input.devSandbox !== undefined) throw new Error('aws: a dev environment is not deployed on AWS yet')
			if (input.backupBeforeMigrations !== undefined) throw new Error('aws: a contract with a database is not deployed on AWS yet')
			if (input.app.id !== input.environment.appId) throw new Error('aws: the environment belongs to another application')
			const target = targetOf(input.environment)
			const resources = resourcesOf(input.environment, target)
			const artifact = artifactOf(input.environment)
			const access = refuseUnsupported(input.environment.access)
			if (!RUN_ID.test(input.runId)) throw new Error('aws: the run id is not one a parameter name carries')
			const values = awsTaskValues(input)
			const repository = awsSourceRepository(input.app.source.repoUrl)
			if (!input.dryRun && !IMMUTABLE_GIT_OBJECT.test(input.app.source.ref)) throw new Error('aws: a deploy takes an exact commit')
			const image = containerImage({
				recipe: {
					appId: input.app.id,
					checkRelease: access.checker,
					sourceRoot: SOURCE_ROOT,
					runtimeRoot: RUNTIME_ROOT,
					database: false,
					sourceMaps: false,
					jobs: [],
					files: false,
					scan: false,
				},
				baseImage: options.baseImage,
				spaCommands: [],
				runtimePackages: [],
				runtimeFiles: [],
				sourceMapUpload: null,
				runtimeUser: RUNTIME_USER,
			})
			const clients = clientsOf(target)
			const location = { partition: 'aws', region: target.region, accountId: target.accountId }
			const secretNames = Object.keys(values.secret).sort()
			const secrets: Record<string, string> = {}
			for (const name of secretNames) {
				if (values.secret[name] === '') throw new Error(`aws: the secret \`${name}\` is empty; Parameter Store holds no empty value`)
				secrets[name] = parameterArn(location, awsSecretParameter(resources, input.runId, name))
			}
			if (!input.dryRun) {
				for (const name of secretNames) {
					await clients.ssm.putSecret(awsSecretParameter(resources, input.runId, name), values.secret[name] ?? '', input.signal)
				}
			}
			const tags = { 'fabrika:app': input.app.id, 'fabrika:env': input.environment.env }
			const deployClients: AwsDeployClients = { ...clients, credentials: lastingCredentials() }
			const commitSha = input.app.source.ref
			const result = await awsDeploy({
				appId: input.app.id,
				env: input.environment.env,
				target: { accountId: target.accountId, region: target.region, cluster: target.cluster, service: resources.service },
				sourcesBucket: target.sourcesBucket,
				build: {
					project: target.buildProject,
					repositoryName: resources.repository,
					repositoryUri: `${target.accountId}.dkr.ecr.${target.region}.amazonaws.com/${resources.repository}`,
					repositoryTags: tags,
					keepImages: AWS_KEPT_IMAGES,
					urlParameterPath: urlParameterPath(resources),
				},
				image,
				sourceMapKeyParameter: null,
				task: {
					family: resources.service,
					healthPath: artifact.healthPath,
					environment: values.plain,
					secrets,
					// Without a database the recipe has no init command, and an init definition with no command takes no secret.
					initSecrets: {},
					taskRoleArn: resources.taskRoleArn,
					executionRoleArn: resources.executionRoleArn,
					cpu: AWS_TASK_CPU,
					memory: AWS_TASK_MEMORY,
					log: { group: resources.logGroup, region: target.region },
					tags,
				},
				clients: deployClients,
				source: {
					upload: async (parts, signal) => {
						await options.source.upload({ repository, commitSha, archive: { kind: 'application', ...bindingOf(input.sourceBinding) }, parts, signal })
					},
				},
				events: input.events,
				signal: input.signal,
				dryRun: input.dryRun,
				// Control's deploy input carries no start time; the invocation that starts a run calls `deploy` at once, and
				// an interrupted one is reconciled with the run's own `startedAtMs`, so its deadline only shrinks.
				startedAtMs: now(),
				sleep: options.sleep ?? pause,
			})
			input.signal.throwIfAborted()
			// A failed run whose update was asked for keeps its parameters: the update may still land, and its tasks read them.
			const submitted = result.checkpoint?.serviceUpdateRequested === true
			if (!input.dryRun && (result.status === 'succeeded' || !submitted)) {
				await pruneSecrets(clients, resources, input.runId, result.status === 'succeeded', input)
			}
			return { state: result.status, artifactState: 'not_applicable' }
		},
		cancel: async (input) => {
			input.signal.throwIfAborted()
			return cancelRun(attemptOf(input.environment), input)
		},
		reconcile: async (input) => {
			input.signal.throwIfAborted()
			return reconcileRun(attemptOf(input.environment), input)
		},
	}
}
