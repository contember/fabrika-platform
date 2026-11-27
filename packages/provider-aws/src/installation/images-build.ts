// The release's two images (the AWS idea's checklist, step 11, the commands' step): what `applyAwsPlatform`'s `images`
// builds, or finds built, after the images' stack and before the setup's, with the operator's own credentials.
//
// - **The image is the answer, not a build's status.** Each image's tag holds everything its build bakes in (the
//   release's commit, and for the proxy the manifest's digest and the trusted ranges', `awsPlatformImageTag`), and its
//   repository's tags are immutable, so an image of that tag is that build. The tag is read before anything starts and
//   after every build ends, whatever its status: a build that failed because another one pushed the tag first still
//   leaves the image, and an upgrade or a resumed run that finds both builds nothing.
// - **The proxy's manifest first.** Its bytes go to the sources bucket under `platform/<commit>/<digest>/` before the
//   proxy's build starts, which fetches it and checks the digest (`images.ts`).
// - **A build found again by the image it builds.** A run that lost a build's answer, or stopped while it ran, finds
//   that build among the project's newest by its image variable (`findBuildsWith`) and follows it rather than starting
//   a second. Each start has an idempotency token of its own, so a start after a failure is a new build, never the
//   failed one answered again inside CodeBuild's five minutes.
// - **At most two starts per image and run.** A second build that ends without the image stops the run, naming its log.
// - **Both at once**, each awaited up to its queue and run limits. The first to fail stops the other.
//
// The answer is each image's digest, which every task definition names (`services.ts`), never a tag.
//
// UNVERIFIED: that a build CodeBuild still lists among a project's newest carries its variables in `BatchGetBuilds`,
// and the statuses, follow CodeBuild's API reference; none was checked against an account.

import { createHash } from 'node:crypto'
import type { CodeBuildBuild, CodeBuildClient } from '../aws/codebuild'
import type { EcrClient } from '../aws/ecr'
import type { S3PartWriter } from '../aws/s3'
import { awsTrustedProxies } from '../namespace'
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
	IMAGES_VARIABLES,
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
	readonly codeBuild: Pick<CodeBuildClient, 'startBuild' | 'findBuildsWith' | 'getBuild'>
	readonly ecr: Pick<EcrClient, 'findImage'>
	/** A writer of the object `key` in the sources bucket (`s3PartWriter` over the operator's credentials). */
	readonly manifestWriter: (key: string) => Pick<S3PartWriter, 'complete'>
	readonly signal: AbortSignal
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly log: (line: string) => void
	readonly now?: () => number
	/** A build's idempotency token, a new one per start: a lowercase UUID. */
	readonly newToken?: () => string
}

/** The most builds one run starts for one image, and the most builds it waits for (those it follows included). */
const MAX_STARTS = 2
const MAX_ROUNDS = 4

/** Builds, or finds built, the services' image and the platform proxy's, and answers their digests. */
export async function buildAwsPlatformImages(run: AwsImagesBuildRun): Promise<AwsPlatformImages> {
	const { manifest, release } = run
	const bytes = new TextEncoder().encode(run.manifest.json)
	if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
		throw new Error("aws: the platform proxy's manifest is not the one its digest names")
	}
	const proxy: AwsPlatformImage = { kind: 'proxy', manifestSha256: manifest.sha256, trustedProxies: awsTrustedProxies(run.state.platform) }
	if ((await run.ecr.findImage(AWS_PLATFORM_PROXY_REPOSITORY, { tag: awsPlatformImageTag(release.commitSha, proxy) }, run.signal)) === null) {
		await run.manifestWriter(awsPlatformManifestKey(release.commitSha, manifest.sha256)).complete(
			{ last: bytes, parts: 1, bytes: bytes.byteLength },
			run.signal,
		)
		run.log("aws: wrote the platform proxy's manifest beside the release")
	}
	// The first image to fail stops the other's wait, so nothing of this run goes on once it has failed.
	const both = new AbortController()
	const stopBoth = () => both.abort(run.signal.reason)
	run.signal.addEventListener('abort', stopBoth, { once: true })
	const scoped: AwsImagesBuildRun = { ...run, signal: both.signal }
	const failingBoth = (digest: Promise<string>) =>
		digest.catch((error: unknown) => {
			both.abort(error)
			throw error
		})
	try {
		const [services, proxied] = await Promise.all([failingBoth(imageDigest(scoped, { kind: 'services' })), failingBoth(imageDigest(scoped, proxy))])
		return { services, proxy: proxied }
	} finally {
		run.signal.removeEventListener('abort', stopBoth)
	}
}

/** One image's digest: the one its tag holds, or the one a build of it pushed. */
async function imageDigest(run: AwsImagesBuildRun, image: AwsPlatformImage): Promise<string> {
	const { release, signal, log } = run
	const newToken = run.newToken ?? (() => crypto.randomUUID())
	const repository = image.kind === 'services' ? AWS_SERVICES_REPOSITORY : AWS_PLATFORM_PROXY_REPOSITORY
	const tag = awsPlatformImageTag(release.commitSha, image)
	const startOf = (token: string) =>
		awsImagesBuildStart({
			accountId: run.state.plan.accountId,
			region: run.state.plan.region,
			repository: release.repository,
			commitSha: release.commitSha,
			image,
			token,
		})
	// The image variable names the repository and the tag: what finds every build of this image.
	const variable = startOf(newToken()).variables[IMAGES_VARIABLES.image]
	const imageReference = variable !== undefined && 'value' in variable ? variable.value : ''
	let starts = 0
	let last: CodeBuildBuild | null = null
	for (let round = 1;; round += 1) {
		signal.throwIfAborted()
		const found = await run.ecr.findImage(repository, { tag }, signal)
		if (found !== null) {
			log(`aws: the ${image.kind} image ${tag} is built`)
			return found.digest
		}
		if (last !== null) log(`aws: the ${image.kind} image's build ${last.id} ended ${last.status} without the image`)
		const builds = await run.codeBuild.findBuildsWith(AWS_IMAGES_PROJECT, IMAGES_VARIABLES.image, imageReference, signal)
		const running = builds.find((build) => build.status === 'in_progress')
		let build: CodeBuildBuild
		if (running !== undefined && round < MAX_ROUNDS) {
			build = running
			log(`aws: following the ${image.kind} image's build ${build.id}, which an earlier run started`)
		} else {
			if (starts >= MAX_STARTS || round >= MAX_ROUNDS) {
				const where = last === null || last.log === null ? 'its build' : `the log ${last.log.group} ${last.log.stream}`
				throw new Error(`aws: building the ${image.kind} image ${tag} ended ${last?.status ?? 'unknown'} without the image; ${where} says why`)
			}
			starts += 1
			build = await run.codeBuild.startBuild(startOf(newToken()), signal)
			log(`aws: building the ${image.kind} image ${tag} (${build.id})`)
		}
		last = await untilEnded(run, build)
	}
}

/** The build once it no longer runs; a read refused for rate is read again at the next poll. */
async function untilEnded(run: AwsImagesBuildRun, build: CodeBuildBuild): Promise<CodeBuildBuild> {
	const now = run.now ?? Date.now
	const giveUpAt = now() + BUILD_WAIT_MS
	let current = build
	while (current.status === 'in_progress') {
		run.signal.throwIfAborted()
		if (now() >= giveUpAt) throw new Error(`aws: the build ${build.id} did not end within ${BUILD_WAIT_MS / 60_000} minutes`)
		await run.sleep(AWS_IMAGES_POLL_MS, run.signal)
		const read = await readAgainLater(() => run.codeBuild.getBuild(build.id, run.signal))
		if (read === null) throw new Error(`aws: the build ${build.id} is gone before it ended`)
		if (read !== UNREAD) current = read
	}
	return current
}
