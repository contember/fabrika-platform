// The S3 part writer and the presigned read against a fake bucket: the calls a multipart upload makes in order, a single
// object for an archive of one part, the completion read strictly (S3's real answer form included), a retryable part sent
// again, the abort in order and only over an object a call may have made, every call signed with its body's digest and
// naming the bucket's owner, and the calls Control would never make refused.

import { describe, expect, test } from 'bun:test'
import { awsSourceKey, S3_PART_ATTEMPTS, S3_PART_BYTES, s3BucketOrigin, type S3ObjectAddress, s3PartWriter, s3PresignedGet } from '../aws/s3'
import { sha256Hex } from '../aws/sigv4'
import type { AwsClientOptions } from '../aws/transport'

const BUCKET = 'fabrika-apps-sources'
const TOKEN = '0f1e2d3c-4b5a-4968-8776-655443322110'
const KEY = awsSourceKey('notes', 'prod', TOKEN)
const ACCOUNT = '123456789012'
const ADDRESS: S3ObjectAddress = { bucket: BUCKET, region: 'eu-central-1', accountId: ACCOUNT, key: KEY }
const ORIGIN = s3BucketOrigin(BUCKET, 'eu-central-1')
const credentials = { current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }) }

interface S3Call {
	readonly operation: string
	readonly method: string
	readonly query: string
	readonly bytes: number
	readonly body: string
}

/**
 * A fake bucket: what each S3 operation answers, and the calls it got. A call not signed for `s3` with its body's digest,
 * or not naming the bucket's owner, is refused.
 */
function fakeS3(overrides: Readonly<Record<string, (call: S3Call, calls: readonly S3Call[]) => Response>> = {}): {
	readonly options: AwsClientOptions
	readonly calls: S3Call[]
} {
	const calls: S3Call[] = []
	const options: AwsClientOptions = {
		origin: ORIGIN,
		region: 'eu-central-1',
		credentials,
		fetch: async (url, init) => {
			const parsed = new URL(url)
			const headers = init.headers !== undefined && !(init.headers instanceof Headers) && !Array.isArray(init.headers) ? init.headers : {}
			const sent = init.body
			let payload: Uint8Array
			if (sent instanceof Uint8Array) payload = sent
			else payload = new TextEncoder().encode(typeof sent === 'string' ? sent : '')
			const method = init.method ?? ''
			const operation = method === 'POST' && parsed.searchParams.has('uploads')
				? 'CreateMultipartUpload'
				: method === 'PUT' && parsed.searchParams.has('partNumber')
				? 'UploadPart'
				: method === 'POST'
				? 'CompleteMultipartUpload'
				: method === 'DELETE' && parsed.searchParams.has('uploadId')
				? 'AbortMultipartUpload'
				: method === 'PUT'
				? 'PutObject'
				: 'DeleteObject'
			const call = { operation, method, query: parsed.search, bytes: payload.byteLength, body: new TextDecoder().decode(payload.slice(0, 2000)) }
			calls.push(call)
			const signed = (headers['authorization'] ?? '').includes('/eu-central-1/s3/aws4_request')
				&& headers['x-amz-content-sha256'] === (await sha256Hex(payload))
				&& headers['x-amz-expected-bucket-owner'] === ACCOUNT
			if (!signed || parsed.origin !== ORIGIN || parsed.pathname !== `/${KEY}`) {
				return new Response('<Error><Code>FakeRequestRefused</Code></Error>', { status: 400 })
			}
			const override = overrides[operation]
			if (override !== undefined) return override(call, calls)
			switch (operation) {
				case 'CreateMultipartUpload':
					return new Response(
						`<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${KEY}</Key><UploadId>up~1</UploadId></InitiateMultipartUploadResult>`,
					)
				case 'UploadPart':
					return new Response(null, { headers: { etag: `"etag-${parsed.searchParams.get('partNumber') ?? ''}"` } })
				case 'CompleteMultipartUpload':
					// S3's own form: whitespace sent to keep the connection open, the declaration, the namespace.
					return new Response(
						`\n  \n<?xml version="1.0" encoding="UTF-8"?>\n<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
							+ `<Location>${ORIGIN}/${KEY}</Location><Bucket>${BUCKET}</Bucket><Key>${KEY}</Key><ETag>"x-3"</ETag></CompleteMultipartUploadResult>`,
					)
				case 'PutObject':
					return new Response(null, { headers: { etag: '"single"' } })
				default:
					return new Response(null, { status: 204 })
			}
		},
	}
	return { options, calls }
}

const part = (fill: number) => new Uint8Array(S3_PART_BYTES).fill(fill)
const signal = new AbortController().signal
const slowDown = () => new Response('<Error><Code>SlowDown</Code><Message>reduce your rate</Message></Error>', { status: 503 })

describe('s3PartWriter', () => {
	test('uploads the parts in order and completes them as one object', async () => {
		const { options, calls } = fakeS3()
		const writer = s3PartWriter(options, ADDRESS)
		expect(writer.partBytes).toBe(S3_PART_BYTES)
		await writer.writePart(0, part(1), signal)
		await writer.writePart(1, part(2), signal)
		const last = new TextEncoder().encode('the tail')
		await writer.complete({ last, parts: 3, bytes: 2 * S3_PART_BYTES + last.byteLength }, signal)
		expect(calls.map((call) => [call.method, call.query, call.bytes])).toEqual([
			['POST', '?uploads=', 0],
			['PUT', '?partNumber=1&uploadId=up~1', S3_PART_BYTES],
			['PUT', '?partNumber=2&uploadId=up~1', S3_PART_BYTES],
			['PUT', '?partNumber=3&uploadId=up~1', last.byteLength],
			['POST', '?uploadId=up~1', calls[4]?.bytes ?? 0],
		])
		expect(calls[4]?.body).toBe(
			'<CompleteMultipartUpload>'
				+ '<Part><PartNumber>1</PartNumber><ETag>&quot;etag-1&quot;</ETag></Part>'
				+ '<Part><PartNumber>2</PartNumber><ETag>&quot;etag-2&quot;</ETag></Part>'
				+ '<Part><PartNumber>3</PartNumber><ETag>&quot;etag-3&quot;</ETag></Part>'
				+ '</CompleteMultipartUpload>',
		)
	})

	test('an archive of one part is a single object, with no upload started', async () => {
		const { options, calls } = fakeS3()
		const last = new TextEncoder().encode('small')
		await s3PartWriter(options, ADDRESS).complete({ last, parts: 1, bytes: last.byteLength }, signal)
		expect(calls.map((call) => [call.method, call.query])).toEqual([['PUT', '']])
	})

	test('a part S3 answers with a retryable error is sent again, a bounded number of times', async () => {
		const flaky = fakeS3({
			UploadPart: (call, calls) =>
				calls.filter((earlier) => earlier.operation === 'UploadPart').length === 1 ? slowDown() : new Response(null, { headers: { etag: '"etag-1"' } }),
		})
		await s3PartWriter(flaky.options, ADDRESS).writePart(0, part(1), signal)
		expect(flaky.calls.map((call) => call.operation)).toEqual(['CreateMultipartUpload', 'UploadPart', 'UploadPart'])
		const down = fakeS3({ UploadPart: slowDown })
		await expect(s3PartWriter(down.options, ADDRESS).writePart(0, part(1), signal)).rejects.toMatchObject({ code: 'SlowDown', retryable: true })
		expect(down.calls.filter((call) => call.operation === 'UploadPart').length).toBe(S3_PART_ATTEMPTS)
	})

	test('a completion answered 200 with an error, or for another key, completes nothing', async () => {
		const answers = [
			'<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>InternalError</Code><Message>retry</Message></Error>',
			'<CompleteMultipartUploadResult><Key>other</Key></CompleteMultipartUploadResult>',
		]
		for (const answer of answers) {
			const { options } = fakeS3({ CompleteMultipartUpload: () => new Response(answer) })
			const writer = s3PartWriter(options, ADDRESS)
			await writer.writePart(0, part(1), signal)
			await expect(writer.complete({ last: new Uint8Array([1]), parts: 2, bytes: S3_PART_BYTES + 1 }, signal)).rejects.toMatchObject({
				code: 'invalid_answer',
			})
		}
	})

	test("an error answer is S3's code, never its message, and a part without its ETag is no answer", async () => {
		const denied = fakeS3({
			UploadPart: () =>
				new Response('<Error><Code>AccessDenied</Code><Message>key sources/secret</Message><RequestId>REQ123</RequestId></Error>', { status: 403 }),
		})
		const failure = await s3PartWriter(denied.options, ADDRESS).writePart(0, part(1), signal).catch((error: unknown) => error)
		expect(failure).toMatchObject({ operation: 'UploadPart', code: 'AccessDenied', status: 403, requestId: 'REQ123', retryable: false })
		expect(String(failure)).not.toContain('sources/secret')
		const bare = fakeS3({ UploadPart: () => new Response(null) })
		await expect(s3PartWriter(bare.options, ADDRESS).writePart(0, part(1), signal)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('abort drops the upload first, and deletes the object only once a call that makes it was sent', async () => {
		const started = fakeS3()
		const writer = s3PartWriter(started.options, ADDRESS)
		await writer.writePart(0, part(1), signal)
		await writer.abort(signal)
		expect(started.calls.at(-1)).toMatchObject({ operation: 'AbortMultipartUpload', query: '?uploadId=up~1' })

		// The last part failed: the completion was never sent, so no object of this attempt can exist.
		const tail = fakeS3({
			UploadPart: (
				call,
			) => (call.query.startsWith('?partNumber=2') ? new Response(null, { status: 403 }) : new Response(null, { headers: { etag: '"e"' } })),
		})
		const failing = s3PartWriter(tail.options, ADDRESS)
		await failing.writePart(0, part(1), signal)
		await expect(failing.complete({ last: new Uint8Array([1]), parts: 2, bytes: S3_PART_BYTES + 1 }, signal)).rejects.toMatchObject({ code: 'unknown' })
		await failing.abort(signal)
		expect(tail.calls.map((call) => call.operation)).not.toContain('DeleteObject')

		// The completion was sent and its answer lost: abort the upload, then delete the object it may have made.
		const lost = fakeS3({ CompleteMultipartUpload: () => new Response(null, { status: 500 }) })
		const completing = s3PartWriter(lost.options, ADDRESS)
		await completing.writePart(0, part(1), signal)
		await expect(completing.complete({ last: new Uint8Array([1]), parts: 2, bytes: S3_PART_BYTES + 1 }, signal)).rejects.toMatchObject({
			code: 'unknown',
		})
		await completing.abort(signal)
		expect(lost.calls.slice(-2).map((call) => call.operation)).toEqual(['AbortMultipartUpload', 'DeleteObject'])

		// An upload S3 no longer knows has nothing left to drop.
		const gone = fakeS3({ AbortMultipartUpload: () => new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 }) })
		const forgotten = s3PartWriter(gone.options, ADDRESS)
		await forgotten.writePart(0, part(1), signal)
		await forgotten.abort(signal)

		// Nothing written, nothing to drop.
		const idle = fakeS3()
		await s3PartWriter(idle.options, ADDRESS).abort(signal)
		expect(idle.calls).toEqual([])
	})

	test('refuses what Control never does: a part out of turn or of another size, counts that disagree, a second complete', async () => {
		const { options, calls } = fakeS3()
		const writer = s3PartWriter(options, ADDRESS)
		await expect(writer.writePart(1, part(1), signal)).rejects.toThrow('out of turn')
		await expect(writer.writePart(0, new Uint8Array(10), signal)).rejects.toThrow('of another size')
		await expect(writer.complete({ last: new Uint8Array(1), parts: 2, bytes: 1 }, signal)).rejects.toThrow('disagree')
		expect(calls).toEqual([])
		await writer.complete({ last: new Uint8Array(1), parts: 1, bytes: 1 }, signal)
		await expect(writer.complete({ last: new Uint8Array(1), parts: 1, bytes: 1 }, signal)).rejects.toThrow('disagree')
	})

	test('refuses an address of another form: a key with a dot segment or a space, a dotted bucket, a region or account', () => {
		const { options } = fakeS3()
		for (
			const change of [{ key: 'sources/../other/x' }, { key: 'sources/./x' }, { key: 'key with space' }, { bucket: 'dotted.bucket' }, {
				region: 'Frankfurt',
			}, { accountId: '1234' }]
		) {
			expect(() => s3PartWriter(options, { ...ADDRESS, ...change })).toThrow('S3')
		}
		expect(() => s3BucketOrigin(BUCKET, 'eu-central-1.evil.example')).toThrow('S3')
		expect(() => awsSourceKey('notes', 'prod', 'not-a-token')).toThrow('S3')
		expect(() => awsSourceKey('../notes', 'prod', TOKEN)).toThrow('S3')
		expect(KEY).toBe(`sources/notes/prod/${TOKEN}.tar.gz`)
	})
})

describe('s3PresignedGet', () => {
	test("signs a GET of exactly this object, the bucket in the host, with the credentials' session token", async () => {
		const session = { current: () => Promise.resolve({ accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session-token' }) }
		const url = new URL(await s3PresignedGet(session, ADDRESS, new Date('2026-11-24T12:00:00Z')))
		expect(url.origin).toBe('https://fabrika-apps-sources.s3.eu-central-1.amazonaws.com')
		expect(url.pathname).toBe(`/${KEY}`)
		expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
		expect(url.searchParams.get('X-Amz-Date')).toBe('20261124T120000Z')
		expect(url.searchParams.get('X-Amz-Credential')).toBe('ASIAEXAMPLE/20261124/eu-central-1/s3/aws4_request')
		expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-token')
		expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
	})

	test('refuses an address or an expiry of another form', async () => {
		const at = new Date()
		await expect(s3PresignedGet(credentials, { ...ADDRESS, bucket: 'dotted.bucket' }, at)).rejects.toThrow('S3')
		await expect(s3PresignedGet(credentials, { ...ADDRESS, key: 'sources/../x' }, at)).rejects.toThrow('S3')
		await expect(s3PresignedGet(credentials, { ...ADDRESS, region: 'Frankfurt' }, at)).rejects.toThrow('S3')
		await expect(s3PresignedGet(credentials, ADDRESS, at, 30)).rejects.toThrow('the expiry')
	})
})
