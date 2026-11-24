// The build of one deploy (the AWS idea's checklist, step 6): a CodeBuild build with no source of its own, which fetches
// the archive Control uploaded (`aws/s3.ts`) through a presigned URL, builds the `Dockerfile` that `containerImage`
// rendered from the contract's recipe, and pushes the image to the application's repository under a tag of this run. The
// deploy then reads the image's digest from ECR by that tag (`ecrClient(…).findImage`), never from the build's log.
//
// The buildspec is one constant: every value of a run travels as a build variable, so nothing a run carries is ever
// spliced into YAML or a shell line. The two credentials among them are Parameter Store variables, which a start records
// by name only: the presigned URL (a SecureString the deploy writes under the run's path before the start and deletes
// once the build ended, `sourceUrlParameter`), and the source-map bearer when the recipe uploads maps, which reaches
// the image build as a BuildKit secret (`SOURCE_MAP_UPLOAD_SECRET`), never as a build argument or a layer.
//
// CodeBuild's buildspec reference states that in version 0.2 every command runs in the same instance of the shell.
// UNVERIFIED: that the builder image carries `curl`, `tar`, `base64`, the AWS CLI and a Docker with BuildKit's
// `--secret id=…,env=…`, and CodeBuild's bound on a variable's value, follow CodeBuild's documentation of its standard
// ARM image; none was checked against an account.

import { SOURCE_MAP_UPLOAD_SECRET } from '@fabrika/app/build'
import type { CodeBuildStart } from './aws/codebuild'
import { AWS_BUILD_QUEUED_TIMEOUT_MINUTES, AWS_BUILD_TIMEOUT_MINUTES } from './run-attempt'

/** The variables the buildspec reads. */
export const BUILD_VARIABLES = {
	sourceUrl: 'FABRIKA_SOURCE_URL',
	dockerfile: 'FABRIKA_DOCKERFILE',
	image: 'FABRIKA_IMAGE',
	registry: 'FABRIKA_REGISTRY',
	registryRegion: 'FABRIKA_REGISTRY_REGION',
	sourceMapKey: 'FABRIKA_SOURCE_MAP_UPLOAD_KEY',
} satisfies Readonly<Record<string, string>>

/**
 * The buildspec of every application build. The archive has one top-level directory (Control refuses any other), which
 * `--strip-components=1` drops, so the build context is the commit's tree; the `Dockerfile` sits outside it, beside an
 * empty ignore file of its own (`<Dockerfile>.dockerignore`, which BuildKit reads before the context's), so the
 * application's own `.dockerignore` filters nothing. The presigned URL is dropped from the shell once the archive is
 * fetched. The login names the registry's own region.
 */
export const AWS_BUILDSPEC = [
	'version: 0.2',
	'env:',
	'  shell: bash',
	'phases:',
	'  pre_build:',
	'    commands:',
	'      - set -euo pipefail',
	`      - aws ecr get-login-password --region "$${BUILD_VARIABLES.registryRegion}" | docker login --username AWS --password-stdin "$${BUILD_VARIABLES.registry}"`,
	'      - mkdir /tmp/fabrika-source',
	`      - curl --fail --silent --show-error --proto =https --output /tmp/fabrika-source.tar.gz "$${BUILD_VARIABLES.sourceUrl}"`,
	`      - unset ${BUILD_VARIABLES.sourceUrl}`,
	'      - tar --extract --gzip --file /tmp/fabrika-source.tar.gz --directory /tmp/fabrika-source --strip-components=1 --no-same-owner',
	`      - printf '%s' "$${BUILD_VARIABLES.dockerfile}" | base64 --decode > /tmp/fabrika-Dockerfile`,
	"      - printf '' > /tmp/fabrika-Dockerfile.dockerignore",
	'  build:',
	'    commands:',
	'      - set -euo pipefail',
	// The secret flag only when the bearer is set: unquoted, the expansion is two words or none.
	`      - DOCKER_BUILDKIT=1 docker build --platform linux/arm64 --file /tmp/fabrika-Dockerfile \${${BUILD_VARIABLES.sourceMapKey}:+--secret id=${SOURCE_MAP_UPLOAD_SECRET},env=${BUILD_VARIABLES.sourceMapKey}} --tag "$${BUILD_VARIABLES.image}" /tmp/fabrika-source`,
	`      - docker push "$${BUILD_VARIABLES.image}"`,
	'',
].join('\n')

/** The largest rendered `Dockerfile` a build takes, before its base64. */
export const MAX_DOCKERFILE_BYTES = 32 * 1024
/**
 * An ECR repository's URI: `<account>.dkr.ecr.<region>.amazonaws.com/<name>`, the name in ECR's own form (segments of
 * lower-case letters and digits joined by one `.`, `_` or `-`, separated by `/`), 2 to 256 characters.
 */
const REPOSITORY_URI =
	/^(\d{12})\.dkr\.ecr\.([a-z]{2,4}(?:-[a-z]{1,10}){1,3}-\d{1,2})\.amazonaws\.com\/((?=.{2,256}$)(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)$/
/** A Parameter Store parameter's name, as `startBuild` takes it. */
const PARAMETER_NAME = /^(?=.{2,950}$)(?:\/[A-Za-z0-9_.-]+){1,15}$/

/** The image tag of a run: its build token, so a run's image can be found again whatever happened to the build's answer. */
export function awsImageTag(buildToken: string): string {
	return `run-${buildToken}`
}

export interface AwsBuildInput {
	/** The CodeBuild project: one per installation, the builder's image and role its own. */
	readonly project: string
	/** The run's build token (`AwsRunCheckpoint.buildToken`), recorded before the start. */
	readonly buildToken: string
	/**
	 * The Parameter Store name of the SecureString that holds the presigned GET of the uploaded archive (`s3PresignedGet`):
	 * the deploy writes it under the run's path before the start and deletes it once the build ended.
	 */
	readonly sourceUrlParameter: string
	/** The `Dockerfile` `containerImage` rendered. */
	readonly dockerfile: string
	/** The application environment's ECR repository (`<account>.dkr.ecr.<region>.amazonaws.com/<name>`). */
	readonly repositoryUri: string
	/** The Parameter Store name of the source-map bearer, when the recipe uploads maps. */
	readonly sourceMapKeyParameter: string | null
}

/** Refuses an input this module cannot start a build with, naming the argument only. */
function refuse(what: string): never {
	throw new Error(`AWS build: ${what} is not one this provider builds with`)
}

/** The start of one application build, as `codeBuildClient(…).startBuild` takes it. */
export function awsBuildStart(input: AwsBuildInput): CodeBuildStart {
	const repository = REPOSITORY_URI.exec(input.repositoryUri)
	const [, account, region] = repository ?? []
	if (account === undefined || region === undefined) refuse('the repository')
	if (!PARAMETER_NAME.test(input.sourceUrlParameter)) refuse('the source URL parameter')
	const dockerfile = new TextEncoder().encode(input.dockerfile)
	if (dockerfile.byteLength === 0 || dockerfile.byteLength > MAX_DOCKERFILE_BYTES) refuse('the Dockerfile')
	if (input.sourceMapKeyParameter !== null && !PARAMETER_NAME.test(input.sourceMapKeyParameter)) refuse('the source-map key parameter')
	return {
		project: input.project,
		token: input.buildToken,
		buildspec: AWS_BUILDSPEC,
		variables: {
			[BUILD_VARIABLES.sourceUrl]: { parameter: input.sourceUrlParameter },
			[BUILD_VARIABLES.dockerfile]: { value: dockerfile.toBase64() },
			[BUILD_VARIABLES.image]: { value: `${input.repositoryUri}:${awsImageTag(input.buildToken)}` },
			[BUILD_VARIABLES.registry]: { value: `${account}.dkr.ecr.${region}.amazonaws.com` },
			[BUILD_VARIABLES.registryRegion]: { value: region },
			...(input.sourceMapKeyParameter === null ? {} : { [BUILD_VARIABLES.sourceMapKey]: { parameter: input.sourceMapKeyParameter } }),
		},
		timeoutMinutes: AWS_BUILD_TIMEOUT_MINUTES,
		queuedTimeoutMinutes: AWS_BUILD_QUEUED_TIMEOUT_MINUTES,
	}
}
