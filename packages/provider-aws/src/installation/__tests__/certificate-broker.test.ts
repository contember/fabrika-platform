// The certificate broker's own source, run as Lambda would load it (CommonJS) against fakes of its calls: it attaches a
// namespace's certificate to the applications' listener alone, refuses one naming an installation host (exactly or by
// a wildcard), removes what it attached, and answers CloudFormation every time, a failure with its reason.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AWS_CERTIFICATE_BROKER_SOURCE, AWS_MAX_INLINE_SOURCE, awsCertificateBrokerArn } from '../certificate-broker'

const LISTENER = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210'
const OTHER_LISTENER = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-platform/0123456789abcdef/fedcba9876543210'
const CERTIFICATE = 'arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-000000000001'

type Event = Readonly<Record<string, unknown>>
type Handler = (event: Event) => Promise<void>
interface Deps {
	readonly names: (arn: string) => Promise<readonly string[]>
	readonly add: (listener: string, certificate: string) => Promise<void>
	readonly remove: (listener: string, certificate: string) => Promise<void>
	readonly respond: (url: string, body: Readonly<Record<string, unknown>>) => Promise<void>
}

let directory = ''
let make: (deps: Deps) => Handler = () => async () => {}

beforeAll(async () => {
	directory = mkdtempSync(join(tmpdir(), 'fabrika-broker-'))
	const file = join(directory, 'index.cjs')
	writeFileSync(file, AWS_CERTIFICATE_BROKER_SOURCE)
	const loaded: unknown = await import(file)
	const exported: unknown = Reflect.get(Object(loaded), 'make') ?? Reflect.get(Object(Reflect.get(Object(loaded), 'default')), 'make')
	if (typeof exported !== 'function') throw new Error('the broker exports no make')
	make = (deps) => {
		const handler: unknown = Reflect.apply(exported, undefined, [deps])
		if (typeof handler !== 'function') throw new Error('make answers no handler')
		return (event) => Promise.resolve(Reflect.apply(handler, undefined, [event]))
	}
	process.env['LISTENER_ARN'] = LISTENER
	process.env['RESERVED_HOSTS'] = 'iam.example.com,control.example.com,operations.example.com,apps.example.com'
})

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
	delete process.env['LISTENER_ARN']
	delete process.env['RESERVED_HOSTS']
})

/** Fakes of the broker's calls: the certificate's names, and every call made, in order. */
function fake(names: readonly string[]) {
	const calls: string[] = []
	const answers: Readonly<Record<string, unknown>>[] = []
	const deps: Deps = {
		names: async (arn) => {
			calls.push(`names ${arn}`)
			return names
		},
		add: async (listener, certificate) => {
			calls.push(`add ${listener} ${certificate}`)
		},
		remove: async (listener, certificate) => {
			calls.push(`remove ${listener} ${certificate}`)
		},
		respond: async (url, body) => {
			calls.push(`respond ${url}`)
			answers.push(body)
		},
	}
	return { calls, answers, deps }
}

const event = (type: string, properties: Readonly<Record<string, string>>, physical?: string): Event => ({
	RequestType: type,
	ResponseURL: 'https://cloudformation-custom-resource-response.example/presigned',
	StackId: 'stack',
	RequestId: 'request',
	LogicalResourceId: 'HostCertificate0',
	ResourceProperties: { ServiceToken: 'broker', ...properties },
	...(physical === undefined ? {} : { PhysicalResourceId: physical }),
})

describe('the certificate broker', () => {
	test("its source fits CloudFormation's inline bound, and hosts stacks name it in the listener's account and region", () => {
		expect(AWS_CERTIFICATE_BROKER_SOURCE.length).toBeLessThanOrEqual(AWS_MAX_INLINE_SOURCE)
		expect(awsCertificateBrokerArn(LISTENER)).toBe('arn:aws:lambda:eu-central-1:123456789012:function:fabrika-certificate-broker')
	})

	test("a namespace's certificate goes on the applications' listener, and its physical id names both", async () => {
		const { calls, answers, deps } = fake(['notes.example.org'])
		await make(deps)(event('Create', { ListenerArn: LISTENER, CertificateArn: CERTIFICATE }))
		expect(calls).toEqual([
			`names ${CERTIFICATE}`,
			`add ${LISTENER} ${CERTIFICATE}`,
			'respond https://cloudformation-custom-resource-response.example/presigned',
		])
		expect(answers).toEqual([{
			Status: 'SUCCESS',
			Reason: '',
			PhysicalResourceId: `${LISTENER}|${CERTIFICATE}`,
			StackId: 'stack',
			RequestId: 'request',
			LogicalResourceId: 'HostCertificate0',
		}])
	})

	test('a certificate naming an installation host, exactly or by a wildcard, or naming none, is refused and attached nowhere', async () => {
		for (const names of [['iam.example.com'], ['notes.example.org', 'Control.example.com'], ['*.example.com'], []]) {
			const { calls, answers, deps } = fake(names)
			await make(deps)(event('Create', { ListenerArn: LISTENER, CertificateArn: CERTIFICATE }))
			expect(calls.some((call) => call.startsWith('add'))).toBe(false)
			expect(answers[0]?.['Status']).toBe('FAILED')
		}
		// A wildcard of another parent covers no installation host.
		const other = fake(['*.apps.example.com'])
		await make(other.deps)(event('Create', { ListenerArn: LISTENER, CertificateArn: CERTIFICATE }))
		expect(other.answers[0]?.['Status']).toBe('SUCCESS')
	})

	test('a request naming another listener is refused: the broker works on its own listener alone', async () => {
		const { calls, answers, deps } = fake(['notes.example.org'])
		await make(deps)(event('Create', { ListenerArn: OTHER_LISTENER, CertificateArn: CERTIFICATE }))
		expect(calls).toEqual(['respond https://cloudformation-custom-resource-response.example/presigned'])
		expect(answers[0]).toMatchObject({ Status: 'FAILED', Reason: 'not the applications listener', PhysicalResourceId: 'none' })
	})

	test('a delete removes what it attached, and a delete of a failed create removes nothing', async () => {
		const removed = fake([])
		await make(removed.deps)(event('Delete', { ListenerArn: LISTENER, CertificateArn: CERTIFICATE }, `${LISTENER}|${CERTIFICATE}`))
		expect(removed.calls[0]).toBe(`remove ${LISTENER} ${CERTIFICATE}`)
		expect(removed.answers[0]?.['Status']).toBe('SUCCESS')
		const nothing = fake([])
		await make(nothing.deps)(event('Delete', { ListenerArn: LISTENER, CertificateArn: CERTIFICATE }, 'none'))
		// Nor one whose physical id names another listener.
		await make(nothing.deps)(event('Delete', { ListenerArn: LISTENER, CertificateArn: CERTIFICATE }, `${OTHER_LISTENER}|${CERTIFICATE}`))
		expect(nothing.calls.some((call) => call.startsWith('remove'))).toBe(false)
	})

	test('a failing call still answers CloudFormation, with its reason', async () => {
		const { answers, deps } = fake(['notes.example.org'])
		await make({ ...deps, add: async () => Promise.reject(new Error('TooManyCertificates')) })(
			event('Create', { ListenerArn: LISTENER, CertificateArn: CERTIFICATE }),
		)
		expect(answers[0]).toMatchObject({ Status: 'FAILED', Reason: 'TooManyCertificates' })
	})
})
