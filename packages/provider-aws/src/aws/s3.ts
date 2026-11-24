// The S3 calls the source upload makes (the AWS idea's checklist, step 5): one object written in parts, of the shape
// Control's source client takes (`SourcePartWriter` in `packages/control/src/github/source/types.ts`, structurally: a
// provider imports nothing of Control). Control cuts the repository's archive into parts and hands each here in order;
// the object exists only once `complete` ran, which Control calls after the archive passed its verdict.
//
// - Every part but the last is `S3_PART_BYTES`, which S3 takes as a multipart part (at least 5 MiB) and Control as a
//   part size (a multiple of 256 KiB). The upload starts on the first part; an archive that fits one part never starts
//   one and is a single `PutObject`.
// - Each part is signed with its SHA-256 (`x-amz-content-sha256`), so S3 refuses a part that changed in transit.
// - `CompleteMultipartUpload` can answer 200 with an error in its body: only a `CompleteMultipartUploadResult` for this
//   key completes it.
// - `abort` drops the upload's parts and, once `complete` was called, the object a lost answer may hide.
//
// UNVERIFIED: the operations' query parameters, the answers' element names and S3's part bounds follow S3's API
// reference; none was checked against an account.

import {
	type AwsClientOptions,
	type AwsCredentialSource,
	AwsError,
	type AwsExchange,
	awsExchange,
	ERROR_CODE,
	REQUEST_ID,
	retryable,
} from './transport'
import { parseXml, type XmlElement, xmlText } from './xml'

/** The size of every part but the last: 8 MiB, a multiple of 256 KiB and above S3's 5 MiB minimum. */
export const S3_PART_BYTES = 8 * 1024 * 1024
/** The most parts S3 takes in one upload: an object of up to 80 GB at this part size. */
export const S3_MAX_PARTS = 10_000
/** A bucket's name: lower-case letters, digits and hyphens, no dot (a dotted name breaks the wildcard certificate). */
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
/** An object's key: segments of unreserved characters, which the signer takes as a path without encoding. */
const OBJECT_KEY = /^(?=.{1,1024}$)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/
/** An upload id, as S3 writes it: printable ASCII. */
const UPLOAD_ID = /^[\x21-\x7e]{1,1024}$/
/** An entity tag, as S3 writes it: a quoted token. */
const ETAG = /^"[\x21\x23-\x7e]{1,256}"$/

/** How long the build's read of the source stays valid: it fetches within minutes of the start. */
export const S3_PRESIGNED_READ_SECONDS = 15 * 60
/** A region code. */
const REGION = /^[a-z]{2,4}(?:-[a-z]{1,10}){1,3}-\d{1,2}$/

/**
 * A presigned `GET` of `key` in `bucket`, valid `expiresInSeconds` (60 to 3600): the URL the build fetches the source
 * with, signed by `Bun.S3Client` with the credentials current now (a session token travels in the URL). The URL is a
 * credential: it is handed to the build as a plain variable of one start and never logged or persisted.
 */
export async function s3PresignedGet(
	credentials: AwsCredentialSource,
	region: string,
	bucket: string,
	key: string,
	expiresInSeconds = S3_PRESIGNED_READ_SECONDS,
): Promise<string> {
	if (!REGION.test(region) || !BUCKET.test(bucket) || !OBJECT_KEY.test(key)) {
		throw new Error('S3: the region, bucket or key is not one this provider names')
	}
	if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3600) {
		throw new Error('S3: the expiry is not one this provider signs')
	}
	const { accessKeyId, secretAccessKey, sessionToken } = await credentials.current()
	const client = new Bun.S3Client({
		accessKeyId,
		secretAccessKey,
		...(sessionToken === undefined ? {} : { sessionToken }),
		region,
		bucket,
		endpoint: `https://s3.${region}.amazonaws.com`,
		virtualHostedStyle: true,
	})
	return client.file(key).presign({ method: 'GET', expiresIn: expiresInSeconds })
}

/** The virtual-hosted origin of `bucket` in `region` in the commercial partition: `https://<bucket>.s3.<region>.amazonaws.com`. */
export function s3BucketOrigin(bucket: string, region: string): string {
	if (!BUCKET.test(bucket)) throw new Error('S3: the bucket is not one this provider names')
	return `https://${bucket}.s3.${region}.amazonaws.com`
}

/** Writes one object in parts, as Control's source client takes it (`SourcePartWriter`). */
export interface S3PartWriter {
	readonly partBytes: number
	writePart(index: number, bytes: Uint8Array, signal: AbortSignal): Promise<void>
	complete(upload: { readonly last: Uint8Array; readonly parts: number; readonly bytes: number }, signal: AbortSignal): Promise<void>
	abort(signal: AbortSignal): Promise<void>
}

/** Text with XML's five special characters written as references. */
function escaped(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

/** The bytes as a fresh `Uint8Array` over its own `ArrayBuffer`, as a request body takes them. */
function body(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy
}

/**
 * The object `key` in the bucket at `options.origin` (`s3BucketOrigin`), written in parts. The writer refuses calls out
 * of the order Control makes them: a part out of turn or of another size, `complete` with counts that disagree with the
 * parts written, a second `complete`.
 */
export function s3PartWriter(options: AwsClientOptions, key: string): S3PartWriter {
	if (!OBJECT_KEY.test(key)) throw new Error('S3: the object key is not one this provider names')
	const path = `/${key}`
	let uploadId: string | null = null
	const etags: string[] = []
	let completeCalled = false
	let written = 0

	/** One S3 call; an error answer is its `Error/Code`, never its message. */
	const call = async (
		operation: string,
		request: {
			readonly method: 'PUT' | 'POST' | 'DELETE'
			readonly query: readonly (readonly [string, string])[]
			readonly body: string | Uint8Array<ArrayBuffer>
		},
		signal: AbortSignal,
	): Promise<AwsExchange> => {
		const answer = await awsExchange('s3', options, operation, { ...request, path, headers: {}, bodyDigestHeader: true }, signal)
		if (answer.ok) return answer
		let code = 'unknown'
		let requestId = answer.requestId
		try {
			const error = parseXml(answer.text)
			const read = error.name === 'Error' ? xmlText(error, 'Code') : null
			if (read !== null && ERROR_CODE.test(read)) code = read
			const id = requestId ?? (error.name === 'Error' ? xmlText(error, 'RequestId') : null)
			requestId = id !== null && REQUEST_ID.test(id) ? id : null
		} catch {
			// An error answer without a readable body keeps the code `unknown`.
		}
		throw new AwsError(operation, code, answer.status, requestId, retryable(code, answer.status))
	}
	const invalid = (operation: string, answer: AwsExchange): AwsError =>
		new AwsError(operation, 'invalid_answer', answer.status, answer.requestId, false)
	/** The answer's XML root, named `name` and naming this key, else `invalid_answer`. */
	const result = (operation: string, answer: AwsExchange, name: string): XmlElement => {
		let root: XmlElement
		try {
			root = parseXml(answer.text)
		} catch {
			throw invalid(operation, answer)
		}
		// `CompleteMultipartUpload` can answer 200 with an `Error` in its body: only its result completes the upload.
		if (root.name !== name) throw invalid(operation, answer)
		let named: string | null
		try {
			named = xmlText(root, 'Key')
		} catch {
			throw invalid(operation, answer)
		}
		// An answer about another object is no answer to this call.
		if (named !== key) throw invalid(operation, answer)
		return root
	}
	const etagOf = (operation: string, answer: AwsExchange): string => {
		const etag = answer.headers.get('etag')
		if (etag === null || !ETAG.test(etag)) throw invalid(operation, answer)
		return etag
	}

	return {
		partBytes: S3_PART_BYTES,

		async writePart(index, bytes, signal) {
			if (completeCalled || index !== written || bytes.byteLength !== S3_PART_BYTES || index + 1 >= S3_MAX_PARTS) {
				throw new Error('S3: a part out of turn, of another size, or past the most parts')
			}
			if (uploadId === null) {
				const operation = 'CreateMultipartUpload'
				const created = await call(operation, { method: 'POST', query: [['uploads', '']], body: '' }, signal)
				const root = result(operation, created, 'InitiateMultipartUploadResult')
				let id: string | null
				try {
					id = xmlText(root, 'UploadId')
				} catch {
					throw invalid(operation, created)
				}
				if (id === null || !UPLOAD_ID.test(id)) throw invalid(operation, created)
				uploadId = id
			}
			const operation = 'UploadPart'
			const uploaded = await call(
				operation,
				{ method: 'PUT', query: [['partNumber', String(index + 1)], ['uploadId', uploadId]], body: body(bytes) },
				signal,
			)
			etags.push(etagOf(operation, uploaded))
			// Counted once S3 stored it: the next part's turn.
			written += 1
		},

		async complete(upload, signal) {
			if (completeCalled || upload.parts !== written + 1 || upload.bytes !== written * S3_PART_BYTES + upload.last.byteLength) {
				throw new Error('S3: complete with counts that disagree with the parts written')
			}
			if (upload.last.byteLength > S3_PART_BYTES || (written > 0 && upload.last.byteLength === 0)) {
				throw new Error('S3: a last part of another size')
			}
			completeCalled = true
			if (uploadId === null) {
				// One part only: a single object, no upload to start or complete.
				const operation = 'PutObject'
				etagOf(operation, await call(operation, { method: 'PUT', query: [], body: body(upload.last) }, signal))
				return
			}
			const id = uploadId
			const last = await call(
				'UploadPart',
				{ method: 'PUT', query: [['partNumber', String(written + 1)], ['uploadId', id]], body: body(upload.last) },
				signal,
			)
			etags.push(etagOf('UploadPart', last))
			const parts = etags.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escaped(etag)}</ETag></Part>`).join('')
			const operation = 'CompleteMultipartUpload'
			const completed = await call(
				operation,
				{ method: 'POST', query: [['uploadId', id]], body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>` },
				signal,
			)
			result(operation, completed, 'CompleteMultipartUploadResult')
		},

		async abort(signal) {
			// Best effort: the caller ignores a failure here, and each step runs whatever the one before did.
			const steps: Promise<unknown>[] = []
			if (uploadId !== null) {
				steps.push(
					call('AbortMultipartUpload', { method: 'DELETE', query: [['uploadId', uploadId]], body: '' }, signal).catch((error: unknown) => {
						// An upload S3 no longer knows has nothing left to drop.
						if (!(error instanceof AwsError && error.code === 'NoSuchUpload')) throw error
					}),
				)
			}
			// A `complete` whose answer was lost may have made the object.
			if (completeCalled) steps.push(call('DeleteObject', { method: 'DELETE', query: [], body: '' }, signal))
			const settled = await Promise.allSettled(steps)
			const failed = settled.find((outcome) => outcome.status === 'rejected')
			if (failed !== undefined && failed.status === 'rejected') throw failed.reason
		},
	}
}
