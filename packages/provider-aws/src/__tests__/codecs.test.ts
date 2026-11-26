// What the AWS provider persists through Control: each codec round-trips its value, refuses a field it does not know
// and a value of another form without quoting it, and stays under Control's 16 KiB.

import { authoredAppProvider, decodeEnvelope, type JsonValue, MAX_PROVIDER_STATE_BYTES, type ProviderCodec } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import {
	AWS_PROVIDER,
	type AwsAppArtifact,
	awsAppArtifactCodec,
	type AwsAppTarget,
	awsAppTargetCodec,
	type AwsNamespaceTarget,
	awsNamespaceTargetCodec,
	type AwsRunCheckpoint,
	awsRunCheckpointCodec,
	defineApp,
	isAwsAppConfig,
} from '..'

const target: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	sourcesBucket: 'fabrika-sources-123456789012',
}
const artifact: AwsAppArtifact = { contractDigest: `sha256:${'a'.repeat(64)}`, healthPath: '/healthz' }
const namespace: AwsNamespaceTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	stackName: 'fabrika-ns-acme',
	sizing: 'cheap',
	proxyRepository: 'contember/fabrika-platform',
	proxyCommitSha: '0123456789abcdef0123456789abcdef01234567',
}
const checkpoint: AwsRunCheckpoint = {
	buildId: 'fabrika-notes-build:0f1e2d3c-4b5a-4968-8776-655443322110',
	taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:42',
	deploymentArn: 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/notes-prod/abcDEF123',
}

/** The message a decode of `payload` fails with. */
function refused<T>(codec: ProviderCodec<T>, value: object): string {
	// As Control would hand it over: JSON text read back.
	const payload: JsonValue = JSON.parse(JSON.stringify(value))
	try {
		codec.decode(payload)
	} catch (error) {
		return error instanceof Error ? error.message : ''
	}
	throw new Error('the payload was not refused')
}

/** Encodes `value`, decodes it from a JSON round trip, and answers both. */
function roundTrip<T>(codec: ProviderCodec<T>, value: T): { readonly decoded: T; readonly json: unknown } {
	const payload = codec.encode(value)
	const json: unknown = JSON.parse(JSON.stringify(payload))
	return { decoded: decodeEnvelope('state', AWS_PROVIDER, { provider: AWS_PROVIDER, version: codec.version, payload }, codec), json }
}

describe('the AWS codecs', () => {
	test('each value round-trips through its envelope as it is', () => {
		expect(roundTrip(awsAppTargetCodec, target)).toEqual({ decoded: target, json: target })
		expect(roundTrip(awsAppArtifactCodec, artifact)).toEqual({ decoded: artifact, json: artifact })
		expect(roundTrip(awsNamespaceTargetCodec, namespace)).toEqual({ decoded: namespace, json: namespace })
		expect(roundTrip(awsRunCheckpointCodec, checkpoint)).toEqual({ decoded: checkpoint, json: checkpoint })
	})

	test('a checkpoint grows field by field from the empty one, and an absent field is not written', () => {
		expect(awsRunCheckpointCodec.encode({})).toEqual({})
		expect(awsRunCheckpointCodec.decode({ buildId: checkpoint.buildId ?? '' })).toEqual({ buildId: checkpoint.buildId })
		const taskDefinitionArn = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:43'
		expect(awsRunCheckpointCodec.encode({ taskDefinitionArn })).toEqual({ taskDefinitionArn })
	})

	test('an unknown field is refused, not dropped, and its value is not quoted', () => {
		const message = refused(awsAppTargetCodec, { ...target, secretAccessKey: 'must-not-be-stored' })
		expect(message).toBe('the AWS target is not one this provider reads (secretAccessKey)')
		// An environment's own resources are derived, never registered: a target naming one is refused.
		for (const field of ['service', 'repository', 'parameterPath', 'taskRoleArn', 'executionRoleArn', 'buildProject']) {
			expect(refused(awsAppTargetCodec, { ...target, [field]: 'other' })).toContain(`(${field})`)
		}
		expect(refused(awsRunCheckpointCodec, { buildId: checkpoint.buildId ?? '', appVersionId: 'zerops' })).toContain('(appVersionId)')
	})

	test('the markers recorded before each submitting call round-trip, and take only their one form', () => {
		const full: AwsRunCheckpoint = { ...checkpoint, buildToken: '0f1e2d3c-4b5a-4968-8776-655443322110', serviceUpdateRequested: true }
		expect(roundTrip(awsRunCheckpointCodec, full)).toEqual({ decoded: full, json: full })
		expect(refused(awsRunCheckpointCodec, { serviceUpdateRequested: false })).toContain('serviceUpdateRequested')
		expect(refused(awsRunCheckpointCodec, { buildToken: 'not-a-uuid' })).toContain('buildToken')
	})

	test("a namespace's proxy build is recorded with its token and its manifest's digest, never one without the other", () => {
		const token = '0f1e2d3c-4b5a-4968-8776-655443322110'
		const building: AwsNamespaceTarget = {
			...namespace,
			proxyBuildToken: token,
			proxyBuildManifestSha256: 'f'.repeat(64),
			proxyBuildId: `fabrika_ns_acme_prod:${token}`,
		}
		expect(roundTrip(awsNamespaceTargetCodec, building)).toEqual({ decoded: building, json: building })
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyBuildToken: token })).toContain('proxyBuildManifestSha256')
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyBuildId: building.proxyBuildId ?? '' })).toContain('proxyBuildToken')
		// The image: its digest with the manifest it was built from, never one without the other.
		const built: AwsNamespaceTarget = { ...namespace, proxyImageDigest: `sha256:${'a'.repeat(64)}`, proxyImageManifestSha256: 'f'.repeat(64) }
		expect(roundTrip(awsNamespaceTargetCodec, built)).toEqual({ decoded: built, json: built })
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyImageDigest: built.proxyImageDigest ?? '' })).toContain('proxyImageManifestSha256')
		// The service: its revision with its image, and the update's mark only with them.
		const revision = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/ns_acme_prod_proxy:3'
		const serving: AwsNamespaceTarget = {
			...built,
			proxyServiceTaskDefinitionArn: revision,
			proxyServiceFingerprint: 'a'.repeat(64),
			proxyServiceUpdated: true,
		}
		expect(roundTrip(awsNamespaceTargetCodec, serving)).toEqual({ decoded: serving, json: serving })
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyServiceTaskDefinitionArn: revision })).toContain('proxyServiceFingerprint')
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyServiceUpdated: true })).toContain('proxyServiceTaskDefinitionArn')
		// The rollout's mark only after the update's.
		expect(roundTrip(awsNamespaceTargetCodec, { ...serving, proxyServiceRolledOut: true }).decoded).toMatchObject({ proxyServiceRolledOut: true })
		const { proxyServiceUpdated: _updated, ...notUpdated } = serving
		expect(refused(awsNamespaceTargetCodec, { ...notUpdated, proxyServiceRolledOut: true })).toContain('proxyServiceUpdated')
		// The hosts' certificates: a list of flat records, one per host, a validation record whole or not at all.
		const arn = 'arn:aws:acm:eu-central-1:123456789012:certificate/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
		const certified: AwsNamespaceTarget = {
			...namespace,
			proxyCertificates: [
				{ host: 'a.example.com', arn, status: 'ISSUED' },
				{
					host: 'b.example.com',
					arn,
					status: 'PENDING_VALIDATION',
					validationName: '_3f2a9c.b.example.com.',
					validationValue: '_7b1d.abcdefgh.acm-validations.aws.',
				},
			],
		}
		expect(roundTrip(awsNamespaceTargetCodec, certified)).toEqual({ decoded: certified, json: certified })
		const [first] = certified.proxyCertificates ?? []
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyCertificates: [first, first] })).toContain('proxyCertificates')
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyCertificates: [{ ...first, validationName: '_a.example.com.' }] })).toContain(
			'validationValue',
		)
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyCertificates: [{ ...first, status: 'NEW' }] })).toContain('status')
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyCertificates: [{ ...first, host: '*.example.com' }] })).toContain('host')
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyCertificates: [{ ...first, extra: 'x' }] })).toContain('extra')
		const many = Array.from({ length: 26 }, (_, index) => ({ ...first, host: `h${index}.example.com` }))
		expect(refused(awsNamespaceTargetCodec, { ...namespace, proxyCertificates: many })).toContain('proxyCertificates')
		// The pin is required: a target without it is one this release does not read.
		const { proxyCommitSha: _sha, ...unpinned } = namespace
		expect(refused(awsNamespaceTargetCodec, unpinned)).toContain('proxyCommitSha')
	})

	test('a value of another form is refused, naming the field only', () => {
		const cases: readonly {
			readonly codec: ProviderCodec<unknown>
			readonly payload: object
			readonly field: string
		}[] = [
			{ codec: awsAppTargetCodec, payload: { ...target, accountId: '12345' }, field: 'accountId' },
			{ codec: awsAppTargetCodec, payload: { ...target, region: 'Frankfurt' }, field: 'region' },
			{ codec: awsAppTargetCodec, payload: { ...target, cluster: 'a/b' }, field: 'cluster' },
			{ codec: awsAppTargetCodec, payload: { ...target, sourcesBucket: 'Sources_Bucket' }, field: 'sourcesBucket' },
			{ codec: awsAppArtifactCodec, payload: { ...artifact, contractDigest: 'a'.repeat(64) }, field: 'contractDigest' },
			{ codec: awsAppArtifactCodec, payload: { ...artifact, healthPath: 'healthz' }, field: 'healthPath' },
			{ codec: awsAppArtifactCodec, payload: { ...artifact, healthPath: '/a/../b' }, field: 'healthPath' },
			{ codec: awsNamespaceTargetCodec, payload: { ...namespace, sizing: 'huge' }, field: 'sizing' },
			{ codec: awsNamespaceTargetCodec, payload: { ...namespace, stackName: '1stack' }, field: 'stackName' },
			// The pin: a lowercased `<owner>/<name>` and a full commit, never a branch or a URL.
			{
				codec: awsNamespaceTargetCodec,
				payload: { ...namespace, proxyRepository: 'https://github.com/contember/fabrika-platform' },
				field: 'proxyRepository',
			},
			{ codec: awsNamespaceTargetCodec, payload: { ...namespace, proxyCommitSha: 'main' }, field: 'proxyCommitSha' },
			{
				codec: awsNamespaceTargetCodec,
				payload: { ...namespace, proxyBuildToken: 'not-a-uuid', proxyBuildManifestSha256: 'f'.repeat(64) },
				field: 'proxyBuildToken',
			},
			{ codec: awsRunCheckpointCodec, payload: { buildId: 'project:1' }, field: 'buildId' },
			{ codec: awsRunCheckpointCodec, payload: { taskDefinitionArn: 'arn:aws:s3:::bucket' }, field: 'taskDefinitionArn' },
		]
		for (const { codec, payload, field } of cases) {
			const message = refused(codec, { ...payload })
			expect(message).toContain(field)
			for (const value of Object.values(payload)) if (typeof value === 'string') expect(message).not.toContain(value)
		}
	})

	test('an identifier past its bound is refused by its pattern, so no payload nears the limit', () => {
		const long = `arn:aws:ecs:eu-central-1:123456789012:service-deployment/${'a'.repeat(MAX_PROVIDER_STATE_BYTES)}`
		expect(refused(awsRunCheckpointCodec, { deploymentArn: long })).toContain('(deploymentArn)')
		const longRegion = `arn:aws:ecs:${'a'.repeat(5000)}:123456789012:task-definition/notes:1`
		expect(refused(awsRunCheckpointCodec, { taskDefinitionArn: longRegion })).toContain('(taskDefinitionArn)')
		expect(refused(awsRunCheckpointCodec, { taskDefinitionArn: 'arn:aws:ecs:---:123456789012:task-definition/notes:1' })).toContain(
			'(taskDefinitionArn)',
		)
	})

	test('a service deployment of the longest cluster and service names is taken', () => {
		const longest = `arn:aws:ecs:eu-central-1:123456789012:service-deployment/${'c'.repeat(255)}/${'s'.repeat(255)}/abcDEF123`
		expect(awsRunCheckpointCodec.decode({ deploymentArn: longest })).toEqual({ deploymentArn: longest })
	})

	test('a task definition in another partition is taken', () => {
		for (const partition of ['aws-cn', 'aws-us-gov', 'aws-iso-b', 'aws-eusc']) {
			const taskDefinitionArn = `arn:${partition}:ecs:us-isob-east-1:123456789012:task-definition/notes:7`
			expect(awsRunCheckpointCodec.decode({ taskDefinitionArn })).toEqual({ taskDefinitionArn })
		}
	})
})

describe('defineApp', () => {
	test("marks the config as AWS's, keeping what it declares", () => {
		const config = defineApp({ id: 'notes', pipeline: { secrets: ['STRIPE_KEY'] } })
		expect(authoredAppProvider(config)).toBe('aws')
		expect(config).toMatchObject({ id: 'notes', pipeline: { secrets: ['STRIPE_KEY'] } })
		expect(isAwsAppConfig(config)).toBe(true)
	})

	test('refuses an id outside the contract rule, and a config of another provider is not AWS', () => {
		for (const id of ['', 'Notes', '-notes', 'notes app']) expect(() => defineApp({ id })).toThrow('`id`')
		expect(isAwsAppConfig({ id: 'notes' })).toBe(false)
	})
})
