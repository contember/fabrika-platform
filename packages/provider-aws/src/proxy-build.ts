// The build of a namespace proxy's image (the AWS idea's checklist, step 10): a build of the namespace's own CodeBuild
// project (`namespace.ts`), with no source of its own, which fetches the archive Control uploads through a presigned URL,
// builds the image by the commit's own recipe and pushes it to the namespace's repository under a tag of the attempt.
//
// - The archive is the namespace's pinned proxy commit and one data file, the proxy manifest at `proxy.manifest.json`
//   (ADR-0045; `proxy-manifest.ts` compiles it), so a running proxy never reads a manifest newer than its image.
// - The recipe is the commit's (`packages/proxy/Dockerfile`), never one this provider renders: a namespace keeps its
//   pinned proxy source through a Control upgrade (ADR-0045), and only the commit knows how its own proxy is built (the
//   arguments of its `generate-config.ts`, the files its start script reads). A recipe of Control's would pair an older
//   commit with a newer release's build. The commit's ignore files apply as the commit has them, for the same reason.
// - On X86_64: the proxy package compiles its binary for `linux-x64-musl` only, so the builder is an x86 one and the
//   proxy's task will run on X86_64, while the applications' run on ARM64 (`ecs.ts`).
// - The buildspec is one constant, as an application's (`build.ts`): every value of an attempt travels as a build
//   variable, the presigned URL by its Parameter Store name only.
//
// Not yet: the recipe itself (`packages/proxy/Dockerfile` is not in the repository yet), the upload and the start
// (`republish`), and the proxy's ECS service.
//
// UNVERIFIED: the builder image's name and what it carries (`curl`, `tar`, the AWS CLI, a Docker with BuildKit) follow
// CodeBuild's documentation of its standard x86 image; none was checked against an account.

import type { CodeBuildStart } from './aws/codebuild'
import { awsImageTag, BUILD_VARIABLES, BUILDSPEC_FETCH, PARAMETER_NAME, REPOSITORY_URI } from './build'
import { AWS_BUILD_QUEUED_TIMEOUT_MINUTES, AWS_BUILD_TIMEOUT_MINUTES } from './run-attempt'

/** The recipe of the proxy's image, a path of the pinned commit. */
export const AWS_PROXY_DOCKERFILE = 'packages/proxy/Dockerfile'
/** The archive's one data file: the manifest the proxy is built with, at a path the commit does not hold (ADR-0045). */
export const AWS_PROXY_MANIFEST_PATH = 'proxy.manifest.json'
/** The proxy's builder: Amazon Linux on x86, because the proxy's binary is an x64 one. */
export const AWS_PROXY_BUILD_IMAGE = 'aws/codebuild/amazonlinux-x86_64-standard:5.0'

/**
 * The buildspec of every proxy build: the archive fetched as an application's is, the manifest required, and the
 * commit's recipe built for `linux/amd64` with the whole archive as its context.
 */
export const AWS_PROXY_BUILDSPEC = [
	...BUILDSPEC_FETCH,
	// The archive without its data file is one this build never makes an image of.
	`      - test -f /tmp/fabrika-source/${AWS_PROXY_MANIFEST_PATH}`,
	'  build:',
	'    commands:',
	'      - set -euo pipefail',
	`      - DOCKER_BUILDKIT=1 docker build --platform linux/amd64 --file /tmp/fabrika-source/${AWS_PROXY_DOCKERFILE} --tag "$${BUILD_VARIABLES.image}" /tmp/fabrika-source`,
	`      - docker push "$${BUILD_VARIABLES.image}"`,
	'',
].join('\n')

export interface AwsProxyBuildInput {
	/** The namespace's own CodeBuild project (`AwsNamespaceResources.buildProject`). */
	readonly project: string
	/** The attempt's build token, recorded before the start, so the attempt's image can be found again by its tag. */
	readonly buildToken: string
	/** The Parameter Store name of the SecureString that holds the archive's presigned GET, under the namespace's `builds/`. */
	readonly sourceUrlParameter: string
	/** The namespace's proxy repository (`<account>.dkr.ecr.<region>.amazonaws.com/<name>`). */
	readonly repositoryUri: string
}

/** The start of one proxy build, as `codeBuildClient(…).startBuild` takes it. */
export function awsProxyBuildStart(input: AwsProxyBuildInput): CodeBuildStart {
	const [, account, region] = REPOSITORY_URI.exec(input.repositoryUri) ?? []
	if (account === undefined || region === undefined) throw new Error('AWS proxy build: the repository is not one this provider builds with')
	if (!PARAMETER_NAME.test(input.sourceUrlParameter)) throw new Error('AWS proxy build: the source URL parameter is not one this provider builds with')
	return {
		project: input.project,
		token: input.buildToken,
		buildspec: AWS_PROXY_BUILDSPEC,
		variables: {
			[BUILD_VARIABLES.sourceUrl]: { parameter: input.sourceUrlParameter },
			[BUILD_VARIABLES.image]: { value: `${input.repositoryUri}:${awsImageTag(input.buildToken)}` },
			[BUILD_VARIABLES.registry]: { value: `${account}.dkr.ecr.${region}.amazonaws.com` },
			[BUILD_VARIABLES.registryRegion]: { value: region },
		},
		timeoutMinutes: AWS_BUILD_TIMEOUT_MINUTES,
		queuedTimeoutMinutes: AWS_BUILD_QUEUED_TIMEOUT_MINUTES,
	}
}
