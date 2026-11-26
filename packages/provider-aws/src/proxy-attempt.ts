// The start of a namespace proxy's build (the AWS idea's checklist, step 10): the namespace's pinned proxy commit and
// the manifest of its members, uploaded as one archive, and a build of the namespace's own project started over it
// (`proxy-build.ts`), each step recorded in the namespace's target before the next (ADR-0044).
//
// - The attempt is the manifest's: its token and the manifest's sha256 are recorded first, before anything of it is
//   written. A manifest that changed since starts a new attempt under a new token; the same manifest resumes the
//   recorded one.
// - The upload: Control streams the pinned commit with the manifest appended at `proxy.manifest.json` (ADR-0045) into
//   the sources bucket, under the namespace's own prefix and the attempt's token, and answers the commit and the
//   manifest's sha256, both checked against what was asked.
// - The start: the presigned read goes into a SecureString under the namespace's `builds/` path, and the build starts
//   with the token as its idempotency token; its id is recorded once CodeBuild answered.
// - Recovery: an attempt recorded without a build id is first looked for by its token (`findBuild`), never started
//   blindly; only when no build carries the token are the upload and the start sent again, under the same token, so a
//   repeat inside CodeBuild's five minutes answers the same build. A repeat past them that still meets a build started
//   under the token cannot push a second image: the repository's tags are immutable and the tag is the token's.
// - A failure is a namespace error as Control records it (`namespaceFailure`), never an error object.
//
// - Following the build (`followAwsProxyBuild`): a build still running answers `pending`; one that succeeded records
//   the pushed image's digest (read from ECR by the attempt's tag, never from the build's log) with the manifest it was
//   built from, and clears the attempt; one that failed, or is gone, clears the attempt and fails with a stable code.
//   Either end deletes the attempt's URL parameter. A namespace whose image is of the current manifest starts nothing.
// - URL parameters: Parameter Store keeps one until it is deleted (only the URL in it expires, after
//   `AWS_SOURCE_URL_SECONDS`). An attempt's goes when its build ends; a replaced attempt's when the start replaces it,
//   since its token is recorded nowhere after, and `listNames` reads one level only, so `builds/` cannot be listed for it.
//
// Not yet: the proxy's ECS service, and `republish`, which will call both. Nothing calls them yet.
//
// UNVERIFIED: StartBuild's idempotency window and the archive's layout as CodeBuild unpacks it follow the API reference
// and Control's archive tests; none was checked against an account.

import {
	type ProviderDeploymentNamespace,
	ProviderNamespaceError,
	type ProviderNamespaceEvents,
	type ProviderNamespaceMember,
} from '@fabrika/provider-contract'
import type { CodeBuildBuild, CodeBuildClient } from './aws/codebuild'
import type { EcrClient } from './aws/ecr'
import { type S3ObjectAddress, type S3PartWriter, s3PresignedGet } from './aws/s3'
import type { SsmClient } from './aws/ssm'
import { type AwsCredentialSource, AwsError } from './aws/transport'
import { awsImageTag } from './build'
import type { AwsAppTarget, AwsNamespaceTarget } from './codecs'
import { awsSourceUrlParameter } from './deploy'
import {
	type AwsNamespaceResources,
	awsNamespaceResources,
	awsNamespaceTargetEnvelope,
	type AwsProxySource,
	checkNamespaceTarget,
	namespaceFailure,
} from './namespace'
import { AWS_PROXY_MANIFEST_PATH, awsProxyBuildStart } from './proxy-build'
import { awsNamespaceProxyManifest } from './proxy-manifest'
import { AWS_SOURCE_URL_SECONDS } from './run-attempt'

/** The AWS calls the start of a proxy build makes. */
export interface AwsProxyBuildClients {
	readonly codeBuild: Pick<CodeBuildClient, 'startBuild' | 'findBuild'>
	readonly ssm: Pick<SsmClient, 'putSecret' | 'deleteSecret'>
	/** The part writer of an object in the sources bucket. */
	readonly s3PartWriter: (address: S3ObjectAddress) => S3PartWriter
	/** The credentials the build's presigned read is signed with. */
	readonly credentials: AwsCredentialSource
}

/** Control's upload of a platform commit with one data file, as the composition hands it. */
export interface AwsProxySourceUpload {
	upload(input: {
		readonly repository: { readonly owner: string; readonly name: string }
		readonly commitSha: string
		readonly dataFile: { readonly path: string; readonly contents: string }
		readonly parts: S3PartWriter
		readonly signal: AbortSignal
	}): Promise<{ readonly commitSha: string; readonly dataFileSha256?: string }>
}

export interface AwsProxyBuildAttemptInput {
	readonly namespace: ProviderDeploymentNamespace
	/** The namespace's members, read under its lease: the manifest is compiled from them. */
	readonly members: readonly ProviderNamespaceMember[]
	readonly installation: AwsAppTarget
	readonly proxySource: AwsProxySource
	/** The range Caddy trusts forwarding headers from: the VPC's, where the balancer's addresses are. */
	readonly trustedProxies: string
	readonly clients: AwsProxyBuildClients
	readonly source: AwsProxySourceUpload
	readonly events: ProviderNamespaceEvents
	readonly signal: AbortSignal
	/** The time the presigned read is signed at. */
	readonly now?: () => Date
	/** An attempt's token: a lowercase UUID. */
	readonly newToken?: () => string
}

/** The manifest a namespace's proxy is built with, as the archive carries it. */
export function awsProxyManifestFile(namespaceId: string, members: readonly ProviderNamespaceMember[]): string {
	return `${JSON.stringify(awsNamespaceProxyManifest(namespaceId, members), null, '\t')}\n`
}

/** The sha256 of `text`'s UTF-8 bytes, in lowercase hex, as Control's upload reports a data file's. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Whether the recorded image is of this manifest and these trusted ranges, with nothing newer in flight. */
export function awsProxyImageCurrent(target: AwsNamespaceTarget, manifestSha256: string, trustedProxies: string): boolean {
	return target.proxyBuildToken === undefined && target.proxyImageManifestSha256 === manifestSha256
		&& target.proxyImageTrustedProxies === trustedProxies
}

/** Whether the recorded build attempt is of this manifest and these trusted ranges. */
export function awsProxyBuildCurrent(target: AwsNamespaceTarget, manifestSha256: string, trustedProxies: string): boolean {
	return target.proxyBuildToken !== undefined && target.proxyBuildManifestSha256 === manifestSha256
		&& target.proxyBuildTrustedProxies === trustedProxies
}

/** How long deleting an attempt's URL parameter may take. */
const CLEANUP_TIMEOUT_MS = 10_000

/** The Parameter Store name of one attempt's presigned read, under the namespace's `builds/` path. */
function sourceUrlParameterOf(resources: AwsNamespaceResources, token: string): string {
	return awsSourceUrlParameter(`${resources.parameterPath}/builds`, token)
}

/** `target` without a proxy build in flight. */
function withoutBuild(target: AwsNamespaceTarget): AwsNamespaceTarget {
	const { proxyBuildToken: _token, proxyBuildManifestSha256: _manifest, proxyBuildId: _id, proxyBuildTrustedProxies: _trusted, ...rest } = target
	return rest
}

/**
 * `target` pinned to `commitSha`. The attempt and the image are keyed by the manifest alone, because the pin is theirs:
 * a moved pin drops both, so the next start builds the new commit instead of skipping it (an image of the same
 * manifest) or resuming an attempt of the old one. Every move of a pin goes through here (the operator's update, not
 * built, is to); an unchanged pin keeps both.
 */
export function withProxyPin(target: AwsNamespaceTarget, commitSha: string): AwsNamespaceTarget {
	if (commitSha === target.proxyCommitSha) return target
	const { proxyImageDigest: _digest, proxyImageManifestSha256: _manifest, proxyImageTrustedProxies: _trusted, ...rest } = withoutBuild(target)
	return { ...rest, proxyCommitSha: commitSha }
}

/**
 * Starts the build of the namespace's proxy from its pin and its members' manifest, and answers the namespace with the
 * attempt recorded; a namespace whose build of this manifest already started is answered as it is.
 */
export async function startAwsProxyBuild(input: AwsProxyBuildAttemptInput): Promise<ProviderDeploymentNamespace> {
	try {
		return await start(input)
	} catch (error) {
		throw namespaceFailure(error)
	}
}

async function start(input: AwsProxyBuildAttemptInput): Promise<ProviderDeploymentNamespace> {
	const { clients, installation, signal } = input
	let namespace = input.namespace
	const stored = checkNamespaceTarget(namespace, installation, input.proxySource)
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	const manifest = awsProxyManifestFile(namespace.id, input.members)
	const manifestSha256 = await sha256Hex(manifest)

	const record = async (target: AwsNamespaceTarget): Promise<AwsNamespaceTarget> => {
		namespace = { ...namespace, target: awsNamespaceTargetEnvelope(target) }
		await input.events.checkpoint(namespace)
		return target
	}

	// The image of this manifest and these trusted ranges is built, and nothing newer is in flight: there is nothing to start.
	if (awsProxyImageCurrent(stored, manifestSha256, input.trustedProxies)) return namespace
	let attempt: AwsNamespaceTarget
	if (stored.proxyBuildToken !== undefined && awsProxyBuildCurrent(stored, manifestSha256, input.trustedProxies)) {
		// This manifest's attempt is recorded: started, or to be found by its token before anything is sent again.
		if (stored.proxyBuildId !== undefined) return namespace
		const found = await clients.codeBuild.findBuild(resources.buildProject, stored.proxyBuildToken, signal)
		if (found !== null) {
			await record({ ...stored, proxyBuildId: found.id })
			return namespace
		}
		attempt = stored
	} else {
		const token = (input.newToken ?? (() => crypto.randomUUID()))()
		attempt = await record({
			...withoutBuild(stored),
			proxyBuildToken: token,
			proxyBuildManifestSha256: manifestSha256,
			proxyBuildTrustedProxies: input.trustedProxies,
		})
		// The attempt it replaces is of an older manifest, and its token is recorded nowhere once replaced: its URL
		// parameter goes now. Best effort; a build of it still queued then fails to fetch, and its image would be stale.
		// That build is not stopped: one already past its fetch runs to its end and pushes an image under its own tag, which
		// nothing reads (only the recorded attempt's tag is followed) and the repository's lifecycle rule expires.
		if (stored.proxyBuildToken !== undefined) {
			await clients.ssm.deleteSecret(sourceUrlParameterOf(resources, stored.proxyBuildToken), AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(() => false)
		}
	}
	const token = attempt.proxyBuildToken
	if (token === undefined) throw new Error('aws: the proxy build was not recorded before its upload')

	await input.events.boundary()
	const address: S3ObjectAddress = {
		bucket: installation.sourcesBucket,
		region: installation.region,
		accountId: installation.accountId,
		key: `${resources.sourcePrefix}/${token}.tar.gz`,
	}
	const [owner = '', name = ''] = attempt.proxyRepository.split('/')
	const uploaded = await input.source.upload({
		repository: { owner, name },
		commitSha: attempt.proxyCommitSha,
		dataFile: { path: AWS_PROXY_MANIFEST_PATH, contents: manifest },
		parts: clients.s3PartWriter(address),
		signal,
	})
	if (uploaded.commitSha !== attempt.proxyCommitSha || uploaded.dataFileSha256 !== manifestSha256) {
		throw new Error("aws: the proxy archive uploaded is not the namespace's pinned commit with this manifest")
	}

	const url = await s3PresignedGet(clients.credentials, address, (input.now ?? (() => new Date()))(), AWS_SOURCE_URL_SECONDS)
	const parameter = sourceUrlParameterOf(resources, token)
	await clients.ssm.putSecret(parameter, url, signal)

	await input.events.boundary()
	const buildStart = awsProxyBuildStart({
		project: resources.buildProject,
		buildToken: token,
		sourceUrlParameter: parameter,
		repositoryUri: `${installation.accountId}.dkr.ecr.${installation.region}.amazonaws.com/${resources.repository}`,
		trustedProxies: input.trustedProxies,
	})
	let started: CodeBuildBuild
	try {
		started = await clients.codeBuild.startBuild(buildStart, signal)
	} catch (error) {
		// A retryable failure may hide a start: only the token tells (ADR-0044), never a blind repeat.
		if (!(error instanceof AwsError) || !error.retryable) throw error
		const found = await clients.codeBuild.findBuild(resources.buildProject, token, signal)
		if (found === null) throw error
		started = found
	}
	await record({ ...attempt, proxyBuildId: started.id })
	return namespace
}

/** The calls that follow a proxy build to its end. */
export interface AwsProxyBuildFollowClients {
	readonly codeBuild: Pick<CodeBuildClient, 'getBuild'>
	readonly ecr: Pick<EcrClient, 'findImage'>
	readonly ssm: Pick<SsmClient, 'deleteSecret'>
}

export interface AwsProxyBuildFollowInput {
	readonly namespace: ProviderDeploymentNamespace
	readonly installation: AwsAppTarget
	readonly proxySource: AwsProxySource
	readonly clients: AwsProxyBuildFollowClients
	readonly events: ProviderNamespaceEvents
	readonly signal: AbortSignal
}

/** Where a namespace's proxy build stands: still running, or its image recorded. */
export interface AwsProxyBuildFollowed {
	readonly namespace: ProviderDeploymentNamespace
	readonly state: 'pending' | 'built'
}

/** The stable code of a proxy build that ended without an image, or that CodeBuild no longer knows. */
export const AWS_PROXY_BUILD_FAILED = 'awsProxyBuild'

/**
 * Reads the namespace's recorded proxy build once. Running, it answers `pending`; succeeded, it records the image the
 * build pushed under the attempt's tag; failed or gone, it clears the attempt and throws `AWS_PROXY_BUILD_FAILED`, which
 * is not retryable as it is: a new start builds again. A namespace with no build recorded answers `built` when its image
 * is recorded, and throws otherwise.
 */
export async function followAwsProxyBuild(input: AwsProxyBuildFollowInput): Promise<AwsProxyBuildFollowed> {
	try {
		return await follow(input)
	} catch (error) {
		throw namespaceFailure(error)
	}
}

async function follow(input: AwsProxyBuildFollowInput): Promise<AwsProxyBuildFollowed> {
	const { clients, signal } = input
	let namespace = input.namespace
	const stored = checkNamespaceTarget(namespace, input.installation, input.proxySource)
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	const token = stored.proxyBuildToken
	const buildId = stored.proxyBuildId
	const manifestSha256 = stored.proxyBuildManifestSha256
	if (token === undefined || buildId === undefined || manifestSha256 === undefined) {
		if (token === undefined && stored.proxyImageDigest !== undefined) return { namespace, state: 'built' }
		throw new Error("aws: the namespace's proxy has no build started to follow")
	}

	const record = async (target: AwsNamespaceTarget): Promise<void> => {
		namespace = { ...namespace, target: awsNamespaceTargetEnvelope(target) }
		await input.events.checkpoint(namespace)
	}
	// The build no longer needs its presigned read once it ended, whatever its verdict.
	const dropUrl = async (): Promise<void> => {
		await clients.ssm.deleteSecret(sourceUrlParameterOf(resources, token), AbortSignal.timeout(CLEANUP_TIMEOUT_MS)).catch(() => false)
	}
	const ended = async (reason: string): Promise<never> => {
		await dropUrl()
		await record(withoutBuild(stored))
		throw new ProviderNamespaceError(reason, AWS_PROXY_BUILD_FAILED, false)
	}

	const build = await clients.codeBuild.getBuild(buildId, signal)
	if (build === null) return await ended(`aws: the proxy build ${buildId} is not one CodeBuild knows any more; start it again`)
	if (build.status === 'in_progress') return { namespace, state: 'pending' }
	if (build.status !== 'succeeded') return await ended(`aws: the proxy build ${buildId} is ${build.status}`)

	// The digest from ECR by the attempt's own tag, never from the build's log, which the build's code writes.
	const tag = awsImageTag(token)
	const image = await clients.ecr.findImage(resources.repository, { tag }, signal)
	if (image === null) return await ended(`aws: the proxy build ${buildId} succeeded but pushed no image tagged ${tag}`)
	await dropUrl()
	await record({
		...withoutBuild(stored),
		proxyImageDigest: image.digest,
		proxyImageManifestSha256: manifestSha256,
		...(stored.proxyBuildTrustedProxies === undefined ? {} : { proxyImageTrustedProxies: stored.proxyBuildTrustedProxies }),
	})
	return { namespace, state: 'built' }
}
