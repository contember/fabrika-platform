// The S3 part writer and the presigned read against a fake bucket: the calls a multipart upload makes in order, a single
// object for an archive of one part, the completion read strictly, the abort, every call signed with its body's digest,
// and the calls Control would never make refused.

import { describe, expect, test } from 'bun:test'
import { S3_PART_BYTES, s3BucketOrigin, s3PartWriter, s3PresignedGet } from '../aws/s3'
import { sha256Hex } from '../aws/sigv4'
import type { AwsClientOptions } from '../aws/transport'

const BUCKET = 'fabrika-apps-sources'
const KEY = 'sources/run-1/source.tar.gz'
const ORIGIN = s3BucketOrigin(BUCKET, 'eu-central-1')
const credentials = { current: () => Promise.resolve({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }) }

interface S3Call {
	readonly method: string
	readonly query: string
	readonly bytes: number
	readonly body: string
}

/** A fake bucket: what each S3 operation answers, and the calls it got. A call not signed for `s3` with its body's digest is refused. */
function fakeS3(
	overrides: Readonly<Record<string, (call: S3Call) => Response>> = {},
): { readonly options: AwsClientOptions; readonly calls: S3Call[] } {
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
			const call = { method: init.method ?? '', query: parsed.search, bytes: payload.byteLength, body: new TextDecoder().decode(payload.slice(0, 2000)) }
			calls.push(call)
			const signed = (headers['authorization'] ?? '').includes('/eu-central-1/s3/aws4_request')
				&& headers['x-amz-content-sha256'] === (await sha256Hex(payload))
			if (!signed || parsed.origin !== ORIGIN || parsed.pathname !== `/${KEY}`) {
				return new Response('<Error><Code>FakeRequestRefused</Code></Error>', { status: 400 })
			}
			const operation = call.method === 'POST' && parsed.searchParams.has('uploads')
				? 'CreateMultipartUpload'
				: call.method === 'PUT' && parsed.searchParams.has('partNumber')
				? 'UploadPart'
				: call.method === 'POST'
				? 'CompleteMultipartUpload'
				: call.method === 'DELETE' && parsed.searchParams.has('uploadId')
				? 'AbortMultipartUpload'
				: call.method === 'PUT'
				? 'PutObject'
				: 'DeleteObject'
			const override = overrides[operation]
			if (override !== undefined) return override(call)
			switch (operation) {
				case 'CreateMultipartUpload':
					return new Response(
						`<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${KEY}</Key><UploadId>up~1</UploadId></InitiateMultipartUploadResult>`,
					)
				case 'UploadPart':
					return new Response(null, { headers: { etag: `"etag-${parsed.searchParams.get('partNumber') ?? ''}"` } })
				case 'CompleteMultipartUpload':
					return new Response(
						`<CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${KEY}</Key><ETag>"x-4"</ETag></CompleteMultipartUploadResult>`,
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

describe('s3PartWriter', () => {
	test('uploads the parts in order and completes them as one object', async () => {
		const { options, calls } = fakeS3()
		const writer = s3PartWriter(options, KEY)
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
		await s3PartWriter(options, KEY).complete({ last, parts: 1, bytes: last.byteLength }, signal)
		expect(calls.map((call) => [call.method, call.query])).toEqual([['PUT', '']])
	})

	test('a completion answered 200 with an error, or for another key, completes nothing', async () => {
		for (
			const answer of [
				'<Error><Code>InternalError</Code><Message>retry</Message></Error>',
				'<CompleteMultipartUploadResult><Key>other</Key></CompleteMultipartUploadResult>',
			]
		) {
			const { options } = fakeS3({ CompleteMultipartUpload: () => new Response(answer) })
			const writer = s3PartWriter(options, KEY)
			await writer.writePart(0, part(1), signal)
			const last = new Uint8Array([1])
			await expect(writer.complete({ last, parts: 2, bytes: S3_PART_BYTES + 1 }, signal)).rejects.toMatchObject({ code: 'invalid_answer' })
		}
	})

	test("an error answer is S3's code, never its message, and a part without its ETag is no answer", async () => {
		const denied = fakeS3({
			UploadPart: () =>
				new Response('<Error><Code>AccessDenied</Code><Message>key sources/secret</Message><RequestId>REQ123</RequestId></Error>', { status: 403 }),
		})
		const failure = await s3PartWriter(denied.options, KEY).writePart(0, part(1), signal).catch((error: unknown) => error)
		expect(failure).toMatchObject({ operation: 'UploadPart', code: 'AccessDenied', status: 403, requestId: 'REQ123', retryable: false })
		expect(String(failure)).not.toContain('sources/secret')
		const bare = fakeS3({ UploadPart: () => new Response(null) })
		await expect(s3PartWriter(bare.options, KEY).writePart(0, part(1), signal)).rejects.toMatchObject({ code: 'invalid_answer' })
	})

	test('abort drops the upload, and the object once complete was called', async () => {
		const started = fakeS3()
		const writer = s3PartWriter(started.options, KEY)
		await writer.writePart(0, part(1), signal)
		await writer.abort(signal)
		expect(started.calls.at(-1)).toMatchObject({ method: 'DELETE', query: '?uploadId=up~1' })

		const lost = fakeS3({ CompleteMultipartUpload: () => new Response(null, { status: 500 }) })
		const completing = s3PartWriter(lost.options, KEY)
		await completing.writePart(0, part(1), signal)
		await expect(completing.complete({ last: new Uint8Array([1]), parts: 2, bytes: S3_PART_BYTES + 1 }, signal)).rejects.toMatchObject({
			code: 'unknown',
		})
		await completing.abort(signal)
		expect(lost.calls.slice(-2).map((call) => [call.method, call.query])).toEqual([['DELETE', '?uploadId=up~1'], ['DELETE', '']])

		// An upload S3 no longer knows has nothing left to drop.
		const gone = fakeS3({ AbortMultipartUpload: () => new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 }) })
		const forgotten = s3PartWriter(gone.options, KEY)
		await forgotten.writePart(0, part(1), signal)
		await forgotten.abort(signal)

		// Nothing written, nothing to drop.
		const idle = fakeS3()
		await s3PartWriter(idle.options, KEY).abort(signal)
		expect(idle.calls).toEqual([])
	})

	test('refuses what Control never does: a part out of turn or of another size, counts that disagree, a second complete', async () => {
		const { options, calls } = fakeS3()
		const writer = s3PartWriter(options, KEY)
		await expect(writer.writePart(1, part(1), signal)).rejects.toThrow('out of turn')
		await expect(writer.writePart(0, new Uint8Array(10), signal)).rejects.toThrow('of another size')
		await expect(writer.complete({ last: new Uint8Array(1), parts: 2, bytes: 1 }, signal)).rejects.toThrow('disagree')
		expect(calls).toEqual([])
		await writer.complete({ last: new Uint8Array(1), parts: 1, bytes: 1 }, signal)
		await expect(writer.complete({ last: new Uint8Array(1), parts: 1, bytes: 1 }, signal)).rejects.toThrow('disagree')
		expect(() => s3PartWriter(options, 'key with space')).toThrow('the object key')
		expect(() => s3BucketOrigin('dotted.bucket', 'eu-central-1')).toThrow('the bucket')
	})
})

describe('s3PresignedGet', () => {
	test('signs a GET of the object for its region, with the session token when the credentials have one', async () => {
		const session = { current: () => Promise.resolve({ accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'session-token' }) }
		const url = new URL(await s3PresignedGet(session, 'eu-central-1', BUCKET, KEY))
		expect(url.protocol).toBe('https:')
		expect(url.href).toContain(BUCKET)
		expect(url.pathname.endsWith(`/${KEY}`)).toBe(true)
		expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
		expect(url.searchParams.get('X-Amz-Credential')).toContain('/eu-central-1/s3/aws4_request')
		expect(url.searchParams.get('X-Amz-Security-Token')).toBe('session-token')
		expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
	})

	test('refuses a bucket, key, region or expiry of another form', async () => {
		await expect(s3PresignedGet(credentials, 'eu-central-1', 'dotted.bucket', KEY)).rejects.toThrow('S3')
		await expect(s3PresignedGet(credentials, 'eu-central-1', BUCKET, 'a key')).rejects.toThrow('S3')
		await expect(s3PresignedGet(credentials, 'Frankfurt', BUCKET, KEY)).rejects.toThrow('S3')
		await expect(s3PresignedGet(credentials, 'eu-central-1', BUCKET, KEY, 30)).rejects.toThrow('the expiry')
	})
})
