// A namespace proxy's republish over one fake of every call it makes: started and left unsettled; followed to its
// image and the service set; a recorded image set at once; and the reconcile that carries on work in flight, settling
// it or failing retryably when the wait runs out.

import { contractDigest } from '@fabrika/auth-core'
import type {
	ProviderApprovedAccess,
	ProviderDeploymentNamespace,
	ProviderNamespaceCapabilities,
	ProviderNamespaceMember,
} from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { CodeBuildBuild } from '../aws/codebuild'
import type { EcsService } from '../aws/ecs'
import type { S3PartWriter } from '../aws/s3'
import { awsAppArtifactCodec, type AwsAppTarget, type AwsNamespaceTarget, awsNamespaceTargetCodec } from '../codecs'
import { awsNamespaceTargetEnvelope } from '../namespace'
import { awsProxyManifestFile, sha256Hex } from '../proxy-attempt'
import { AWS_PROXY_PENDING, type AwsProxyRepublishContext, republishAwsProxy, withAwsProxyRepublish } from '../proxy-republish'

const installation: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	sourcesBucket: 'fabrika-sources-123456789012',
}
const PROXY_SOURCE = { repository: { owner: 'contember', name: 'fabrika-platform' }, commitSha: '0123456789abcdef0123456789abcdef01234567' }
const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const BUILD_ID = `fabrika_ns_shared_prod:${TOKEN}`
const DIGEST = `sha256:${'b'.repeat(64)}`
const STACK_ID = 'arn:aws:cloudformation:eu-central-1:123456789012:stack/fabrika-ns-6-shared-prod/0f1e2d3c'
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
const MEMBERS: readonly ProviderNamespaceMember[] = [{
	appId: 'notes',
	env: 'prod',
	domain: 'notes.example.com',
	artifact: { provider: 'aws', version: 1, payload: awsAppArtifactCodec.encode({ contractDigest: contractDigest(contract), healthPath: '/healthz' }) },
	access,
	proxySecret: 'notes-proxy-secret',
}]
const MANIFEST = await sha256Hex(awsProxyManifestFile('shared', MEMBERS))

const service: EcsService = {
	name: 'ns_shared_prod_proxy',
	arn: 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/ns_shared_prod_proxy',
	status: 'active',
	taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/ns_shared_prod_proxy:1',
	deployments: [],
	currentDeploymentArn: null,
	network: null,
	events: [],
}

/** One fake of every call: the build answers `pending` for its first `pendingReads` reads, then succeeded. */
class Fake {
	readonly calls: string[] = []
	pendingReads = 0
	sleeps = 0
	clock = 0
	readonly context: AwsProxyRepublishContext = {
		installation,
		proxySource: PROXY_SOURCE,
		network: { vpcId: 'vpc-0123456789abcdef0', subnets: ['subnet-0123456789abcdef0'], publicIp: true },
		runtime: {
			iam: { issuer: 'https://iam.example.com', key: 'proxy-iam-key' },
			clients: {
				codeBuild: {
					startBuild: async (start) => {
						this.calls.push('startBuild')
						return { id: `${start.project}:${start.token}`, status: 'in_progress', phase: 'QUEUED', log: null }
					},
					findBuild: async () => null,
					getBuild: async (id): Promise<CodeBuildBuild> => {
						this.calls.push('getBuild')
						const pending = this.pendingReads > 0
						this.pendingReads -= 1
						return { id, status: pending ? 'in_progress' : 'succeeded', phase: null, log: null }
					},
				},
				ecr: {
					findImage: async () => {
						this.calls.push('findImage')
						return { digest: DIGEST, tags: [`run-${TOKEN}`], pushedAt: new Date() }
					},
				},
				ecs: {
					registerTaskDefinition: async (definition) => {
						this.calls.push('registerTaskDefinition')
						return { arn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/ns_shared_prod_proxy:1', family: definition.family, revision: 1 }
					},
					createService: async () => {
						this.calls.push('createService')
						return service
					},
					updateService: async () => service,
					describeService: async () => null,
				},
				ssm: { putSecret: async () => 1, deleteSecret: async () => true },
				s3PartWriter: (): S3PartWriter => ({ partBytes: 8 * 1024 * 1024, writePart: async () => {}, complete: async () => {}, abort: async () => {} }),
				cloudFormation: {
					findStack: async () => ({ stackId: STACK_ID, status: 'CREATE_COMPLETE' }),
					describeStack: async (stackId) => ({
						stackId,
						status: 'CREATE_COMPLETE',
						outputs: {
							ProxySecurityGroupId: 'sg-0123456789abcdef7',
							ServiceConnectNamespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-abcdefghij123456',
						},
					}),
				},
			},
			credentials: () => ({ current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session' }) }),
			source: {
				upload: async (upload) => {
					this.calls.push('upload')
					return { commitSha: upload.commitSha, dataFileSha256: await sha256Hex(upload.dataFile.contents) }
				},
			},
			sleep: async (ms) => {
				this.sleeps += 1
				this.clock += ms
			},
			now: () => this.clock,
			pollIntervalMs: 10_000,
			waitMs: 30_000,
		},
	}
	readonly events = { checkpoint: async () => {}, boundary: async () => {} }
	readonly signal = new AbortController().signal
}

const decoded = (namespace: ProviderDeploymentNamespace): AwsNamespaceTarget => awsNamespaceTargetCodec.decode(namespace.target.payload)

describe('republishAwsProxy', () => {
	test("'started' starts the build of the members' manifest and answers unsettled", async () => {
		const fake = new Fake()
		const result = await republishAwsProxy(fake.context, {
			namespace: namespaceOf(PINNED),
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'started',
		})
		expect(result.settled).toBe(false)
		expect(fake.calls).toEqual(['upload', 'startBuild'])
		expect(decoded(result.namespace)).toMatchObject({
			proxyBuildManifestSha256: MANIFEST,
			proxyBuildId: expect.stringContaining('fabrika_ns_shared_prod:'),
		})
	})

	test("'active' follows the build, polling, to its image and sets the service", async () => {
		const fake = new Fake()
		fake.pendingReads = 2
		const result = await republishAwsProxy(fake.context, {
			namespace: namespaceOf(PINNED),
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'active',
		})
		expect(result.settled).toBe(true)
		expect(fake.calls).toEqual(['upload', 'startBuild', 'getBuild', 'getBuild', 'getBuild', 'findImage', 'registerTaskDefinition', 'createService'])
		expect(fake.sleeps).toBe(2)
		expect(decoded(result.namespace)).toMatchObject({ proxyImageDigest: DIGEST, proxyImageManifestSha256: MANIFEST, proxyServiceUpdated: true })
		expect(decoded(result.namespace).proxyBuildToken).toBeUndefined()
	})

	test('an image of the current manifest is set at once, with no build', async () => {
		const fake = new Fake()
		const built = namespaceOf({ ...PINNED, proxyImageDigest: DIGEST, proxyImageManifestSha256: MANIFEST })
		const result = await republishAwsProxy(fake.context, {
			namespace: built,
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'started',
		})
		expect(result.settled).toBe(true)
		expect(fake.calls).toEqual(['registerTaskDefinition', 'createService'])
	})

	test("a build still running when 'active' runs out of time answers unsettled", async () => {
		const fake = new Fake()
		fake.pendingReads = 100
		const result = await republishAwsProxy(fake.context, {
			namespace: namespaceOf(PINNED),
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'active',
		})
		expect(result.settled).toBe(false)
		expect(fake.calls).not.toContain('findImage')
	})
})

describe('withAwsProxyRepublish', () => {
	const base = (seen: string[]): ProviderNamespaceCapabilities => ({
		normalize: (namespace) => namespace,
		namespaceResourceClaims: () => [],
		registrationResourceClaims: () => [],
		provision: async (input) => {
			seen.push('provision')
			return input.namespace
		},
		reconcile: async (input) => {
			seen.push('reconcile')
			return input.namespace
		},
	})
	const mutation = (namespace: ProviderDeploymentNamespace, fake: Fake) => ({ namespace, members: MEMBERS, signal: fake.signal, events: fake.events })

	test('provision stays the stack alone, and a reconcile with nothing in flight calls nothing of the proxy', async () => {
		const fake = new Fake()
		const seen: string[] = []
		const capabilities = withAwsProxyRepublish(base(seen), fake.context)
		await capabilities.provision(mutation(namespaceOf(PINNED), fake))
		await capabilities.reconcile(mutation(namespaceOf(PINNED), fake))
		expect(seen).toEqual(['provision', 'reconcile'])
		expect(fake.calls).toEqual([])
		expect(capabilities.republish).toBeDefined()
	})

	test('a reconcile carries on a build in flight: to the service when it ends, or a retryable failure when it does not', async () => {
		const inFlight = namespaceOf({ ...PINNED, proxyBuildToken: TOKEN, proxyBuildManifestSha256: MANIFEST, proxyBuildId: BUILD_ID })
		const settles = new Fake()
		const reconciled = await withAwsProxyRepublish(base([]), settles.context).reconcile(mutation(inFlight, settles))
		expect(decoded(reconciled)).toMatchObject({ proxyImageDigest: DIGEST, proxyServiceUpdated: true })

		const stays = new Fake()
		stays.pendingReads = 100
		await expect(withAwsProxyRepublish(base([]), stays.context).reconcile(mutation(inFlight, stays))).rejects.toMatchObject({
			code: AWS_PROXY_PENDING,
			retryable: true,
		})
	})

	test("republish answers Control's result, settled only once the service is set", async () => {
		const fake = new Fake()
		const capabilities = withAwsProxyRepublish(base([]), fake.context)
		const result = await capabilities.republish?.({ ...mutation(namespaceOf(PINNED), fake), wait: 'started' })
		expect(result?.settled).toBe(false)
	})
})
