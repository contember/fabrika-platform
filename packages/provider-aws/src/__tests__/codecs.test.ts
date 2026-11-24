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
	service: 'notes-prod',
	sourcesBucket: 'fabrika-sources-123456789012',
	buildProject: 'fabrika-build',
	repository: 'fabrika/notes-prod',
	parameterPath: '/fabrika/notes/prod',
	logGroup: '/fabrika/notes/prod',
	taskRoleArn: 'arn:aws:iam::123456789012:role/fabrika/notes-prod-task',
	executionRoleArn: 'arn:aws:iam::123456789012:role/fabrika/notes-prod-execution',
}
const artifact: AwsAppArtifact = { contractDigest: `sha256:${'a'.repeat(64)}`, healthPath: '/healthz' }
const namespace: AwsNamespaceTarget = { accountId: '123456789012', region: 'eu-central-1', stackName: 'fabrika-ns-acme', sizing: 'cheap' }
const checkpoint: AwsRunCheckpoint = {
	buildId: 'fabrika-notes-build:0f1e2d3c-4b5a-4968-8776-655443322110',
	taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes-prod:42',
	deploymentArn: 'arn:aws:ecs:eu-central-1:123456789012:service-deployment/fabrika-apps/notes-prod/abcDEF123',
}

/** The message a decode of `payload` fails with. */
function refused<T>(codec: ProviderCodec<T>, payload: JsonValue): string {
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
		expect(refused(awsRunCheckpointCodec, { buildId: checkpoint.buildId ?? '', appVersionId: 'zerops' })).toContain('(appVersionId)')
	})

	test('the markers recorded before each submitting call round-trip, and take only their one form', () => {
		const full: AwsRunCheckpoint = { ...checkpoint, buildToken: '0f1e2d3c-4b5a-4968-8776-655443322110', serviceUpdateRequested: true }
		expect(roundTrip(awsRunCheckpointCodec, full)).toEqual({ decoded: full, json: full })
		expect(refused(awsRunCheckpointCodec, { serviceUpdateRequested: false })).toContain('serviceUpdateRequested')
		expect(refused(awsRunCheckpointCodec, { buildToken: 'not-a-uuid' })).toContain('buildToken')
	})

	test('a value of another form is refused, naming the field only', () => {
		const cases: readonly { readonly codec: ProviderCodec<unknown>; readonly payload: { readonly [key: string]: string }; readonly field: string }[] = [
			{ codec: awsAppTargetCodec, payload: { ...target, accountId: '12345' }, field: 'accountId' },
			{ codec: awsAppTargetCodec, payload: { ...target, region: 'Frankfurt' }, field: 'region' },
			{ codec: awsAppTargetCodec, payload: { ...target, cluster: 'a/b' }, field: 'cluster' },
			{ codec: awsAppTargetCodec, payload: { ...target, sourcesBucket: 'Sources_Bucket' }, field: 'sourcesBucket' },
			{ codec: awsAppTargetCodec, payload: { ...target, repository: 'Fabrika/Notes' }, field: 'repository' },
			{ codec: awsAppTargetCodec, payload: { ...target, parameterPath: 'fabrika/notes' }, field: 'parameterPath' },
			{ codec: awsAppTargetCodec, payload: { ...target, taskRoleArn: 'arn:aws:iam::123456789012:user/notes' }, field: 'taskRoleArn' },
			{ codec: awsAppArtifactCodec, payload: { ...artifact, contractDigest: 'a'.repeat(64) }, field: 'contractDigest' },
			{ codec: awsAppArtifactCodec, payload: { ...artifact, healthPath: 'healthz' }, field: 'healthPath' },
			{ codec: awsAppArtifactCodec, payload: { ...artifact, healthPath: '/a/../b' }, field: 'healthPath' },
			{ codec: awsNamespaceTargetCodec, payload: { ...namespace, sizing: 'huge' }, field: 'sizing' },
			{ codec: awsNamespaceTargetCodec, payload: { ...namespace, stackName: '1stack' }, field: 'stackName' },
			{ codec: awsRunCheckpointCodec, payload: { buildId: 'project:1' }, field: 'buildId' },
			{ codec: awsRunCheckpointCodec, payload: { taskDefinitionArn: 'arn:aws:s3:::bucket' }, field: 'taskDefinitionArn' },
		]
		for (const { codec, payload, field } of cases) {
			const message = refused(codec, { ...payload })
			expect(message).toContain(field)
			for (const value of Object.values(payload)) expect(message).not.toContain(value)
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
