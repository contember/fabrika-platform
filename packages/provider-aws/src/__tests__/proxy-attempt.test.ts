// The start of a namespace proxy's build over a fake of its calls: the attempt recorded before anything is written, the
// pinned commit uploaded with the members' manifest, the presigned read in a SecureString, the build started under the
// attempt's token and its id recorded; a recorded attempt found by its token before anything is sent again; a changed
// manifest starting a new attempt; and every failure a namespace error, never an error object.

import { contractDigest } from '@fabrika/auth-core'
import type { ProviderApprovedAccess, ProviderDeploymentNamespace, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { CodeBuildBuild, CodeBuildStart } from '../aws/codebuild'
import type { EcrImage, EcrImageReference } from '../aws/ecr'
import type { S3PartWriter } from '../aws/s3'
import { AwsError } from '../aws/transport'
import { awsAppArtifactCodec, type AwsAppTarget, type AwsNamespaceTarget, awsNamespaceTargetCodec } from '../codecs'
import { awsNamespaceTargetEnvelope } from '../namespace'
import { AWS_PROXY_BUILD_FAILED, awsProxyManifestFile, followAwsProxyBuild, sha256Hex, startAwsProxyBuild, withProxyPin } from '../proxy-attempt'
import { AWS_PROXY_BUILDSPEC } from '../proxy-build'

const installation: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	sourcesBucket: 'fabrika-sources-123456789012',
}
const PROXY_SOURCE = { repository: { owner: 'contember', name: 'fabrika-platform' }, commitSha: '0123456789abcdef0123456789abcdef01234567' }
const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const SECOND_TOKEN = '1a2b3c4d-5e6f-4a5b-8c7d-9e8f7a6b5c4d'
const BUILD_ID = `fabrika_ns_shared_prod:${TOKEN}`
const PARAMETER = `/fabrika/namespaces/shared/prod/builds/${TOKEN}/source-url`

const PINNED: AwsNamespaceTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	stackName: 'fabrika-ns-6-shared-prod',
	sizing: 'cheap',
	proxyRepository: 'contember/fabrika-platform',
	proxyCommitSha: PROXY_SOURCE.commitSha,
}
const namespaceOf = (target: AwsNamespaceTarget): ProviderDeploymentNamespace => ({
	id: 'shared',
	env: 'prod',
	target: awsNamespaceTargetEnvelope(target),
})

const contract = { ...notesArtifact, tables: {}, jobs: {}, files: {}, fileKinds: {} }
const access: ProviderApprovedAccess = { contract, contractDigest: contractDigest(contract), schema: schemaFromContract(contract), checker: '0.9.1' }
const member = (change: Partial<ProviderNamespaceMember> = {}): ProviderNamespaceMember => ({
	appId: 'notes',
	env: 'prod',
	domain: 'notes.example.com',
	artifact: { provider: 'aws', version: 1, payload: awsAppArtifactCodec.encode({ contractDigest: contractDigest(contract), healthPath: '/healthz' }) },
	access,
	...change,
})
const MEMBERS = [member()]

const build = (id: string): CodeBuildBuild => ({ id, status: 'in_progress', phase: 'QUEUED', log: null })

/** A fake of the calls: what each received, in order, and every checkpoint the attempt recorded. */
class Fake {
	readonly calls: string[] = []
	readonly checkpoints: AwsNamespaceTarget[] = []
	readonly starts: CodeBuildStart[] = []
	uploadedCommit = PROXY_SOURCE.commitSha
	uploadedManifest: string | null = null
	found: CodeBuildBuild | null = null
	startFails: AwsError | null = null
	tokens = [TOKEN, SECOND_TOKEN]

	input(namespace: ProviderDeploymentNamespace, members: readonly ProviderNamespaceMember[] = MEMBERS) {
		return {
			namespace,
			members,
			installation,
			proxySource: PROXY_SOURCE,
			clients: {
				codeBuild: {
					startBuild: async (start: CodeBuildStart) => {
						this.calls.push(`startBuild ${start.project} ${start.token}`)
						this.starts.push(start)
						if (this.startFails !== null) throw this.startFails
						return build(`${start.project}:${start.token}`)
					},
					findBuild: async (project: string, token: string) => {
						this.calls.push(`findBuild ${project} ${token}`)
						return this.found
					},
				},
				ssm: {
					putSecret: async (name: string, value: string) => {
						this.calls.push(`putSecret ${name} ${value.startsWith('https://') ? 'presigned' : 'other'}`)
						return 1
					},
					deleteSecret: async (name: string) => {
						this.calls.push(`deleteSecret ${name}`)
						return true
					},
				},
				s3PartWriter: (address: { readonly bucket: string; readonly key: string }): S3PartWriter => {
					this.calls.push(`s3PartWriter ${address.bucket} ${address.key}`)
					return { partBytes: 8 * 1024 * 1024, writePart: async () => {}, complete: async () => {}, abort: async () => {} }
				},
				credentials: { current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session' }) },
			},
			source: {
				upload: async (upload: {
					readonly repository: { readonly owner: string; readonly name: string }
					readonly commitSha: string
					readonly dataFile: { readonly path: string; readonly contents: string }
				}) => {
					this.calls.push(`upload ${upload.repository.owner}/${upload.repository.name}@${upload.commitSha} ${upload.dataFile.path}`)
					this.uploadedManifest = upload.dataFile.contents
					return { commitSha: this.uploadedCommit, dataFileSha256: await sha256Hex(upload.dataFile.contents) }
				},
			},
			events: {
				checkpoint: async (recorded: ProviderDeploymentNamespace) => {
					this.calls.push('checkpoint')
					this.checkpoints.push(awsNamespaceTargetCodec.decode(recorded.target.payload))
				},
				boundary: async () => {},
			},
			signal: new AbortController().signal,
			now: () => new Date('2026-11-26T08:00:00Z'),
			newToken: () => this.tokens.shift() ?? 'no-token-left',
		}
	}
}

describe('startAwsProxyBuild', () => {
	test("records the attempt, uploads the pin with the members' manifest, and starts the namespace's build under its token", async () => {
		const fake = new Fake()
		const manifestSha256 = await sha256Hex(awsProxyManifestFile('shared', MEMBERS))
		const started = await startAwsProxyBuild(fake.input(namespaceOf(PINNED)))
		expect(fake.calls).toEqual([
			// The token and the manifest's digest first, before anything of the attempt is written.
			'checkpoint',
			`s3PartWriter fabrika-sources-123456789012 sources/_namespaces/shared/prod/${TOKEN}.tar.gz`,
			`upload contember/fabrika-platform@${PROXY_SOURCE.commitSha} proxy.manifest.json`,
			`putSecret ${PARAMETER} presigned`,
			`startBuild fabrika_ns_shared_prod ${TOKEN}`,
			'checkpoint',
		])
		expect(fake.checkpoints).toEqual([
			{ ...PINNED, proxyBuildToken: TOKEN, proxyBuildManifestSha256: manifestSha256 },
			{ ...PINNED, proxyBuildToken: TOKEN, proxyBuildManifestSha256: manifestSha256, proxyBuildId: BUILD_ID },
		])
		expect(awsNamespaceTargetCodec.decode(started.target.payload)).toEqual({
			...PINNED,
			proxyBuildToken: TOKEN,
			proxyBuildManifestSha256: manifestSha256,
			proxyBuildId: BUILD_ID,
		})
		// The manifest is the members' compile; the start is the proxy's, the presigned read by its parameter only.
		expect(fake.uploadedManifest).toBe(awsProxyManifestFile('shared', MEMBERS))
		expect(fake.starts[0]).toMatchObject({
			buildspec: AWS_PROXY_BUILDSPEC,
			variables: {
				FABRIKA_SOURCE_URL: { parameter: PARAMETER },
				FABRIKA_IMAGE: { value: `123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/namespaces/shared/prod/proxy:run-${TOKEN}` },
			},
		})
	})

	test('a namespace whose build of this manifest started is answered as it is, with no call', async () => {
		const fake = new Fake()
		const manifestSha256 = await sha256Hex(awsProxyManifestFile('shared', MEMBERS))
		const started = namespaceOf({ ...PINNED, proxyBuildToken: TOKEN, proxyBuildManifestSha256: manifestSha256, proxyBuildId: BUILD_ID })
		expect(await startAwsProxyBuild(fake.input(started))).toEqual(started)
		expect(fake.calls).toEqual([])
	})

	test('a recorded attempt without a build id is found by its token first, and sent again under it only when none carries it', async () => {
		const manifestSha256 = await sha256Hex(awsProxyManifestFile('shared', MEMBERS))
		const recorded = namespaceOf({ ...PINNED, proxyBuildToken: TOKEN, proxyBuildManifestSha256: manifestSha256 })

		const found = new Fake()
		found.found = build(BUILD_ID)
		await startAwsProxyBuild(found.input(recorded))
		expect(found.calls).toEqual([`findBuild fabrika_ns_shared_prod ${TOKEN}`, 'checkpoint'])
		expect(found.checkpoints).toEqual([{ ...PINNED, proxyBuildToken: TOKEN, proxyBuildManifestSha256: manifestSha256, proxyBuildId: BUILD_ID }])

		const lost = new Fake()
		await startAwsProxyBuild(lost.input(recorded))
		// No new token: the upload and the start go again under the recorded one.
		expect(lost.calls).toEqual([
			`findBuild fabrika_ns_shared_prod ${TOKEN}`,
			`s3PartWriter fabrika-sources-123456789012 sources/_namespaces/shared/prod/${TOKEN}.tar.gz`,
			`upload contember/fabrika-platform@${PROXY_SOURCE.commitSha} proxy.manifest.json`,
			`putSecret ${PARAMETER} presigned`,
			`startBuild fabrika_ns_shared_prod ${TOKEN}`,
			'checkpoint',
		])
		expect(lost.tokens).toEqual([TOKEN, SECOND_TOKEN])
	})

	test('a manifest that changed since the recorded attempt starts a new one under a new token, the pin kept', async () => {
		const fake = new Fake()
		fake.tokens = [SECOND_TOKEN]
		const older = 'fedcba9876543210fedcba9876543210fedcba98'
		const recorded = namespaceOf({
			...PINNED,
			proxyCommitSha: older,
			proxyBuildToken: TOKEN,
			proxyBuildManifestSha256: 'f'.repeat(64),
			proxyBuildId: BUILD_ID,
		})
		fake.uploadedCommit = older
		await startAwsProxyBuild(fake.input(recorded))
		expect(fake.checkpoints[0]).toEqual({
			...PINNED,
			proxyCommitSha: older,
			proxyBuildToken: SECOND_TOKEN,
			proxyBuildManifestSha256: await sha256Hex(awsProxyManifestFile('shared', MEMBERS)),
		})
		// The namespace's own pin, an older commit than the installation's default, is what is uploaded.
		expect(fake.calls).toContain(`upload contember/fabrika-platform@${older} proxy.manifest.json`)
		expect(fake.calls).toContain(`startBuild fabrika_ns_shared_prod ${SECOND_TOKEN}`)
		// The replaced attempt's URL parameter goes as it is replaced: its token is recorded nowhere after.
		expect(fake.calls.slice(0, 2)).toEqual(['checkpoint', `deleteSecret ${PARAMETER}`])
	})

	test('a namespace whose image is of the current manifest starts nothing', async () => {
		const fake = new Fake()
		const built = namespaceOf({
			...PINNED,
			proxyImageDigest: `sha256:${'a'.repeat(64)}`,
			proxyImageManifestSha256: await sha256Hex(awsProxyManifestFile('shared', MEMBERS)),
		})
		expect(await startAwsProxyBuild(fake.input(built))).toEqual(built)
		expect(fake.calls).toEqual([])
		// A member changed: the image is of an older manifest, so a build starts, the image kept until the new one is pushed.
		await startAwsProxyBuild(fake.input(built, [member({ domain: 'notes.example.org' })]))
		expect(fake.checkpoints[0]?.proxyImageDigest).toBe(`sha256:${'a'.repeat(64)}`)
		expect(fake.calls).toContain(`startBuild fabrika_ns_shared_prod ${TOKEN}`)
	})

	test('a lost start is settled by the token: found, it is recorded; not found, the failure stands', async () => {
		const found = new Fake()
		found.startFails = new AwsError('StartBuild', 'ServiceUnavailable', 503, null, true)
		found.found = build(BUILD_ID)
		await startAwsProxyBuild(found.input(namespaceOf(PINNED)))
		expect(found.checkpoints.at(-1)?.proxyBuildId).toBe(BUILD_ID)
		expect(found.calls.slice(-3)).toEqual([`startBuild fabrika_ns_shared_prod ${TOKEN}`, `findBuild fabrika_ns_shared_prod ${TOKEN}`, 'checkpoint'])

		const lost = new Fake()
		lost.startFails = new AwsError('StartBuild', 'ServiceUnavailable', 503, null, true)
		const failure = await startAwsProxyBuild(lost.input(namespaceOf(PINNED))).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(ProviderNamespaceError)
		expect(failure).toMatchObject({ code: 'awsCall', retryable: true, message: 'aws: StartBuild failed (ServiceUnavailable)' })
		// The attempt stays recorded without a build id, for the next try to find by its token.
		expect(lost.checkpoints).toEqual([{
			...PINNED,
			proxyBuildToken: TOKEN,
			proxyBuildManifestSha256: await sha256Hex(awsProxyManifestFile('shared', MEMBERS)),
		}])
	})

	test('an upload that is not the pinned commit with this manifest, or a pin of another repository, starts no build', async () => {
		const wrong = new Fake()
		wrong.uploadedCommit = 'fedcba9876543210fedcba9876543210fedcba98'
		await expect(startAwsProxyBuild(wrong.input(namespaceOf(PINNED)))).rejects.toMatchObject({ code: 'awsStack' })
		expect(wrong.calls.some((call) => call.startsWith('putSecret') || call.startsWith('startBuild'))).toBe(false)

		const foreign = new Fake()
		const failure = await startAwsProxyBuild(foreign.input(namespaceOf({ ...PINNED, proxyRepository: 'someone/fabrika-platform' }))).catch((
			error: unknown,
		) => error)
		expect(failure).toBeInstanceOf(ProviderNamespaceError)
		expect(foreign.calls).toEqual([])
	})
})

describe('followAwsProxyBuild', () => {
	const DIGEST = `sha256:${'b'.repeat(64)}`
	const MANIFEST = 'c'.repeat(64)
	const started = namespaceOf({ ...PINNED, proxyBuildToken: TOKEN, proxyBuildManifestSha256: MANIFEST, proxyBuildId: BUILD_ID })

	/** A fake of the follow's calls: the build's answer, the image ECR answers, what each received. */
	const follow = (build: CodeBuildBuild | null, image: EcrImage | null = { digest: DIGEST, tags: [`run-${TOKEN}`], pushedAt: new Date() }) => {
		const calls: string[] = []
		const checkpoints: AwsNamespaceTarget[] = []
		const run = (namespace: ProviderDeploymentNamespace = started) =>
			followAwsProxyBuild({
				namespace,
				installation,
				proxySource: PROXY_SOURCE,
				clients: {
					codeBuild: {
						getBuild: async (id: string) => {
							calls.push(`getBuild ${id}`)
							return build
						},
					},
					ecr: {
						findImage: async (name: string, reference: EcrImageReference) => {
							calls.push(`findImage ${name} ${'tag' in reference ? reference.tag : reference.digest}`)
							return image
						},
					},
					ssm: {
						deleteSecret: async (name: string) => {
							calls.push(`deleteSecret ${name}`)
							return true
						},
					},
				},
				events: {
					checkpoint: async (recorded: ProviderDeploymentNamespace) => {
						calls.push('checkpoint')
						checkpoints.push(awsNamespaceTargetCodec.decode(recorded.target.payload))
					},
					boundary: async () => {},
				},
				signal: new AbortController().signal,
			})
		return { calls, checkpoints, run }
	}

	test('a build still running is pending, with nothing recorded or deleted', async () => {
		const fake = follow(build(BUILD_ID))
		expect(await fake.run()).toEqual({ namespace: started, state: 'pending' })
		expect(fake.calls).toEqual([`getBuild ${BUILD_ID}`])
	})

	test('a build that succeeded records the image ECR holds under the attempt tag, clears the attempt and drops its URL', async () => {
		const fake = follow({ ...build(BUILD_ID), status: 'succeeded' })
		const followed = await fake.run()
		expect(followed.state).toBe('built')
		expect(fake.calls).toEqual([
			`getBuild ${BUILD_ID}`,
			`findImage fabrika/namespaces/shared/prod/proxy run-${TOKEN}`,
			`deleteSecret ${PARAMETER}`,
			'checkpoint',
		])
		expect(fake.checkpoints).toEqual([{ ...PINNED, proxyImageDigest: DIGEST, proxyImageManifestSha256: MANIFEST }])
		expect(awsNamespaceTargetCodec.decode(followed.namespace.target.payload)).toEqual({
			...PINNED,
			proxyImageDigest: DIGEST,
			proxyImageManifestSha256: MANIFEST,
		})
		// Followed again, the image is recorded and nothing is in flight: built, with no call.
		const again = follow(null)
		expect((await again.run(followed.namespace)).state).toBe('built')
		expect(again.calls).toEqual([])
	})

	test('a build that failed, is gone, or pushed no image clears the attempt, drops its URL and fails with a stable code', async () => {
		const cases: readonly [CodeBuildBuild | null, EcrImage | null, string][] = [
			[{ ...build(BUILD_ID), status: 'failed' }, null, `aws: the proxy build ${BUILD_ID} is failed`],
			[{ ...build(BUILD_ID), status: 'timed_out' }, null, `aws: the proxy build ${BUILD_ID} is timed_out`],
			[null, null, 'is not one CodeBuild knows any more'],
			[{ ...build(BUILD_ID), status: 'succeeded' }, null, `pushed no image tagged run-${TOKEN}`],
		]
		for (const [answer, image, message] of cases) {
			const fake = follow(answer, image)
			const failure = await fake.run().catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(ProviderNamespaceError)
			expect(failure).toMatchObject({ code: AWS_PROXY_BUILD_FAILED, retryable: false })
			expect(failure instanceof Error ? failure.message : '').toContain(message)
			expect(fake.calls).toContain(`deleteSecret ${PARAMETER}`)
			// The pin stays; the attempt is cleared, so a new start builds again.
			expect(fake.checkpoints).toEqual([PINNED])
		}
	})

	test('a failed build keeps the image an earlier build recorded, so the proxy keeps running it', async () => {
		const prior = `sha256:${'d'.repeat(64)}`
		const fake = follow({ ...build(BUILD_ID), status: 'failed' })
		const building = namespaceOf({
			...PINNED,
			proxyImageDigest: prior,
			proxyImageManifestSha256: 'e'.repeat(64),
			proxyBuildToken: TOKEN,
			proxyBuildManifestSha256: MANIFEST,
			proxyBuildId: BUILD_ID,
		})
		await expect(fake.run(building)).rejects.toMatchObject({ code: AWS_PROXY_BUILD_FAILED })
		expect(fake.checkpoints).toEqual([{ ...PINNED, proxyImageDigest: prior, proxyImageManifestSha256: 'e'.repeat(64) }])
	})

	test('a moved pin drops the attempt and the image, so the next start builds the new commit', async () => {
		const older = 'fedcba9876543210fedcba9876543210fedcba98'
		const manifestSha256 = await sha256Hex(awsProxyManifestFile('shared', MEMBERS))
		const target: AwsNamespaceTarget = {
			...PINNED,
			proxyCommitSha: older,
			proxyImageDigest: `sha256:${'d'.repeat(64)}`,
			proxyImageManifestSha256: manifestSha256,
			proxyBuildToken: TOKEN,
			proxyBuildManifestSha256: manifestSha256,
			proxyBuildId: BUILD_ID,
		}
		expect(withProxyPin(target, older)).toEqual(target)
		const moved = withProxyPin(target, PROXY_SOURCE.commitSha)
		expect(moved).toEqual(PINNED)
		// The same manifest: without the drop the start would skip the build. With it, the new commit is built.
		const start = new Fake()
		await startAwsProxyBuild(start.input(namespaceOf(moved)))
		expect(start.calls).toContain(`upload contember/fabrika-platform@${PROXY_SOURCE.commitSha} proxy.manifest.json`)
	})

	test('a namespace with no build started and no image is refused, calling nothing', async () => {
		const fake = follow(null)
		await expect(fake.run(namespaceOf(PINNED))).rejects.toMatchObject({ message: "aws: the namespace's proxy has no build started to follow" })
		expect(fake.calls).toEqual([])
	})
})
