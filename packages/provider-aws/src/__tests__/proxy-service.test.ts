// A namespace proxy's ECS service over a fake of its calls: the task definition of the recorded image (X86_64, the
// namespace's two roles, the IAM issuer plain and every secret by reference), the secrets written before the revision,
// the revision recorded before the service is created or updated, a retry reusing it, a service of this image already
// updated answered with no call, and the refusals: no image, a draining service, a pin of another repository.

import { proxySecretVariable } from '@fabrika/auth-core'
import { contractDigest } from '@fabrika/auth-core'
import type { ProviderApprovedAccess, ProviderDeploymentNamespace, ProviderNamespaceMember } from '@fabrika/provider-contract'
import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import type { EcsService, EcsServiceCreate, EcsTaskDefinition } from '../aws/ecs'
import { awsAppArtifactCodec, type AwsAppTarget, type AwsNamespaceTarget, awsNamespaceTargetCodec } from '../codecs'
import { awsNamespaceTargetEnvelope } from '../namespace'
import { sha256Hex } from '../proxy-attempt'
import { awsProxySecrets, awsProxyServiceFingerprint, awsProxyTaskDefinition, ensureAwsProxyService } from '../proxy-service'

const installation: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	sourcesBucket: 'fabrika-sources-123456789012',
}
const network = { vpcId: 'vpc-0123456789abcdef0', subnets: ['subnet-0123456789abcdef0'], publicIp: true }
const outputs = {
	proxySecurityGroupId: 'sg-0123456789abcdef7',
	serviceConnectNamespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-abcdefghij123456',
}
const PROXY_SOURCE = { repository: { owner: 'contember', name: 'fabrika-platform' }, commitSha: '0123456789abcdef0123456789abcdef01234567' }
const IAM = { issuer: 'https://iam.example.com', key: 'iam-key-not-logged' }
const DIGEST = `sha256:${'b'.repeat(64)}`
const REVISION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/ns_shared_prod_proxy:3'
const PARAMETERS = 'arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/namespaces/shared/prod/env'

const BUILT: AwsNamespaceTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	stackName: 'fabrika-ns-6-shared-prod',
	sizing: 'cheap',
	proxyRepository: 'contember/fabrika-platform',
	proxyCommitSha: PROXY_SOURCE.commitSha,
	proxyImageDigest: DIGEST,
	proxyImageManifestSha256: 'c'.repeat(64),
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
	proxySecret: 'notes-proxy-secret',
	...change,
})
const NOTES_SECRET = proxySecretVariable('notes@prod')

const service = (status: EcsService['status']): EcsService => ({
	name: 'ns_shared_prod_proxy',
	arn: 'arn:aws:ecs:eu-central-1:123456789012:service/fabrika-apps/ns_shared_prod_proxy',
	status,
	taskDefinitionArn: REVISION,
	deployments: [],
	currentDeploymentArn: null,
	network: null,
	events: [],
})

/** A fake of the calls: what each received, in order, and every checkpoint recorded. */
class Fake {
	readonly calls: string[] = []
	readonly checkpoints: AwsNamespaceTarget[] = []
	readonly definitions: EcsTaskDefinition[] = []
	readonly creates: EcsServiceCreate[] = []
	readonly secrets = new Map<string, string>()
	existing: EcsService | null = null

	input(namespace: ProviderDeploymentNamespace, members: readonly ProviderNamespaceMember[] = [member()]) {
		return {
			namespace,
			members,
			installation,
			proxySource: PROXY_SOURCE,
			network,
			outputs,
			iam: IAM,
			clients: {
				ecs: {
					registerTaskDefinition: async (definition: EcsTaskDefinition) => {
						this.calls.push(`registerTaskDefinition ${definition.family}`)
						this.definitions.push(definition)
						return { arn: REVISION, family: definition.family, revision: 3 }
					},
					createService: async (create: EcsServiceCreate) => {
						this.calls.push(`createService ${create.service} ${create.clientToken}`)
						this.creates.push(create)
						return service('active')
					},
					updateService: async (address: { readonly service: string }, taskDefinitionArn: string) => {
						this.calls.push(`updateService ${address.service} ${taskDefinitionArn}`)
						return service('active')
					},
					describeService: async (address: { readonly service: string }) => {
						this.calls.push(`describeService ${address.service}`)
						return this.existing
					},
				},
				ssm: {
					putSecret: async (name: string, value: string) => {
						this.calls.push(`putSecret ${name}`)
						this.secrets.set(name, value)
						return 1
					},
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
		}
	}
}

describe('awsProxyTaskDefinition', () => {
	test("the recorded image on X86_64, the namespace's two roles, the issuer plain and every secret by reference", () => {
		const definition = awsProxyTaskDefinition({
			namespace: { id: 'shared', env: 'prod' },
			installation,
			imageDigest: DIGEST,
			iamIssuer: IAM.issuer,
			secretNames: [NOTES_SECRET, 'FABRIKA_IAM_KEY'],
		})
		expect(definition).toMatchObject({
			family: 'ns_shared_prod_proxy',
			taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika/namespaces/shared_prod_proxy_task',
			executionRoleArn: 'arn:aws:iam::123456789012:role/fabrika/namespaces/shared_prod_proxy_execution',
			cpu: 256,
			memory: 512,
			architecture: 'X86_64',
		})
		const [container] = definition.containers
		expect(container).toMatchObject({
			name: 'proxy',
			image: `123456789012.dkr.ecr.eu-central-1.amazonaws.com/fabrika/namespaces/shared/prod/proxy@${DIGEST}`,
			port: 8080,
			environment: { FABRIKA_IAM_ISSUER: IAM.issuer },
			secrets: { FABRIKA_IAM_KEY: `${PARAMETERS}/FABRIKA_IAM_KEY`, [NOTES_SECRET]: `${PARAMETERS}/${NOTES_SECRET}` },
			log: { group: '/fabrika/namespaces/shared/prod/proxy', region: 'eu-central-1', streamPrefix: 'proxy' },
		})
		expect(container?.healthCheck?.command).toEqual(['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8081/healthz'])
	})

	test('the secrets are the IAM key and the proxy secret of each member the manifest routes', () => {
		const { access: _none, ...unapproved } = member({ appId: 'draft' })
		const secrets = awsProxySecrets([member(), unapproved, member({ env: 'stage', proxySecret: undefined })], IAM.key)
		expect(secrets).toEqual({ FABRIKA_IAM_KEY: IAM.key, [NOTES_SECRET]: 'notes-proxy-secret' })
	})
})

/** What the service's tasks depend on in these tests, and the creation token of the fake's revision. */
const FINGERPRINT = await awsProxyServiceFingerprint(DIGEST, IAM.issuer, { FABRIKA_IAM_KEY: IAM.key, [NOTES_SECRET]: 'notes-proxy-secret' })
const CREATE_TOKEN = `p-${(await sha256Hex(REVISION)).slice(0, 32)}`

describe('ensureAwsProxyService', () => {
	test('writes the secrets, registers and records the revision, then creates the service as a Service Connect client', async () => {
		const fake = new Fake()
		const set = await ensureAwsProxyService(fake.input(namespaceOf(BUILT)))
		expect(fake.calls).toEqual([
			'putSecret /fabrika/namespaces/shared/prod/env/FABRIKA_IAM_KEY',
			`putSecret /fabrika/namespaces/shared/prod/env/${NOTES_SECRET}`,
			'registerTaskDefinition ns_shared_prod_proxy',
			'checkpoint',
			'describeService ns_shared_prod_proxy',
			`createService ns_shared_prod_proxy ${CREATE_TOKEN}`,
			'checkpoint',
		])
		expect(fake.checkpoints).toEqual([
			{ ...BUILT, proxyServiceTaskDefinitionArn: REVISION, proxyServiceFingerprint: FINGERPRINT },
			{ ...BUILT, proxyServiceTaskDefinitionArn: REVISION, proxyServiceFingerprint: FINGERPRINT, proxyServiceUpdated: true },
		])
		// The fingerprint names no credential.
		expect(FINGERPRINT).not.toContain(IAM.key)
		expect(awsNamespaceTargetCodec.decode(set.target.payload)).toMatchObject({ proxyServiceUpdated: true })
		expect(fake.secrets.get('/fabrika/namespaces/shared/prod/env/FABRIKA_IAM_KEY')).toBe(IAM.key)
		// The key and the proxy secrets travel only to Parameter Store, never in the task definition.
		expect(JSON.stringify(fake.definitions)).not.toContain(IAM.key)
		expect(JSON.stringify(fake.definitions)).not.toContain('notes-proxy-secret')
		expect(fake.creates[0]).toMatchObject({
			cluster: 'fabrika-apps',
			taskDefinitionArn: REVISION,
			desiredCount: 1,
			network: { subnets: network.subnets, securityGroups: [outputs.proxySecurityGroupId], publicIp: true },
			serviceConnect: { namespaceArn: outputs.serviceConnectNamespaceArn },
		})
		expect(fake.creates[0]?.serviceConnect).not.toHaveProperty('discoveryName')
	})

	test('an existing service is updated; a recorded revision of this fingerprint is reused, not registered again', async () => {
		const fake = new Fake()
		fake.existing = service('active')
		const recorded = namespaceOf({ ...BUILT, proxyServiceTaskDefinitionArn: REVISION, proxyServiceFingerprint: FINGERPRINT })
		await ensureAwsProxyService(fake.input(recorded))
		expect(fake.calls.filter((call) => !call.startsWith('putSecret'))).toEqual([
			'describeService ns_shared_prod_proxy',
			`updateService ns_shared_prod_proxy ${REVISION}`,
			'checkpoint',
		])
		// An inactive service is one to create again.
		const inactive = new Fake()
		inactive.existing = service('inactive')
		await ensureAwsProxyService(inactive.input(recorded))
		expect(inactive.calls).toContain(`createService ns_shared_prod_proxy ${CREATE_TOKEN}`)
	})

	test('a service already updated to this fingerprint is answered with no call; a newer image registers a new revision', async () => {
		const fake = new Fake()
		const updated = namespaceOf({ ...BUILT, proxyServiceTaskDefinitionArn: REVISION, proxyServiceFingerprint: FINGERPRINT, proxyServiceUpdated: true })
		expect(await ensureAwsProxyService(fake.input(updated))).toEqual(updated)
		expect(fake.calls).toEqual([])
		const newer = new Fake()
		newer.existing = service('active')
		const rebuilt = `sha256:${'e'.repeat(64)}`
		await ensureAwsProxyService(newer.input(namespaceOf({
			...BUILT,
			proxyImageDigest: rebuilt,
			proxyServiceTaskDefinitionArn: REVISION,
			proxyServiceFingerprint: FINGERPRINT,
			proxyServiceUpdated: true,
		})))
		expect(newer.calls).toContain('registerTaskDefinition ns_shared_prod_proxy')
		// The new revision is recorded without the old update's mark, before the service is set to it.
		expect(newer.checkpoints[0]).toEqual({
			...BUILT,
			proxyImageDigest: rebuilt,
			proxyServiceTaskDefinitionArn: REVISION,
			proxyServiceFingerprint: await awsProxyServiceFingerprint(rebuilt, IAM.issuer, { FABRIKA_IAM_KEY: IAM.key, [NOTES_SECRET]: 'notes-proxy-secret' }),
		})
	})

	test('the same image with a new IAM key, issuer or proxy secret writes the secrets and sets the service to a new revision', async () => {
		const updated = namespaceOf({ ...BUILT, proxyServiceTaskDefinitionArn: REVISION, proxyServiceFingerprint: FINGERPRINT, proxyServiceUpdated: true })
		const changes: readonly [string, (fake: Fake) => ReturnType<Fake['input']>][] = [
			['the IAM key', (fake) => ({ ...fake.input(updated), iam: { ...IAM, key: 'rotated-iam-key' } })],
			['the IAM issuer', (fake) => ({ ...fake.input(updated), iam: { ...IAM, issuer: 'https://iam.example.org' } })],
			['a proxy secret', (fake) => fake.input(updated, [member({ proxySecret: 'rotated-proxy-secret' })])],
		]
		for (const [what, input] of changes) {
			const fake = new Fake()
			fake.existing = service('active')
			await ensureAwsProxyService(input(fake))
			expect(fake.calls.filter((call) => call.startsWith('putSecret')).length, what).toBe(2)
			expect(fake.calls, what).toContain('registerTaskDefinition ns_shared_prod_proxy')
			expect(fake.calls, what).toContain(`updateService ns_shared_prod_proxy ${REVISION}`)
			expect(fake.checkpoints.at(-1)?.proxyServiceFingerprint, what).not.toBe(FINGERPRINT)
		}
	})

	test('a creation answered with a service that is not active is refused, its update not recorded', async () => {
		const fake = new Fake()
		const input = fake.input(namespaceOf(BUILT))
		const failure = await ensureAwsProxyService({
			...input,
			clients: { ...input.clients, ecs: { ...input.clients.ecs, createService: async () => service('inactive') } },
		}).catch((error: unknown) => error)
		expect(failure).toMatchObject({ code: 'awsProxyService', retryable: true })
		expect(fake.checkpoints.some((checkpoint) => checkpoint.proxyServiceUpdated === true)).toBe(false)
	})

	test('no image, a draining service or a pin of another repository is refused as a namespace error', async () => {
		const { proxyImageDigest: _digest, proxyImageManifestSha256: _manifest, ...unbuilt } = BUILT
		const none = new Fake()
		await expect(ensureAwsProxyService(none.input(namespaceOf(unbuilt)))).rejects.toMatchObject({
			message: "aws: the namespace's proxy has no image built to run",
		})
		expect(none.calls).toEqual([])

		const draining = new Fake()
		draining.existing = service('draining')
		const failure = await ensureAwsProxyService(draining.input(namespaceOf(BUILT))).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(ProviderNamespaceError)
		expect(failure).toMatchObject({ code: 'awsProxyService', retryable: true })
		expect(draining.calls.some((call) => call.startsWith('createService') || call.startsWith('updateService'))).toBe(false)

		const foreign = new Fake()
		await expect(ensureAwsProxyService(foreign.input(namespaceOf({ ...BUILT, proxyRepository: 'someone/fabrika-platform' })))).rejects.toBeInstanceOf(
			ProviderNamespaceError,
		)
		expect(foreign.calls).toEqual([])
	})
})
