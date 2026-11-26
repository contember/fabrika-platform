// The AWS provider's `ControlProvider` (ADR-0011) over the deploy steps (`deploy.ts`) and the run attempt
// (`run-attempt.ts`): what Control hands a deploy becomes the steps' inputs, and a cancel or a reconcile goes to the
// shared run (`cancelRun`, `reconcileRun`) over the same attempt.
//
// What this first version deploys, and what it refuses before anything is sent:
// - A contract application with no database, no jobs and no files: a contract with table policies, a job or a file
//   collection is refused, because the namespace stack (checklist step 10) that would provide the database, the
//   schedule and the bucket is not built. No source maps either: the deploy reports its artifacts `not_applicable`.
// - The target holds only what the installation shares (account, region, cluster, sources bucket), and
//   those come from Control's composition (`installation`), never from a registrant: `normalizeRegistration` replaces a
//   submitted target with them, and a stored one that differs is refused. Everything of one environment's own
//   (service, repository, parameter path, log groups, task, execution and build roles, build project, stack) is
//   derived from its application id and environment (`awsEnvironmentResources`), so a registration cannot point a
//   deploy, which Control signs with its own role, at another environment's resources. The environment's stack
//   (`awsEnvironmentStack`) declares them; the deploy still ensures the repository until the stack is applied.
// - The application's secrets and the managed credentials go to Parameter Store as the run's own parameters
//   (`<parameterPath>/env/<runId>.<NAME>`), written before the steps and read by ECS when a task starts: no write
//   touches a parameter a live revision reads. A run that does not succeed deletes its own; a successful one deletes
//   the parameters of all but the newest `AWS_KEPT_SECRET_RUNS` earlier runs, which a rollback may still need. A dry
//   run writes nothing.
// - Every environment is placed in a namespace (`namespace.ts`): a deploy reads its namespace's stack and admits its
//   proxy's group into the environment's own.
// - No dev environment, no workspace sandbox, no managed secrets capability: Control refuses what a provider does not
//   offer.
//
// UNVERIFIED: that a fresh read of the ECS container credentials endpoint answers a set that outlives the source URL
// (`AWS_SOURCE_URL_SECONDS`); a set that does not fails the run before the build, never with a URL that dies early.

import { containerImage } from '@fabrika/app/build'
import { isManagedCredential, isManagedVariableName } from '@fabrika/auth-core'
import {
	cancelRun,
	type ControlProvider,
	decodeEnvelope,
	type JsonValue,
	type ProviderDeployInput,
	type ProviderDeployOutcome,
	type ProviderEnvironment,
	type ProviderRunEvents,
	type ProviderSourceBinding,
	reconcileRun,
} from '@fabrika/provider-contract'
import { ACM, type AcmClient, acmClient } from './aws/acm'
import { type CloudFormationClient, cloudFormationClient } from './aws/cloudformation'
import { codeBuildClient } from './aws/codebuild'
import { ecrClient } from './aws/ecr'
import { ecsClient } from './aws/ecs'
import { ELB, type ElbClient, elbClient } from './aws/elb'
import { CODEBUILD, ECR, ECS, LOGS, SSM } from './aws/json'
import { LAMBDA, lambdaFunction } from './aws/lambda'
import { logsClient } from './aws/logs'
import { CLOUDFORMATION } from './aws/query'
import { s3BucketOrigin, type S3PartWriter, s3PartWriter } from './aws/s3'
import type { SigningCredentials } from './aws/sigv4'
import { parameterArn, type SsmClient, ssmClient } from './aws/ssm'
import { type AwsClientOptions, awsServiceOrigin } from './aws/transport'
import { AWS_PROVIDER, type AwsAppArtifact, awsAppArtifactCodec, type AwsAppTarget, awsAppTargetCodec } from './codecs'
import { awsDeploy, type AwsDeployClients, awsSourceUrlParameter } from './deploy'
import { AWS_APPLICATION_PORT } from './ecs-task'
import { awsEnvironmentStack, type AwsInstallationNetwork, checkInstallationNetwork, ensureEnvironmentStack } from './environment-stack'
import { AWS_TASK_RUNNER } from './installation/task-runner'
import {
	type AwsInstallationBalancer,
	awsNamespaceCapabilities,
	type AwsProxySource,
	checkInstallationBalancer,
	checkNamespaceTarget,
	readNamespaceOutputs,
} from './namespace'
import { withAwsProxyRepublish } from './proxy-republish'
import type { AwsProxyIam } from './proxy-service'
import { AWS_KEPT_IMAGES, type AwsEnvironmentResources, awsEnvironmentResources } from './resources'
import { AWS_SOURCE_URL_SECONDS, awsRunAttempt, parseAwsCheckpoint } from './run-attempt'

/** Fargate CPU units and memory in MiB of every task, until an application's size is authored. */
export const AWS_TASK_CPU = 512
export const AWS_TASK_MEMORY = 1024
/** Where the build unpacks the source and where the image runs it; the runtime stage's user (the Bun image's `bun`). */
const SOURCE_ROOT = '/src'
const RUNTIME_ROOT = '/app'
const RUNTIME_USER = '1000:1000'
/** An exact commit: what Control hands a deploy once it resolved the ref. */
const IMMUTABLE_GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
/** A GitHub owner or repository name, lowercased. */
const GITHUB_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/
/** A run id a parameter name carries: Control's UUIDv7, whose text order is its time order. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** How many earlier runs' secret parameters a successful run keeps: the revisions a rollback may return to. */
export const AWS_KEPT_SECRET_RUNS = 2

export { AWS_KEPT_IMAGES, type AwsEnvironmentResources, awsEnvironmentResources } from './resources'

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
		/**
		 * An application's commit; or a namespace proxy's, a public platform commit with one data file appended (the
		 * manifest, ADR-0045), whose sha256 the answer names.
		 */
		readonly archive:
			| { readonly kind: 'application'; readonly privateBinding?: ProviderSourceBinding }
			| { readonly kind: 'platform'; readonly dataFile: { readonly path: string; readonly contents: string } }
		readonly parts: S3PartWriter
		readonly signal: AbortSignal
	}): Promise<{ readonly commitSha: string; readonly dataFileSha256?: string }>
}

/** The calls of one target: the deploy's, and the listing that deletes a secret no longer handed. */
export type AwsControlClients = Omit<AwsDeployClients, 'credentials' | 'ssm'> & {
	readonly ssm: Pick<SsmClient, 'putSecret' | 'deleteSecret' | 'listNames'>
	/** The stacks' calls: an environment's (`ensureEnvironmentStack`) and a namespace's (`namespace.ts`). */
	readonly cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack' | 'getTemplate' | 'createStack' | 'updateStack'>
	/** A namespace proxy's certificates (`proxy-certificates.ts`). */
	readonly acm: Pick<AcmClient, 'requestCertificate' | 'describeCertificate'>
	/** The installation listener's rules, which a namespace host's rule priority is chosen against (`host-rules.ts`). */
	readonly elb: Pick<ElbClient, 'describeRules'>
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
	/**
	 * The installation's account, region, cluster and sources bucket: Control's own configuration, which
	 * every environment's target is (a registration's is replaced by it, a stored one that differs is refused).
	 */
	readonly installation: AwsAppTarget
	/**
	 * The installation's VPC, the subnets every environment's tasks run in and whether they get a public address:
	 * Control's own configuration too, read by every deploy and stored by no environment.
	 */
	readonly network: AwsInstallationNetwork
	/**
	 * The installation's balancer: its security group, which each namespace proxy admits, and the VPC's range, which a
	 * proxy's egress to its applications is scoped to. Control's configuration, from the installation's stack.
	 */
	readonly balancer: AwsInstallationBalancer
	/**
	 * The installation's proxy source: its public platform repository and the commit of its release. A namespace being
	 * planned is pinned to it, and no namespace's pin may name another repository (ADR-0045).
	 */
	readonly proxySource: AwsProxySource
	/**
	 * The IAM every namespace proxy asks: its issuer's origin, a plain value of the proxy's task definition, and the key
	 * IAM knows as the proxies', a credential that reaches Parameter Store alone (`ensureAwsProxyService`).
	 */
	readonly proxyIam: AwsProxyIam
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

/** A full git commit. */
const COMMIT_SHA = /^[0-9a-f]{40}$/

/** The installation's proxy source as Control's configuration names it; a repository or commit of another form is refused. */
export function checkProxySource(source: AwsProxySource): AwsProxySource {
	if (!GITHUB_NAME.test(source.repository.owner) || !GITHUB_NAME.test(source.repository.name)) {
		throw new Error("aws: the installation's proxy repository is not a GitHub repository this provider names")
	}
	if (!COMMIT_SHA.test(source.commitSha)) throw new Error("aws: the installation's proxy commit is not a full commit")
	return { repository: { owner: source.repository.owner, name: source.repository.name }, commitSha: source.commitSha }
}

/** The hosts a plain-http IAM issuer may name: the machine itself. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The proxies' IAM as Control's configuration names it: an absolute https URL (or plain http to a loopback host; the
 * proxy reads its origin) and a key. A malformed one fails the composition, naming the field only, never the key.
 */
export function checkProxyIam(iam: AwsProxyIam): AwsProxyIam {
	let issuer: URL
	try {
		issuer = new URL(iam.issuer)
	} catch {
		throw new Error("aws: the proxies' IAM issuer is not an absolute URL")
	}
	if ((issuer.protocol !== 'https:' && issuer.protocol !== 'http:') || issuer.username !== '' || issuer.password !== '') {
		throw new Error("aws: the proxies' IAM issuer is not an http(s) URL without credentials")
	}
	// The proxies send their IAM key to the issuer across the network: plain http only to a loopback host (a local stack).
	if (issuer.protocol === 'http:' && !LOOPBACK_HOSTS.has(issuer.hostname)) {
		throw new Error("aws: the proxies' IAM issuer is plain http to a host that is not loopback; the key would travel unencrypted")
	}
	if (iam.key.trim() === '') throw new Error("aws: the proxies' IAM key is empty")
	return { issuer: issuer.origin, key: iam.key }
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
			// A one-off task goes through the task runner: Control's role is denied `RunTask`.
			ecs: ecsClient(at(ECS), lambdaFunction(at(LAMBDA), AWS_TASK_RUNNER)),
			logs: logsClient(at(LOGS)),
			ssm: ssmClient(at(SSM)),
			cloudFormation: cloudFormationClient(at(CLOUDFORMATION)),
			acm: acmClient(at(ACM)),
			elb: elbClient(at(ELB)),
			s3PartWriter: (address) => s3PartWriter(clientOptions(s3BucketOrigin(target.sourcesBucket, target.region), target.region), address),
		}
	})
	// The installation's coordinates are Control's own (its composition), never a registrant's: a registration's target is
	// replaced by them (`normalizeRegistration`), and a stored one that differs is refused before any call.
	// `encode` checks every field's form, so a composition with a malformed value fails at start.
	const installationPayload = awsAppTargetCodec.encode(options.installation)
	const installation = awsAppTargetCodec.decode(installationPayload)
	const installationTarget = { provider: AWS_PROVIDER, version: awsAppTargetCodec.version, payload: installationPayload }
	const network = checkInstallationNetwork(options.network)
	const balancer = checkInstallationBalancer(options.balancer)
	const proxySource = checkProxySource(options.proxySource)
	const proxyIam = checkProxyIam(options.proxyIam)
	const targetOf = (environment: ProviderEnvironment): AwsAppTarget => {
		const stored = decodeEnvelope('target', AWS_PROVIDER, environment.target, awsAppTargetCodec)
		const differs = AWS_TARGET_FIELDS.filter((field) => stored[field] !== installation[field])
		if (differs.length > 0) {
			throw new Error(`aws: the environment's target names another ${differs.join(', ')} than this installation's; register the environment again`)
		}
		return installation
	}
	const artifactOf = (environment: ProviderEnvironment): AwsAppArtifact =>
		decodeEnvelope('artifact', AWS_PROVIDER, environment.artifact, awsAppArtifactCodec)
	const resourcesOf = (environment: ProviderEnvironment, target: AwsAppTarget): AwsEnvironmentResources =>
		awsEnvironmentResources(environment.appId, environment.env, target.accountId)
	const urlParameterPath = (resources: AwsEnvironmentResources): string => `${resources.parameterPath}/builds`
	/**
	 * Deletes secret parameters no live revision may read, best effort, within its own bound (a cancelled run's signal has
	 * already aborted): after a success, those of every run but this one, any later one and the newest
	 * `AWS_KEPT_SECRET_RUNS` earlier ones; for a run that never asked for the update, its own. A name left behind is read
	 * by no task, and the next successful deploy tries again.
	 */
	const pruneSecrets = async (
		clients: Pick<AwsControlClients, 'ssm'>,
		resources: AwsEnvironmentResources,
		runId: string,
		mode: 'after_success' | 'own',
		log: (line: string) => void,
	): Promise<void> => {
		const signal = AbortSignal.timeout(PRUNE_TIMEOUT_MS)
		try {
			const names = await clients.ssm.listNames(secretsPath(resources), signal)
			const earlier = [...new Set(names.map((name) => runOfParameter(resources, name)).filter((run) => run !== null && run < runId))].sort().reverse()
			const kept = new Set(earlier.slice(0, AWS_KEPT_SECRET_RUNS))
			for (const name of names) {
				const run = runOfParameter(resources, name)
				if (run === null) continue
				const drop = mode === 'after_success' ? run < runId && !kept.has(run) : run === runId
				if (drop) await clients.ssm.deleteSecret(name, signal)
			}
		} catch {
			log('warning: aws: some secret parameters no revision reads could not be deleted; the next deploy tries again')
		}
	}

	const attemptOf = (environment: ProviderEnvironment, runId: string, log: (line: string) => void) => {
		const target = targetOf(environment)
		const resources = resourcesOf(environment, target)
		const clients = clientsOf(target)
		const attempt = awsRunAttempt({
			codeBuild: clients.codeBuild,
			ecs: clients.ecs,
			buildProject: resources.buildProject,
			service: { cluster: target.cluster, service: resources.service },
			sourceUrl: { ssm: clients.ssm, parameter: (token) => awsSourceUrlParameter(urlParameterPath(resources), token) },
		})
		// A discarded run never asked for the update, so no revision reads its secret parameters either.
		const discard: typeof attempt.discard = async (checkpoint, signal) => {
			await attempt.discard(checkpoint, signal)
			if (RUN_ID.test(runId)) await pruneSecrets(clients, resources, runId, 'own', log)
		}
		return { ...attempt, discard }
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
		// Every environment is placed in a namespace: its stack holds the proxy's group, which alone reaches an application.
		namespaces: withAwsProxyRepublish(
			awsNamespaceCapabilities({ installation, network, balancer, proxySource, clients: clientsOf(installation), sleep: options.sleep ?? pause }),
			{
				installation,
				proxySource,
				network,
				balancer,
				runtime: {
					iam: proxyIam,
					clients: clientsOf(installation),
					// A fresh read for each attempt: the build's presigned read must outlive its URL.
					credentials: lastingCredentials,
					// The pinned platform commit with the manifest appended (ADR-0045); public, so no binding.
					source: {
						upload: (upload) =>
							options.source.upload({
								repository: upload.repository,
								commitSha: upload.commitSha,
								archive: { kind: 'platform', dataFile: upload.dataFile },
								parts: upload.parts,
								signal: upload.signal,
							}),
					},
					sleep: options.sleep ?? pause,
				},
			},
		),
		// The target a registrant submits is replaced by the installation's; nothing in it is theirs to choose.
		normalizeRegistration: ({ app, environment }) => {
			if (app.id !== environment.appId) throw new Error('aws: the environment belongs to another application')
			awsEnvironmentResources(environment.appId, environment.env, installation.accountId)
			return { app, environment: { ...environment, target: installationTarget } }
		},
		// Before Control publishes the snapshot: a contract this version cannot deploy never becomes the approved one.
		validateAccess: ({ environment, access }) => {
			refuseUnsupported(access)
			resourcesOf(environment, targetOf(environment))
			// A placement of another installation never becomes the approved one either.
			if (environment.namespace !== undefined) checkNamespaceTarget(environment.namespace, installation, proxySource)
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
			// Every environment is placed in a namespace (Control requires one of a provider with namespaces), whose proxy is
			// the only way to its application.
			const namespace = input.environment.namespace
			if (namespace === undefined) throw new Error('aws: the environment is placed in no namespace')
			checkNamespaceTarget(namespace, installation, proxySource)
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
			const tags = { 'fabrika:app': input.app.id, 'fabrika:env': input.environment.env }
			const deployClients: AwsDeployClients = { ...clients, credentials: lastingCredentials() }
			const commitSha = input.app.source.ref
			const deployRun = (
				events: ProviderRunEvents | undefined,
				placement: { readonly securityGroupId: string; readonly serviceConnectNamespaceArn: string } | null,
			) =>
				awsDeploy({
					appId: input.app.id,
					env: input.environment.env,
					target: { accountId: target.accountId, region: target.region, cluster: target.cluster, service: resources.service },
					sourcesBucket: target.sourcesBucket,
					build: {
						project: resources.buildProject,
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
					network: placement === null
						? null
						: { subnets: network.subnets, securityGroups: [placement.securityGroupId], publicIp: network.publicIp },
					serviceConnect: placement === null
						? null
						: { namespaceArn: placement.serviceConnectNamespaceArn, discoveryName: resources.discoveryName, port: AWS_APPLICATION_PORT },
					clients: deployClients,
					source: {
						upload: async (parts, signal) => {
							await options.source.upload({ repository, commitSha, archive: { kind: 'application', ...bindingOf(input.sourceBinding) }, parts, signal })
						},
					},
					events: events ?? input.events,
					signal: input.signal,
					dryRun: input.dryRun,
					// Control's deploy input carries no start time; the invocation that starts a run calls `deploy` at once, and
					// an interrupted one is reconciled with the run's own `startedAtMs`, so its deadline only shrinks.
					startedAtMs: now(),
					sleep: options.sleep ?? pause,
				})
			const log = (line: string): void => input.events.log(line)
			if (input.dryRun) return { state: (await deployRun(undefined, null)).status, artifactState: 'not_applicable' }
			// The namespace's proxy group, which the environment's group admits: its stack must serve before any deploy into it.
			const proxy = await readNamespaceOutputs(clients.cloudFormation, namespace, installation, proxySource, input.signal)
			// The environment's own resources next: its repository, log groups, roles, build project and security group.
			// Nothing of the run exists yet, so a stack that does not settle fails the run with nothing to clean up.
			const stack = await ensureEnvironmentStack({
				cloudFormation: clients.cloudFormation,
				stack: awsEnvironmentStack(input.environment.appId, input.environment.env, target, network, {
					securityGroupId: proxy.proxySecurityGroupId,
				}),
				signal: input.signal,
				sleep: options.sleep ?? pause,
				log,
			})
			// Whether the run recorded the update's marker: from then on its revision may run and read its parameters.
			let submitted = false
			const sees = (state: JsonValue | undefined): void => {
				if (parseAwsCheckpoint(state)?.serviceUpdateRequested === true) submitted = true
			}
			const events: ProviderRunEvents = {
				log,
				boundary: () => input.events.boundary(),
				externalId: async (id, state) => {
					sees(state)
					await input.events.externalId(id, state)
				},
				checkpoint: async (state) => {
					sees(state)
					await input.events.checkpoint(state)
				},
			}
			let succeeded = false
			try {
				for (const name of secretNames) {
					await clients.ssm.putSecret(awsSecretParameter(resources, input.runId, name), values.secret[name] ?? '', input.signal)
				}
				const result = await deployRun(events, { securityGroupId: stack.securityGroupId, serviceConnectNamespaceArn: proxy.serviceConnectNamespaceArn })
				succeeded = result.status === 'succeeded'
				input.signal.throwIfAborted()
				return { state: result.status, artifactState: 'not_applicable' }
			} finally {
				// A run that did not ask for the update (failed, cancelled, or thrown, its writes perhaps partial) deletes its
				// own; one that did keeps them, because the update may still land and its tasks read them.
				if (succeeded) await pruneSecrets(clients, resources, input.runId, 'after_success', log)
				else if (!submitted) await pruneSecrets(clients, resources, input.runId, 'own', log)
			}
		},
		cancel: async (input) => {
			input.signal.throwIfAborted()
			return cancelRun(attemptOf(input.environment, input.runId, () => {}), input)
		},
		reconcile: async (input) => {
			input.signal.throwIfAborted()
			const log = (line: string): void => void input.log?.(line).catch(() => {})
			return reconcileRun(attemptOf(input.environment, input.runId, log), input)
		},
	}
}

/** The fields of the target, each the installation's own. */
const AWS_TARGET_FIELDS: readonly (keyof AwsAppTarget)[] = ['accountId', 'region', 'cluster', 'sourcesBucket']
/** How long pruning a run's secret parameters may take, apart from the run's own signal. */
const PRUNE_TIMEOUT_MS = 15_000
