// The platform's own images (the AWS idea's checklist, step 11): built in the operator's account from the
// installation's release commit, as Zerops builds the platform from source. One stack the operator applies holds the
// two repositories, the build project, its role and its log group; the operator's command starts one build per image.
//
// - **The services' image** (`packages/provider-aws/platform.Dockerfile`): IAM, Control with the console, Operations,
//   each started by its task definition's own command. Tagged by the commit.
// - **The platform proxy's image** (`packages/proxy/Dockerfile`): the commit with the platform's proxy manifest beside
//   it, trusting forwarding headers from the platform VPC's balancer subnets alone, as a namespace proxy trusts the
//   applications' VPC's. Tagged by the commit, the manifest's digest and the trusted ranges' digest, so new hosts or
//   ranges build a new image and an old one is never overwritten.
//
// The source is fetched by the commit's full id inside the build, and checked to be that commit before anything is
// built: no archive passes through another hand. The commit id is the one anchor. GitHub serves any commit of a
// repository's fork network by id from the parent's URL, a commit pushed only to a fork among them, so the repository
// named anchors nothing and the check proves the object is that commit, not that it is a release. So the command that
// starts these builds (the commands piece) takes the commit from the installation's own pinned release, resolved in
// the operator's checkout, never from anything Control can write; it may also check that the release's tag resolves
// to it. The proxy's manifest is an object the operator's command writes under `platform/` of the sources bucket, which
// only the platform's build reads (Control's role writes `sources/` alone), and the build checks it against the digest
// its tag names before building. Each image's pushed digest is what a task definition pins (the services piece), not
// its tag: a tag is immutable only while its image exists, and the lifecycle policy expires the oldest. Everything here
// lives under `fabrika/platform/` and `fabrika-platform-`, out of Control's reach.
//
// UNVERIFIED: the resources' properties, that the x86 standard image carries git, the AWS CLI and a Docker with
// BuildKit, and that GitHub serves a commit fetched by its full id follow the CodeBuild and GitHub documentation; none
// was checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import { createHash } from 'node:crypto'
import type { CodeBuildStart } from '../aws/codebuild'
import { IPV4_CIDR_LIST } from '../codecs'
import { allow, AWS_LOG_RETENTION_DAYS, policy, trust } from '../environment-stack'
import type { AwsStack } from '../stack'
import { AWS_PLATFORM_PATH, awsSourcesBucket } from './access'

/** The images' stack's name: under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_IMAGES_STACK = 'fabrika-platform-images'
/** The two repositories, under `fabrika/platform/`. */
export const AWS_SERVICES_REPOSITORY = 'fabrika/platform/services'
export const AWS_PLATFORM_PROXY_REPOSITORY = 'fabrika/platform/proxy'
/** The build project, its role (under the platform's path) and its log group. */
export const AWS_IMAGES_PROJECT = 'fabrika-platform-images'
export const AWS_IMAGES_ROLE = 'fabrika-platform-images'
export const AWS_IMAGES_LOG_GROUP = '/fabrika/platform/images'
/** The builder: Amazon Linux on x86, because the platform proxy's binary is an x64 one; the services run on x86 beside it. */
export const AWS_IMAGES_BUILD_IMAGE = 'aws/codebuild/amazonlinux-x86_64-standard:5.0'
/** How many images each repository keeps. */
export const AWS_KEPT_PLATFORM_IMAGES = 10
/** How long one image's build may run, and wait to start. */
export const AWS_IMAGES_TIMEOUT_MINUTES = 30
export const AWS_IMAGES_QUEUED_TIMEOUT_MINUTES = 60

/** The build's variables: the repository and commit, the image to build, and the proxy's manifest object and ranges. */
export const IMAGES_VARIABLES = {
	repository: 'FABRIKA_PLATFORM_REPOSITORY',
	commit: 'FABRIKA_PLATFORM_COMMIT',
	kind: 'FABRIKA_PLATFORM_IMAGE_KIND',
	image: 'FABRIKA_IMAGE',
	registry: 'FABRIKA_REGISTRY',
	registryRegion: 'FABRIKA_REGISTRY_REGION',
	manifestObject: 'FABRIKA_PROXY_MANIFEST_OBJECT',
	manifestSha256: 'FABRIKA_PROXY_MANIFEST_SHA256',
	trustedProxies: 'FABRIKA_PROXY_TRUSTED_PROXIES',
} satisfies Readonly<Record<string, string>>

/**
 * The services' recipe in the commit. Its own ignore file (`platform.Dockerfile.dockerignore`) decides the context, so
 * the console's sources, which the root's `.dockerignore` leaves out, are in it.
 */
export const AWS_SERVICES_DOCKERFILE = 'packages/provider-aws/platform.Dockerfile'

const v = (name: string): string => `"$${name}"`
const SOURCE = '/tmp/fabrika-source'

/**
 * The buildspec: the commit fetched by its full id and checked, then the services' image or the proxy's, by the build's
 * kind. Every value is a variable; nothing of an installation is written into it.
 */
export const AWS_IMAGES_BUILDSPEC = [
	'version: 0.2',
	'env:',
	'  shell: bash',
	'phases:',
	'  pre_build:',
	'    commands:',
	'      - set -euo pipefail',
	`      - aws ecr get-login-password --region ${v(IMAGES_VARIABLES.registryRegion)} | docker login --username AWS --password-stdin ${
		v(IMAGES_VARIABLES.registry)
	}`,
	`      - git init --quiet ${SOURCE}`,
	`      - git -C ${SOURCE} fetch --quiet --depth 1 "https://github.com/$${IMAGES_VARIABLES.repository}.git" ${v(IMAGES_VARIABLES.commit)}`,
	`      - git -C ${SOURCE} checkout --quiet FETCH_HEAD`,
	`      - test "$(git -C ${SOURCE} rev-parse HEAD)" = ${v(IMAGES_VARIABLES.commit)}`,
	`      - if [ ${
		v(IMAGES_VARIABLES.kind)
	} = proxy ]; then aws s3 cp --only-show-errors "s3://$${IMAGES_VARIABLES.manifestObject}" ${SOURCE}/proxy.manifest.json; fi`,
	// The manifest is the platform proxy's whole endpoint table: the digest its tag and key name is checked, not assumed.
	`      - if [ ${
		v(IMAGES_VARIABLES.kind)
	} = proxy ]; then echo "$${IMAGES_VARIABLES.manifestSha256}  ${SOURCE}/proxy.manifest.json" | sha256sum -c -; fi`,
	'  build:',
	'    commands:',
	'      - set -euo pipefail',
	`      - if [ ${
		v(IMAGES_VARIABLES.kind)
	} = services ]; then DOCKER_BUILDKIT=1 docker build --platform linux/amd64 --file ${SOURCE}/${AWS_SERVICES_DOCKERFILE} --tag ${
		v(IMAGES_VARIABLES.image)
	} ${SOURCE}; fi`,
	`      - if [ ${
		v(IMAGES_VARIABLES.kind)
	} = proxy ]; then DOCKER_BUILDKIT=1 docker build --platform linux/amd64 --build-arg ${IMAGES_VARIABLES.trustedProxies} --file ${SOURCE}/packages/proxy/Dockerfile --tag ${
		v(IMAGES_VARIABLES.image)
	} ${SOURCE}; fi`,
	`      - docker push ${v(IMAGES_VARIABLES.image)}`,
	'',
].join('\n')

const ACCOUNT_ID = /^\d{12}$/
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/

/** The images' stack: the two repositories, the build's role and log group, and the build project. */
export function awsImagesStack(installation: { readonly accountId: string; readonly region: string }): AwsStack {
	const { accountId, region } = installation
	if (!ACCOUNT_ID.test(accountId) || !REGION.test(region)) throw new Error('aws: the account id or region is of another form')
	const repository = (name: string) => `arn:aws:ecr:${region}:${accountId}:repository/${name}`
	const repositoryResource = (name: string): JsonValue => ({
		Type: 'AWS::ECR::Repository',
		Properties: {
			RepositoryName: name,
			ImageTagMutability: 'IMMUTABLE',
			EncryptionConfiguration: { EncryptionType: 'AES256' },
			LifecyclePolicy: {
				LifecyclePolicyText: JSON.stringify({
					rules: [{
						rulePriority: 1,
						description: `keep the newest ${AWS_KEPT_PLATFORM_IMAGES}`,
						selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: AWS_KEPT_PLATFORM_IMAGES },
						action: { type: 'expire' },
					}],
				}),
			},
		},
	})
	return {
		stackName: AWS_IMAGES_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: "fabrika: the platform's images",
			Resources: {
				ServicesRepository: repositoryResource(AWS_SERVICES_REPOSITORY),
				ProxyRepository: repositoryResource(AWS_PLATFORM_PROXY_REPOSITORY),
				BuildLogGroup: { Type: 'AWS::Logs::LogGroup', Properties: { LogGroupName: AWS_IMAGES_LOG_GROUP, RetentionInDays: AWS_LOG_RETENTION_DAYS } },
				BuildRole: {
					Type: 'AWS::IAM::Role',
					Properties: {
						RoleName: AWS_IMAGES_ROLE,
						Path: AWS_PLATFORM_PATH,
						AssumeRolePolicyDocument: trust('codebuild.amazonaws.com', accountId, {
							equals: `arn:aws:codebuild:${region}:${accountId}:project/${AWS_IMAGES_PROJECT}`,
						}),
						Policies: [
							policy('images', [
								allow(['ecr:GetAuthorizationToken'], ['*']),
								allow(
									[
										'ecr:BatchCheckLayerAvailability',
										'ecr:GetDownloadUrlForLayer',
										'ecr:BatchGetImage',
										'ecr:InitiateLayerUpload',
										'ecr:UploadLayerPart',
										'ecr:CompleteLayerUpload',
										'ecr:PutImage',
									],
									[repository(AWS_SERVICES_REPOSITORY), repository(AWS_PLATFORM_PROXY_REPOSITORY)],
								),
								allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [`arn:aws:logs:${region}:${accountId}:log-group:${AWS_IMAGES_LOG_GROUP}:*`]),
								// The platform proxy's manifest, which the operator's command writes; nothing of Control's `sources/`.
								// This account's bucket alone: a bucket's name is global.
								{
									Effect: 'Allow',
									Action: ['s3:GetObject'],
									Resource: [`arn:aws:s3:::${awsSourcesBucket(accountId)}/platform/*`],
									Condition: { StringEquals: { 's3:ResourceAccount': accountId } },
								},
							]),
						],
					},
				},
				BuildProject: {
					Type: 'AWS::CodeBuild::Project',
					Properties: {
						Name: AWS_IMAGES_PROJECT,
						ServiceRole: { 'Fn::GetAtt': ['BuildRole', 'Arn'] },
						Source: { Type: 'NO_SOURCE', BuildSpec: AWS_IMAGES_BUILDSPEC },
						Artifacts: { Type: 'NO_ARTIFACTS' },
						Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_MEDIUM', Image: AWS_IMAGES_BUILD_IMAGE, PrivilegedMode: true },
						LogsConfig: { CloudWatchLogs: { Status: 'ENABLED', GroupName: AWS_IMAGES_LOG_GROUP } },
						TimeoutInMinutes: AWS_IMAGES_TIMEOUT_MINUTES,
						QueuedTimeoutInMinutes: AWS_IMAGES_QUEUED_TIMEOUT_MINUTES,
					},
				},
			},
		},
		tags: { 'fabrika:platform': 'images' },
	}
}

/** One build of one platform image. */
export type AwsPlatformImage =
	| { readonly kind: 'services' }
	| {
		readonly kind: 'proxy'
		/** The SHA-256 of the manifest object, in hex: part of the image's tag. */
		readonly manifestSha256: string
		/** The platform VPC's balancer subnets, sorted and comma-joined (`awsTrustedProxies`). */
		readonly trustedProxies: string
	}

export interface AwsImagesBuildInput {
	readonly accountId: string
	readonly region: string
	/** The public platform repository, `owner/name`. */
	readonly repository: string
	/** The release's full commit id. */
	readonly commitSha: string
	readonly image: AwsPlatformImage
	/** The build's idempotency token. */
	readonly token: string
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

/**
 * The image's tag: the commit, and for the proxy the manifest's digest and the digest of the trusted ranges too, each
 * shortened. Everything the proxy's build bakes in is in its tag, so an image found by its tag is the one these inputs
 * build, never one built under other ranges.
 */
export function awsPlatformImageTag(commitSha: string, image: AwsPlatformImage): string {
	if (image.kind === 'services') return commitSha
	const ranges = createHash('sha256').update(image.trustedProxies, 'utf8').digest('hex')
	return `${commitSha.slice(0, 12)}-${image.manifestSha256.slice(0, 16)}-${ranges.slice(0, 8)}`
}

/** Where the operator's command writes the platform proxy's manifest: under `platform/` of the sources bucket. */
export function awsPlatformManifestKey(commitSha: string, manifestSha256: string): string {
	return `platform/${commitSha}/${manifestSha256}/proxy.manifest.json`
}

/** The start of one image's build, as `codeBuildClient(…).startBuild` takes it; every value checked first. */
export function awsImagesBuildStart(input: AwsImagesBuildInput): CodeBuildStart {
	const { accountId, region, image } = input
	if (!ACCOUNT_ID.test(accountId) || !REGION.test(region)) throw new Error('aws: the account id or region is of another form')
	if (!REPOSITORY.test(input.repository)) throw new Error('aws: the platform repository is not of the form owner/name')
	if (!COMMIT.test(input.commitSha)) throw new Error("aws: the platform's commit is not a full commit id")
	if (image.kind === 'proxy' && (!SHA256.test(image.manifestSha256) || !IPV4_CIDR_LIST.test(image.trustedProxies))) {
		throw new Error("aws: the platform proxy's manifest digest or trusted ranges are of another form")
	}
	const registry = `${accountId}.dkr.ecr.${region}.amazonaws.com`
	const repository = image.kind === 'services' ? AWS_SERVICES_REPOSITORY : AWS_PLATFORM_PROXY_REPOSITORY
	return {
		project: AWS_IMAGES_PROJECT,
		token: input.token,
		buildspec: AWS_IMAGES_BUILDSPEC,
		variables: {
			[IMAGES_VARIABLES.repository]: { value: input.repository },
			[IMAGES_VARIABLES.commit]: { value: input.commitSha },
			[IMAGES_VARIABLES.kind]: { value: image.kind },
			[IMAGES_VARIABLES.image]: { value: `${registry}/${repository}:${awsPlatformImageTag(input.commitSha, image)}` },
			[IMAGES_VARIABLES.registry]: { value: registry },
			[IMAGES_VARIABLES.registryRegion]: { value: region },
			...(image.kind === 'services' ? {} : {
				[IMAGES_VARIABLES.manifestObject]: { value: `${awsSourcesBucket(accountId)}/${awsPlatformManifestKey(input.commitSha, image.manifestSha256)}` },
				[IMAGES_VARIABLES.manifestSha256]: { value: image.manifestSha256 },
				[IMAGES_VARIABLES.trustedProxies]: { value: image.trustedProxies },
			}),
		},
		timeoutMinutes: AWS_IMAGES_TIMEOUT_MINUTES,
		queuedTimeoutMinutes: AWS_IMAGES_QUEUED_TIMEOUT_MINUTES,
	}
}
