// A namespace proxy's republish over one fake of every call it makes: started and left unsettled; followed to its
// image and the service set; a recorded image set at once; and the reconcile that carries on work in flight, settling
// it or failing retryably when the wait runs out.

import { contractDigest, proxySecretVariable } from '@fabrika/auth-core'
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
import type { EcsService, EcsServiceDeploymentStatus } from '../aws/ecs'
import type { S3PartWriter } from '../aws/s3'
import { AwsError } from '../aws/transport'
import { awsAppArtifactCodec, type AwsAppTarget, type AwsNamespaceTarget, awsNamespaceTargetCodec } from '../codecs'
import { awsNamespaceTargetEnvelope } from '../namespace'
import { awsProxyManifestFile, sha256Hex } from '../proxy-attempt'
import { AWS_PROXY_PENDING, type AwsProxyRepublishContext, republishAwsProxy, withAwsProxyRepublish } from '../proxy-republish'
import { AWS_PROXY_ROLLOUT_FAILED, followAwsProxyRollout } from '../proxy-service'

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
const DEPLOYMENT_ARN = 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/ns_shared_prod_proxy/deployment1'
const REVISION = 'arn:aws:ecs:eu-central-1:123456789012:service-revision/fabrika-apps/ns_shared_prod_proxy/revision1'
const OLDER_REVISION = 'arn:aws:ecs:eu-central-1:123456789012:service-revision/fabrika-apps/ns_shared_prod_proxy/revision0'

/** One fake of every call: the build answers `pending` for its first `pendingReads` reads, then succeeded. */
class Fake {
	readonly calls: string[] = []
	pendingReads = 0
	created = false
	rollouts: (EcsServiceDeploymentStatus | 'unseen')[] = []
	current: EcsServiceDeploymentStatus | 'unseen' = 'successful'
	parameters: string[] = []
	deleteFails = false
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
						this.created = true
						return service
					},
					updateService: async () => service,
					// None until created; then a current deployment in the state `rollouts` says, read by read. `unseen` is
					// ECS lagging the update: the current deployment is still the older revision's, and successful.
					describeService: async () => {
						if (!this.created) return null
						this.current = this.rollouts.shift() ?? 'successful'
						return { ...service, currentDeploymentArn: DEPLOYMENT_ARN }
					},
					describeServiceDeployment: async (arn) => ({
						arn,
						serviceArn: service.arn,
						status: this.current === 'unseen' ? 'successful' : this.current,
						statusReason: null,
						targetRevisionArn: this.current === 'unseen' ? OLDER_REVISION : REVISION,
					}),
					describeServiceRevision: async (arn) => ({
						arn,
						taskDefinitionArn: arn === OLDER_REVISION
							? 'arn:aws:ecs:eu-central-1:123456789012:task-definition/ns_shared_prod_proxy:0'
							: service.taskDefinitionArn,
					}),
				},
				ssm: {
					putSecret: async () => 1,
					deleteSecret: async (name) => {
						this.calls.push(`deleteSecret ${name}`)
						if (this.deleteFails) throw new AwsError('DeleteParameter', 'ThrottlingException', 400, null, true)
						return true
					},
					listNames: async () => this.parameters,
				},
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
		// The build's own URL parameter goes once it ended, before the service is set.
		expect(fake.calls.map((call) => call.replace(/builds\/[0-9a-f-]{36}\//, 'builds/<token>/'))).toEqual([
			'upload',
			'startBuild',
			'getBuild',
			'getBuild',
			'getBuild',
			'findImage',
			'deleteSecret /fabrika/namespaces/shared/prod/builds/<token>/source-url',
			'registerTaskDefinition',
			'createService',
		])
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

describe("the proxy service's rollout", () => {
	const built = namespaceOf({ ...PINNED, proxyImageDigest: DIGEST, proxyImageManifestSha256: MANIFEST })
	const ENV = '/fabrika/namespaces/shared/prod/env'

	test('settles once the deployment of the revision completed, and only then deletes the secrets it no longer names', async () => {
		const fake = new Fake()
		fake.rollouts = ['in_progress']
		// A member that left: its secret is still there, beside the key and the current member's.
		fake.parameters = [`${ENV}/FABRIKA_IAM_KEY`, `${ENV}/${proxySecretVariable('notes@prod')}`, `${ENV}/${proxySecretVariable('gone@prod')}`]
		const result = await republishAwsProxy(fake.context, {
			namespace: built,
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'active',
		})
		expect(result.settled).toBe(true)
		expect(fake.sleeps).toBe(1)
		expect(fake.calls.filter((call) => call.startsWith('deleteSecret'))).toEqual([`deleteSecret ${ENV}/${proxySecretVariable('gone@prod')}`])
		expect(decoded(result.namespace)).toMatchObject({ proxyServiceUpdated: true, proxyServiceRolledOut: true })
	})

	test("a rollout still in progress leaves 'started' unsettled, with no secret deleted", async () => {
		const fake = new Fake()
		fake.rollouts = ['in_progress']
		fake.parameters = [`${ENV}/${proxySecretVariable('gone@prod')}`]
		const result = await republishAwsProxy(fake.context, {
			namespace: built,
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'started',
		})
		expect(result.settled).toBe(false)
		expect(fake.calls.some((call) => call.startsWith('deleteSecret'))).toBe(false)
		expect(decoded(result.namespace).proxyServiceRolledOut).toBeUndefined()
	})

	test('a rollout the circuit breaker rolled back fails with a stable code, not retryable, and deletes nothing', async () => {
		const fake = new Fake()
		fake.rollouts = ['in_progress', 'rollback_in_progress']
		fake.parameters = [`${ENV}/${proxySecretVariable('gone@prod')}`]
		const failure = await republishAwsProxy(fake.context, {
			namespace: built,
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'active',
		})
			.catch((error: unknown) => error)
		expect(failure).toMatchObject({ code: AWS_PROXY_ROLLOUT_FAILED, retryable: false })
		expect(fake.calls.some((call) => call.startsWith('deleteSecret'))).toBe(false)
	})

	test("a read that still shows the older revision's deployment is pending, not a rollback, and deletes nothing yet", async () => {
		const fake = new Fake()
		fake.rollouts = ['unseen', 'unseen']
		fake.parameters = [`${ENV}/${proxySecretVariable('gone@prod')}`]
		const started = await republishAwsProxy(fake.context, {
			namespace: built,
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'started',
		})
		expect(started.settled).toBe(false)
		expect(fake.calls.some((call) => call.startsWith('deleteSecret'))).toBe(false)
		// The next read still lags, the one after shows the revision's deployment successful.
		const active = await republishAwsProxy(fake.context, {
			namespace: started.namespace,
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'active',
		})
		expect(active.settled).toBe(true)
		expect(fake.calls.filter((call) => call.startsWith('deleteSecret'))).toEqual([`deleteSecret ${ENV}/${proxySecretVariable('gone@prod')}`])
	})

	test('a service that is gone drops the update, and the next read of the same wait creates it again', async () => {
		const fake = new Fake()
		const set = await republishAwsProxy(fake.context, { namespace: built, members: MEMBERS, events: fake.events, signal: fake.signal, wait: 'started' })
		const { proxyServiceRolledOut: _rolled, ...unrolled } = decoded(set.namespace)
		// Deleted out of band after its update was recorded.
		const gone = new Fake()
		const started = await republishAwsProxy(gone.context, {
			namespace: namespaceOf(unrolled),
			members: MEMBERS,
			events: gone.events,
			signal: gone.signal,
			wait: 'started',
		})
		expect(started.settled).toBe(false)
		expect(decoded(started.namespace).proxyServiceUpdated).toBeUndefined()
		const active = await republishAwsProxy(gone.context, {
			namespace: started.namespace,
			members: MEMBERS,
			events: gone.events,
			signal: gone.signal,
			wait: 'active',
		})
		expect(active.settled).toBe(true)
		expect(gone.calls).toContain('createService')
	})

	test('a failed delete fails the pass retryably and records no rollout, so the next pass deletes again', async () => {
		const fake = new Fake()
		fake.deleteFails = true
		fake.parameters = [`${ENV}/${proxySecretVariable('gone@prod')}`]
		const failure = await republishAwsProxy(fake.context, {
			namespace: built,
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'active',
		})
			.catch((error: unknown) => error)
		expect(failure).toMatchObject({ retryable: true })
	})

	test('members other than the ones the revision was set for delete nothing', async () => {
		const fake = new Fake()
		const set = await republishAwsProxy(fake.context, { namespace: built, members: MEMBERS, events: fake.events, signal: fake.signal, wait: 'started' })
		const { proxyServiceRolledOut: _rolled, ...unrolled } = decoded(set.namespace)
		const follower = new Fake()
		follower.created = true
		follower.parameters = [`${ENV}/${proxySecretVariable('notes@prod')}`]
		const failure = await followAwsProxyRollout({
			namespace: namespaceOf(unrolled),
			members: [],
			installation,
			proxySource: PROXY_SOURCE,
			iam: follower.context.runtime.iam,
			clients: follower.context.runtime.clients,
			events: follower.events,
			signal: follower.signal,
		})
			.catch((error: unknown) => error)
		expect(failure).toMatchObject({ retryable: false })
		expect(follower.calls.some((call) => call.startsWith('deleteSecret'))).toBe(false)
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

	test('provision stays the stack alone, and a reconcile of a namespace with no member and no proxy calls nothing of it', async () => {
		const fake = new Fake()
		const seen: string[] = []
		const capabilities = withAwsProxyRepublish(base(seen), fake.context)
		await capabilities.provision(mutation(namespaceOf(PINNED), fake))
		await capabilities.reconcile({ ...mutation(namespaceOf(PINNED), fake), members: [] })
		expect(seen).toEqual(['provision', 'reconcile'])
		expect(fake.calls).toEqual([])
		expect(capabilities.republish).toBeDefined()
	})

	test('a reconcile publishes a member change Control queued it for: an image of an older manifest is built again', async () => {
		// The change a busy namespace could not publish (`NamespaceProxyBusyError`): the service runs an older manifest's image.
		const fake = new Fake()
		const older = namespaceOf({
			...PINNED,
			proxyImageDigest: `sha256:${'d'.repeat(64)}`,
			proxyImageManifestSha256: 'e'.repeat(64),
			proxyServiceTaskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/ns_shared_prod_proxy:1',
			proxyServiceFingerprint: 'f'.repeat(64),
			proxyServiceUpdated: true,
		})
		const reconciled = await withAwsProxyRepublish(base([]), fake.context).reconcile(mutation(older, fake))
		expect(fake.calls.map((call) => call.replace(/builds\/[0-9a-f-]{36}\//, 'builds/<token>/'))).toEqual([
			'upload',
			'startBuild',
			'getBuild',
			'findImage',
			'deleteSecret /fabrika/namespaces/shared/prod/builds/<token>/source-url',
			'registerTaskDefinition',
			'createService',
		])
		expect(decoded(reconciled)).toMatchObject({ proxyImageDigest: DIGEST, proxyImageManifestSha256: MANIFEST, proxyServiceUpdated: true })

		// The last member's removal converges too: a recorded image and no member builds the proxy of none.
		const emptied = new Fake()
		await withAwsProxyRepublish(base([]), emptied.context).reconcile({ ...mutation(older, emptied), members: [] })
		expect(emptied.calls).toContain('startBuild')
	})

	test('a reconcile of a converged namespace reads the stack and makes no proxy call', async () => {
		const fake = new Fake()
		const set = await republishAwsProxy(fake.context, {
			namespace: namespaceOf({ ...PINNED, proxyImageDigest: DIGEST, proxyImageManifestSha256: MANIFEST }),
			members: MEMBERS,
			events: fake.events,
			signal: fake.signal,
			wait: 'started',
		})
		const again = new Fake()
		expect(await withAwsProxyRepublish(base([]), again.context).reconcile(mutation(set.namespace, again))).toEqual(set.namespace)
		expect(again.calls).toEqual([])
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
