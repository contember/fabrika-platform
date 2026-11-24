// The JSON protocol client against a fake at the HTTP level: what a call sends, how it reads an answer, and that a
// failure names the service's code, the status and the request id, never a message, the input or a credential.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { AwsError, awsJsonClient, type AwsJsonClientOptions, awsServiceOrigin, ECS } from '../aws/json'
import type { SigningCredentials } from '../aws/sigv4'

const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
const TOKEN = 'session-token-not-to-be-quoted'
const credentials: SigningCredentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: SECRET, sessionToken: TOKEN }
const at = new Date('2026-01-15T12:00:00Z')
const services = z.object({ services: z.array(z.object({ serviceName: z.string() })) })

interface Sent {
	readonly url: string
	readonly init: RequestInit
}

/** A client of ECS whose requests `answer` answers, recording each. */
function client(answer: (sent: Sent) => Response | Promise<Response>, options: Partial<AwsJsonClientOptions> = {}) {
	const sent: Sent[] = []
	let current = 0
	const ecs = awsJsonClient(ECS, {
		origin: awsServiceOrigin(ECS, 'eu-central-1'),
		region: 'eu-central-1',
		credentials: {
			current: () => {
				current += 1
				return Promise.resolve(credentials)
			},
		},
		now: () => at,
		fetch: (url, init) => {
			const call = { url, init }
			sent.push(call)
			return Promise.resolve(answer(call))
		},
		...options,
	})
	return { ecs, sent, credentialReads: () => current }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/x-amz-json-1.1', ...headers } })

/** The AwsError `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<AwsError> {
	try {
		await promise
	} catch (error) {
		if (error instanceof AwsError) return error
		throw error
	}
	throw new Error('the call did not fail')
}

function headerOf(init: RequestInit, name: string): string | undefined {
	const headers = init.headers
	if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) return undefined
	return headers[name]
}

describe('awsJsonClient', () => {
	test('posts the signed operation to the regional endpoint, follows no redirect, and reads the answer', async () => {
		const { ecs, sent, credentialReads } = client(() => json({ services: [{ serviceName: 'notes-prod', status: 'ACTIVE' }] }))
		const answer = await ecs.call('DescribeServices', { cluster: 'fabrika-apps', services: ['notes-prod'] }, services)
		expect(answer).toEqual({ services: [{ serviceName: 'notes-prod' }] })
		const [call] = sent
		if (call === undefined) throw new Error('nothing was sent')
		expect(call.url).toBe('https://ecs.eu-central-1.amazonaws.com/')
		expect(call.init.method).toBe('POST')
		expect(call.init.redirect).toBe('manual')
		expect(call.init.body).toBe(JSON.stringify({ cluster: 'fabrika-apps', services: ['notes-prod'] }))
		expect(headerOf(call.init, 'x-amz-target')).toBe('AmazonEC2ContainerServiceV20141113.DescribeServices')
		expect(headerOf(call.init, 'content-type')).toBe('application/x-amz-json-1.1')
		expect(headerOf(call.init, 'x-amz-security-token')).toBe(TOKEN)
		expect(headerOf(call.init, 'authorization')).toStartWith(
			'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260115/eu-central-1/ecs/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target,',
		)
		expect(credentialReads()).toBe(1)
	})

	test('reads the credentials again for every call, so a rotated set signs the next one', async () => {
		const { ecs, credentialReads } = client(() => json({ services: [] }))
		await ecs.call('DescribeServices', {}, services)
		await ecs.call('DescribeServices', {}, services)
		expect(credentialReads()).toBe(2)
	})

	test("an error names the service's code from the body, or from the header, the status and the request id", async () => {
		const body = { __type: 'com.amazonaws.ecs#ClusterNotFoundException', message: 'Cluster fabrika-apps-secret-name not found.' }
		const { ecs } = client(() => json(body, 400, { 'x-amzn-requestid': 'a1b2c3d4-0000-4000-8000-000000000001' }))
		const error = await failure(ecs.call('DescribeServices', { cluster: 'fabrika-apps-secret-name' }, services))
		expect(error).toMatchObject({
			operation: 'DescribeServices',
			code: 'ClusterNotFoundException',
			status: 400,
			requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
			retryable: false,
		})
		expect(error.message).not.toContain('secret-name')
		const throttled = client(() =>
			new Response('', { status: 400, headers: { 'x-amzn-errortype': 'ThrottlingException:http://internal.amazon.com/' } })
		)
		expect(await failure(throttled.ecs.call('DescribeServices', {}, services))).toMatchObject({ code: 'ThrottlingException', retryable: true })
	})

	test('a server error and an unreachable endpoint may be retried; a code of another form is not repeated', async () => {
		expect(await failure(client(() => json({}, 503)).ecs.call('DescribeServices', {}, services))).toMatchObject({
			code: 'unknown',
			status: 503,
			retryable: true,
		})
		const odd = client(() => json({ __type: 'evil<script>' }, 400))
		expect(await failure(odd.ecs.call('DescribeServices', {}, services))).toMatchObject({ code: 'unknown', retryable: false })
		const down = client(() => Promise.reject(new Error(`connect failed with ${SECRET}`)))
		const error = await failure(down.ecs.call('DescribeServices', {}, services))
		expect(error).toMatchObject({ code: 'unreachable', status: 0, retryable: true })
		expect(error.message).not.toContain(SECRET)
	})

	test('a redirect is no answer, and its target is not followed', async () => {
		const { ecs, sent } = client(() => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com/' } }))
		expect(await failure(ecs.call('DescribeServices', {}, services))).toMatchObject({ code: 'redirect', status: 307 })
		expect(sent).toHaveLength(1)
	})

	test('an answer past the bound, one that is no JSON, and one the schema refuses are refused without quoting them', async () => {
		const large = client(() => json({ services: [{ serviceName: 'x'.repeat(2_000) }] }), { maxAnswerBytes: 1_000 })
		expect(await failure(large.ecs.call('DescribeServices', {}, services))).toMatchObject({ code: 'answer_too_large' })
		const garbled = client(() => new Response(`not json ${TOKEN}`, { status: 200 }))
		const unread = await failure(garbled.ecs.call('DescribeServices', {}, services))
		expect(unread).toMatchObject({ code: 'invalid_answer' })
		expect(unread.message).not.toContain(TOKEN)
		const wrong = client(() => json({ services: [{ serviceName: 42 }] }))
		expect(await failure(wrong.ecs.call('DescribeServices', {}, services))).toMatchObject({ code: 'invalid_answer' })
	})

	test('a call past its deadline is a timeout, and an operation of another form is refused before anything is sent', async () => {
		const hung = client(({ init }) =>
			new Promise<Response>((_, reject) => {
				init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
			}), { timeoutMs: 20 })
		expect(await failure(hung.ecs.call('DescribeServices', {}, services))).toMatchObject({ code: 'timeout', retryable: true })
		const { ecs, sent } = client(() => json({}))
		expect(await failure(ecs.call('Describe.Services', {}, services))).toMatchObject({ code: 'invalid_operation' })
		expect(sent).toHaveLength(0)
	})

	test("an http: origin is refused unless it is a local emulator's, as the signer refuses it", async () => {
		const plain = client(() => json({ services: [] }), { origin: 'http://localhost:4566' })
		await expect(plain.ecs.call('DescribeServices', {}, services)).rejects.toThrow('allowInsecureOrigin')
		const local = client(() => json({ services: [] }), { origin: 'http://localhost:4566', allowInsecureOrigin: true })
		expect(await local.ecs.call('DescribeServices', {}, services)).toEqual({ services: [] })
		expect(local.sent[0]?.url).toBe('http://localhost:4566/')
	})
})
