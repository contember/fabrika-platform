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
// Not yet: following the build to its end (its log, its verdict, the URL parameter's deletion, the image's digest), the
// proxy's ECS service, and `republish`, which will call this. Nothing calls it yet. Until then an attempt's URL
// parameter stays in Parameter Store, and so does that of an attempt a changed manifest replaced before its build was
// recorded: the URL in it stops opening the archive after `AWS_SOURCE_URL_SECONDS`, but the parameter itself is not
// deleted. The step that follows the build is to delete its own attempt's, and every other one under the namespace's
// `builds/` path by listing it: a replaced attempt's token is no longer recorded anywhere.
//
// UNVERIFIED: StartBuild's idempotency window and the archive's layout as CodeBuild unpacks it follow the API reference
// and Control's archive tests; none was checked against an account.

import type { ProviderDeploymentNamespace, ProviderNamespaceEvents, ProviderNamespaceMember } from '@fabrika/provider-contract'
import type { CodeBuildBuild, CodeBuildClient } from './aws/codebuild'
import { type S3ObjectAddress, type S3PartWriter, s3PresignedGet } from './aws/s3'
import type { SsmClient } from './aws/ssm'
import { type AwsCredentialSource, AwsError } from './aws/transport'
import type { AwsAppTarget, AwsNamespaceTarget } from './codecs'
import { awsSourceUrlParameter } from './deploy'
import { awsNamespaceResources, awsNamespaceTargetEnvelope, type AwsProxySource, checkNamespaceTarget, namespaceFailure } from './namespace'
import { AWS_PROXY_MANIFEST_PATH, awsProxyBuildStart } from './proxy-build'
import { awsNamespaceProxyManifest } from './proxy-manifest'
import { AWS_SOURCE_URL_SECONDS } from './run-attempt'

/** The AWS calls the start of a proxy build makes. */
export interface AwsProxyBuildClients {
	readonly codeBuild: Pick<CodeBuildClient, 'startBuild' | 'findBuild'>
	readonly ssm: Pick<SsmClient, 'putSecret'>
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

/** `target` without a proxy build in flight. */
function withoutBuild(target: AwsNamespaceTarget): AwsNamespaceTarget {
	const { proxyBuildToken: _token, proxyBuildManifestSha256: _manifest, proxyBuildId: _id, ...rest } = target
	return rest
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

	let attempt: AwsNamespaceTarget
	if (stored.proxyBuildToken !== undefined && stored.proxyBuildManifestSha256 === manifestSha256) {
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
		attempt = await record({ ...withoutBuild(stored), proxyBuildToken: token, proxyBuildManifestSha256: manifestSha256 })
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
	const parameter = awsSourceUrlParameter(`${resources.parameterPath}/builds`, token)
	await clients.ssm.putSecret(parameter, url, signal)

	await input.events.boundary()
	const buildStart = awsProxyBuildStart({
		project: resources.buildProject,
		buildToken: token,
		sourceUrlParameter: parameter,
		repositoryUri: `${installation.accountId}.dkr.ecr.${installation.region}.amazonaws.com/${resources.repository}`,
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
