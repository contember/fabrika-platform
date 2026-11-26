// What the AWS provider persists through Control (ADR-0011): an application environment's target, its artifact, a
// namespace's target and a run's checkpoint, each a versioned `ProviderEnvelope` payload under Control's 16 KiB
// (`MAX_PROVIDER_STATE_BYTES`). Every decode is strict: a payload with a field this release does not know is refused,
// not dropped. Coordinates only, never a credential (the composition holds those for a live run).
//
// UNVERIFIED: the identifier forms below follow AWS's published API references; none was checked against an account.

import { type JsonValue, MAX_PROVIDER_STATE_BYTES, type ProviderCodec } from '@fabrika/provider-contract'
import { z } from 'zod'

/** The provider id an envelope and an authored config carry. */
export const AWS_PROVIDER = 'aws'

/** A 12-digit AWS account id. */
const ACCOUNT_ID = /^\d{12}$/
/** A region code: `eu-central-1`, `us-gov-west-1`, `eusc-de-east-1`; at most four words of at most ten letters. */
const REGION_SOURCE = '[a-z]{2,4}(?:-[a-z]{1,10}){1,3}-\\d{1,2}'
const REGION = new RegExp(`^${REGION_SOURCE}$`)
/** An ECS cluster's or service's name: letters, digits, hyphens and underscores, at most 255. */
const ECS_NAME = /^[A-Za-z0-9_-]{1,255}$/
/** An AWS partition in an ARN: `aws`, `aws-cn`, `aws-us-gov`, `aws-iso-b`, `aws-eusc`, and any later one of that form. */
const PARTITION = 'aws(?:-[a-z]{1,10}){0,2}'
/** A task definition revision's ARN: `arn:aws:ecs:<region>:<account>:task-definition/<family>:<revision>`. */
const TASK_DEFINITION_ARN = new RegExp(`^arn:${PARTITION}:ecs:${REGION_SOURCE}:\\d{12}:task-definition/[A-Za-z0-9_-]{1,255}:\\d{1,10}$`)
/**
 * A service deployment's ARN, which `UpdateService` names and `DescribeServiceDeployments` reads:
 * `…:service-deployment/<cluster>/<service>/<id>`, a cluster's and a service's name of up to 255 each.
 */
const SERVICE_DEPLOYMENT_ARN = new RegExp(
	`^arn:${PARTITION}:ecs:${REGION_SOURCE}:\\d{12}:service-deployment/[A-Za-z0-9_-]{1,255}/[A-Za-z0-9_-]{1,255}/[A-Za-z0-9_-]{1,64}$`,
)
/** A CodeBuild build's id: `<project>:<uuid>`. */
const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,254}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A caller-chosen token: a lowercase UUID. */
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A CloudFormation stack's name: a letter, then letters, digits and hyphens, at most 128. */
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/
/** A GitHub repository as `awsSourceRepository` names it: `<owner>/<name>`, lowercased. */
const GITHUB_REPOSITORY = /^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9][a-z0-9._-]{0,99}$/
/** A full git commit: 40 lowercase hex digits. */
const COMMIT_SHA = /^[0-9a-f]{40}$/
/** A sha256 digest as 64 lowercase hex digits. */
const SHA256_HEX = /^[0-9a-f]{64}$/
/** The contract digest the framework computes: `sha256:<64 hex>`. */
const CONTRACT_DIGEST = /^sha256:[0-9a-f]{64}$/
/** The contract's health endpoint: an absolute path the framework serves. */
const HEALTH_PATH = /^\/[A-Za-z0-9._~/-]{0,255}$/

/** Whether `path` is a contract health endpoint as the artifact holds it: the form above, with no `.` or `..` segment. */
export function isHealthPath(path: string): boolean {
	return HEALTH_PATH.test(path) && !path.split('/').some((segment) => segment === '.' || segment === '..')
}

/** An S3 bucket's name: 3 to 63 lowercase letters, digits, dots and hyphens, a letter or digit at each end. */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
/**
 * Where one application environment runs: the account, the region and the cluster, and the installation's shared
 * sources bucket, until the namespace stack creates them (checklist step 10). Nothing of one environment's own is named
 * here: its service, repository, parameter path, log groups, roles and build project are derived from its application
 * id and environment (`awsEnvironmentResources`), so no registration can name another environment's.
 */
export interface AwsAppTarget {
	readonly accountId: string
	readonly region: string
	readonly cluster: string
	readonly sourcesBucket: string
}

/** What a registration records about a contract application: its contract alone, no manifest file. */
export interface AwsAppArtifact {
	readonly contractDigest: string
	readonly healthPath: string
}

/** How a namespace is sized: one shared database instance for every application, or one per application. */
export type AwsNamespaceSizing = 'cheap' | 'full'

/**
 * A namespace: the CloudFormation stack that holds its network, its proxy and, for `cheap`, its database, and the
 * source its proxy is built from.
 *
 * - `proxyRepository` and `proxyCommitSha` are the namespace's pinned proxy source (ADR-0045): the installation's public
 *   platform repository (`<owner>/<name>`, as `awsSourceRepository` lowercases it) and a full commit. Planning copies the
 *   installation's default; every later build uses the pin, never a newer default of an upgraded Control.
 * - The proxy build in flight (ADR-0044): `proxyBuildToken` and `proxyBuildManifestSha256` are recorded before anything
 *   of the attempt is written, the token being its archive's key, its URL parameter and `StartBuild`'s idempotency
 *   token; `proxyBuildId` once CodeBuild answered.
 * - The proxy's image, once a build succeeded: `proxyImageDigest` (the pushed image's, read from ECR by the attempt's
 *   tag) and `proxyImageManifestSha256` (the manifest it was built with), recorded together as the attempt is cleared.
 */
export interface AwsNamespaceTarget {
	readonly accountId: string
	readonly region: string
	readonly stackName: string
	readonly sizing: AwsNamespaceSizing
	readonly proxyRepository: string
	readonly proxyCommitSha: string
	readonly proxyBuildToken?: string
	readonly proxyBuildManifestSha256?: string
	readonly proxyBuildId?: string
	readonly proxyImageDigest?: string
	readonly proxyImageManifestSha256?: string
}

/**
 * A run's progress (ADR-0044). An id AWS hands back exists only after the call that started the work, so a crash or a
 * lost lease between the answer and the write would leave a successor unable to tell "never submitted" from
 * "submitted, id lost". Each submitting call therefore has a caller-chosen value recorded before it:
 *
 * - `buildToken`, written before `StartBuild` and sent as its idempotency token; `buildId` once AWS answered. A
 *   successor may repeat the call only while the token holds (the reference gives five minutes); past that it must
 *   find the build the token started instead, because a repeat would start a second one.
 * - `taskDefinitionArn`, the revision `RegisterTaskDefinition` answered; a lost answer only leaves an unused revision.
 * - `serviceUpdateRequested`, written before `UpdateService` or `CreateService`: a successor that finds it without a
 *   `deploymentArn` reads the service's deployment of this run's task definition instead of updating again;
 *   `deploymentArn` once AWS answered.
 * - `serviceCreateRequested`, written with it when the call is `CreateService`: a service ECS answers `MISSING` is
 *   then no verdict (the create may not show yet, or may still land), so the run waits for its deadline instead.
 *
 * UNVERIFIED: `StartBuild`'s idempotency token and how long it holds come from the API reference; `deploy.ts` (B8)
 * settles the recovery against a fake of each answer.
 */
export interface AwsRunCheckpoint {
	readonly buildToken?: string
	readonly buildId?: string
	readonly taskDefinitionArn?: string
	readonly serviceUpdateRequested?: true
	readonly serviceCreateRequested?: true
	readonly deploymentArn?: string
}

const appTargetSchema = z.object({
	accountId: z.string().regex(ACCOUNT_ID),
	region: z.string().regex(REGION),
	cluster: z.string().regex(ECS_NAME),
	sourcesBucket: z.string().regex(BUCKET),
}).strict()

const appArtifactSchema = z.object({
	contractDigest: z.string().regex(CONTRACT_DIGEST),
	healthPath: z.string().refine(isHealthPath),
}).strict()

const namespaceTargetSchema = z.object({
	accountId: z.string().regex(ACCOUNT_ID),
	region: z.string().regex(REGION),
	stackName: z.string().regex(STACK_NAME),
	sizing: z.enum(['cheap', 'full']),
	proxyRepository: z.string().regex(GITHUB_REPOSITORY),
	proxyCommitSha: z.string().regex(COMMIT_SHA),
	proxyBuildToken: z.string().regex(TOKEN).optional(),
	proxyBuildManifestSha256: z.string().regex(SHA256_HEX).optional(),
	proxyBuildId: z.string().regex(BUILD_ID).optional(),
	proxyImageDigest: z.string().regex(CONTRACT_DIGEST).optional(),
	proxyImageManifestSha256: z.string().regex(SHA256_HEX).optional(),
}).strict().refine((target) => (target.proxyImageDigest === undefined) === (target.proxyImageManifestSha256 === undefined), {
	message: "the proxy's image is recorded with its manifest's digest",
	path: ['proxyImageManifestSha256'],
}).refine(
	(target) => target.proxyBuildToken !== undefined || (target.proxyBuildManifestSha256 === undefined && target.proxyBuildId === undefined),
	{
		message: 'a proxy build is recorded with its token',
		path: ['proxyBuildToken'],
	},
).refine((target) => (target.proxyBuildToken === undefined) === (target.proxyBuildManifestSha256 === undefined), {
	message: "a proxy build's token is recorded with its manifest's digest",
	path: ['proxyBuildManifestSha256'],
})

const runCheckpointSchema = z.object({
	buildToken: z.string().regex(TOKEN).optional(),
	buildId: z.string().regex(BUILD_ID).optional(),
	taskDefinitionArn: z.string().regex(TASK_DEFINITION_ARN).optional(),
	serviceUpdateRequested: z.literal(true).optional(),
	serviceCreateRequested: z.literal(true).optional(),
	deploymentArn: z.string().regex(SERVICE_DEPLOYMENT_ARN).optional(),
}).strict()

/** The fields an issue names: its path, or for an unknown field the field's own name (a name, never a value). */
function issueFields(issue: z.ZodIssue): readonly string[] {
	if (issue.code === 'unrecognized_keys') return issue.keys
	const path = issue.path.join('.')
	return [path === '' ? '(root)' : path]
}

/** A codec over `schema` whose encoding is the parsed value itself, refused above Control's limit either way. */
function strictCodec<T extends Readonly<Record<string, string | true | undefined>>>(kind: string, schema: z.ZodType<T>): ProviderCodec<T> {
	const parse = (value: unknown): T => {
		const parsed = schema.safeParse(value)
		if (!parsed.success) {
			// The issues name fields only; a value is never quoted.
			const fields = [...new Set(parsed.error.issues.flatMap(issueFields))].join(', ')
			throw new Error(`the AWS ${kind} is not one this provider reads (${fields})`)
		}
		if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > MAX_PROVIDER_STATE_BYTES) {
			throw new Error(`the AWS ${kind} is larger than Control stores (${MAX_PROVIDER_STATE_BYTES} bytes)`)
		}
		return parsed.data
	}
	return {
		version: 1,
		encode: (value): JsonValue => {
			const parsed = parse(value)
			const encoded: Record<string, string | boolean> = {}
			for (const [key, field] of Object.entries(parsed)) {
				if (field !== undefined) encoded[key] = field
			}
			return encoded
		},
		decode: (payload) => parse(payload),
	}
}

export const awsAppTargetCodec: ProviderCodec<AwsAppTarget> = strictCodec('target', appTargetSchema)
export const awsAppArtifactCodec: ProviderCodec<AwsAppArtifact> = strictCodec('artifact', appArtifactSchema)
export const awsNamespaceTargetCodec: ProviderCodec<AwsNamespaceTarget> = strictCodec('namespace target', namespaceTargetSchema)
export const awsRunCheckpointCodec: ProviderCodec<AwsRunCheckpoint> = strictCodec('run checkpoint', runCheckpointSchema)
