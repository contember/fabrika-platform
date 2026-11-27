// The release's two images (the AWS idea's checklist, step 11, the commands' step): what `applyAwsPlatform`'s `images`
// builds, or finds built, after the images' stack and before the setup's, with the operator's own credentials.
//
// - **Found first.** Each image's tag is the release's commit (and for the proxy the manifest's digest,
//   `awsPlatformImageTag`), and its repository's tags are immutable, so an image of that tag is that build: an upgrade
//   or a resumed run that finds one reads its digest and builds nothing.
// - **The proxy's manifest first.** Its bytes go to the sources bucket under `platform/<commit>/<digest>/` before the
//   proxy's build starts, which fetches it and checks the digest (`images.ts`).
// - **A build found again.** Each build's idempotency token is derived from its image's tag, so a run that lost a
//   build's answer, or stopped while it ran, finds it (`findBuild`) and waits for it rather than starting a second.
//   A build that ended without the image is started again once; one that fails again stops the run, naming its log.
// - **Both at once**, each awaited up to its queue and run limits.
//
// The answer is each image's digest, which every task definition names (`services.ts`), never a tag.
//
// UNVERIFIED: that a build CodeBuild still lists among a project's newest is found by its token's variable, and the
// statuses, follow CodeBuild's API reference; none was checked against an account.

import { createHash } from 'node:crypto'
import type { CodeBuildBuild, CodeBuildClient } from '../aws/codebuild'
import type { EcrClient } from '../aws/ecr'
import type { S3PartWriter } from '../aws/s3'
import { readAgainLater, UNREAD } from '../stack'
import type { AwsPlatformImages, AwsPlatformState } from './apply'
import {
	AWS_IMAGES_PROJECT,
	AWS_IMAGES_QUEUED_TIMEOUT_MINUTES,
	AWS_IMAGES_TIMEOUT_MINUTES,
	AWS_PLATFORM_PROXY_REPOSITORY,
	AWS_SERVICES_REPOSITORY,
	awsImagesBuildStart,
	type AwsPlatformImage,
	awsPlatformImageTag,
	awsPlatformManifestKey,
} from './images'
import type { AwsPlatformManifest } from './platform-manifest'

/** How often a build is read while it runs. */
export const AWS_IMAGES_POLL_MS = 20_000
/** How long a build is waited for: its queue limit and its run limit, and a few minutes of CodeBuild's own. */
const BUILD_WAIT_MS = (AWS_IMAGES_QUEUED_TIMEOUT_MINUTES + AWS_IMAGES_TIMEOUT_MINUTES + 5) * 60_000

export interface AwsImagesBuildRun {
	readonly state: Pick<AwsPlatformState, 'plan' | 'platform'>
	/** The public platform repository (`owner/name`) and the release's full commit. */
	readonly release: { readonly repository: string; readonly commitSha: string }
	readonly manifest: Pick<AwsPlatformManifest, 'json' | 'sha256'>
	readonly codeBuild: Pick<CodeBuildClient, 'startBuild' | 'findBuild' | 'getBuild'>
	readonly ecr: Pick<EcrClient, 'findImage'>
	/** A writer of the object `key` in the sources bucket (`s3PartWriter` over the operator's credentials). */
	readonly manifestWriter: (key: string) => Pick<S3PartWriter, 'complete'>
	readonly signal: AbortSignal
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly log: (line: string) => void
	readonly now?: () => number
}

/** A build's idempotency token, the same for every run that builds this tag: a UUID's form, from the tag's digest. */
export function awsImageBuildToken(tag: string, image: AwsPlatformImage['kind']): string {
	const hex = createHash('sha256').update(`fabrika-platform-image:${image}:${tag}`, 'utf8').digest('hex')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** The trusted ranges the proxy bakes in: the platform balancer's own subnets, sorted. */
function trustedProxies(state: AwsImagesBuildRun['state']): string {
	return [...state.platform.balancerSubnetCidrs].sort().join(',')
}

/** Builds, or finds built, the services' image and the platform proxy's, and answers their digests. */
export async function buildAwsPlatformImages(run: AwsImagesBuildRun): Promise<AwsPlatformImages> {
	const { manifest, release } = run
	const bytes = new TextEncoder().encode(run.manifest.json)
	if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
		throw new Error("aws: the platform proxy's manifest is not the one its digest names")
	}
	const proxy: AwsPlatformImage = { kind: 'proxy', manifestSha256: manifest.sha256, trustedProxies: trustedProxies(run.state) }
	if ((await run.ecr.findImage(AWS_PLATFORM_PROXY_REPOSITORY, { tag: awsPlatformImageTag(release.commitSha, proxy) }, run.signal)) === null) {
		await run.manifestWriter(awsPlatformManifestKey(release.commitSha, manifest.sha256)).complete(
			{ last: bytes, parts: 1, bytes: bytes.byteLength },
			run.signal,
		)
		run.log("aws: wrote the platform proxy's manifest beside the release")
	}
	const [services, proxied] = await Promise.all([imageDigest(run, { kind: 'services' }), imageDigest(run, proxy)])
	return { services, proxy: proxied }
}

/** One image's digest: the one its tag holds, or the one a build of it pushed. */
async function imageDigest(run: AwsImagesBuildRun, image: AwsPlatformImage): Promise<string> {
	const { release, signal, log } = run
	const repository = image.kind === 'services' ? AWS_SERVICES_REPOSITORY : AWS_PLATFORM_PROXY_REPOSITORY
	const tag = awsPlatformImageTag(release.commitSha, image)
	const found = await run.ecr.findImage(repository, { tag }, signal)
	if (found !== null) {
		log(`aws: the ${image.kind} image ${tag} is built`)
		return found.digest
	}
	const token = awsImageBuildToken(tag, image.kind)
	const start = awsImagesBuildStart({
		accountId: run.state.plan.accountId,
		region: run.state.plan.region,
		repository: release.repository,
		commitSha: release.commitSha,
		image,
		token,
	})
	let build = await run.codeBuild.findBuild(AWS_IMAGES_PROJECT, token, signal)
	for (let attempt = 1;; attempt += 1) {
		if (build === null || (build.status !== 'in_progress' && build.status !== 'succeeded')) {
			build = await run.codeBuild.startBuild(start, signal)
			log(`aws: building the ${image.kind} image ${tag} (${build.id})`)
		} else {
			log(`aws: following the ${image.kind} image's build ${build.id}, which an earlier run started`)
		}
		const ended = await untilEnded(run, build)
		const pushed = ended.status === 'succeeded' ? await run.ecr.findImage(repository, { tag }, signal) : null
		if (pushed !== null) {
			log(`aws: the ${image.kind} image ${tag} is built`)
			return pushed.digest
		}
		const where = ended.log === null ? 'its build' : `the log ${ended.log.group} ${ended.log.stream}`
		if (attempt >= 2) throw new Error(`aws: building the ${image.kind} image ${tag} ended ${ended.status} without the image; ${where} says why`)
		log(`aws: the ${image.kind} image's build ${ended.id} ended ${ended.status} without the image; starting it again`)
		build = null
	}
}

/** The build once it no longer runs; a read refused for rate is read again at the next poll. */
async function untilEnded(run: AwsImagesBuildRun, build: CodeBuildBuild): Promise<CodeBuildBuild> {
	const now = run.now ?? Date.now
	const giveUpAt = now() + BUILD_WAIT_MS
	let current = build
	while (current.status === 'in_progress') {
		if (now() >= giveUpAt) throw new Error(`aws: the build ${build.id} did not end within ${BUILD_WAIT_MS / 60_000} minutes`)
		await run.sleep(AWS_IMAGES_POLL_MS, run.signal)
		const read = await readAgainLater(() => run.codeBuild.getBuild(build.id, run.signal))
		if (read === null) throw new Error(`aws: the build ${build.id} is gone before it ended`)
		if (read !== UNREAD) current = read
	}
	return current
}
