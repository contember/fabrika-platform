// The S3 calls the source upload makes (the AWS idea's checklist, step 5): one object written in parts, of the shape
// Control's source client takes (`SourcePartWriter` in `packages/control/src/github/source/types.ts`, structurally: a
// provider imports nothing of Control), and the presigned read the build fetches it with. Control cuts the repository's
// archive into parts and hands each here in order; the object exists only once `complete` ran, which Control calls
// after the archive passed its verdict.
//
// - Every part but the last is `S3_PART_BYTES`, which S3 takes as a multipart part (at least 5 MiB) and Control as a
//   part size (a multiple of 256 KiB). The upload starts on the first part; an archive that fits one part never starts
//   one and is a single `PutObject`.
// - Each part is signed with its SHA-256 (`x-amz-content-sha256`), so S3 refuses a part that changed in transit; every
//   call names the bucket's owner (`x-amz-expected-bucket-owner`), so an archive never lands in a bucket of that name
//   another account holds.
// - A part S3 answers with a retryable error is sent again, at most `S3_PART_ATTEMPTS` times: the same part number with
//   the same bytes is idempotent.
// - `CompleteMultipartUpload` can take minutes on a large upload and answer 200 with an error in its body: it has its
//   own deadline, and only a `CompleteMultipartUploadResult` for this key completes it.
// - `abort` drops the upload's parts, then, if `PutObject` or `CompleteMultipartUpload` was sent, the object a lost
//   answer may hide. That delete removes whatever the key holds, so a key is one attempt's own: `awsSourceKey` puts the
//   run's build token in it.
//
// UNVERIFIED: the operations' query parameters and headers, the answers' element names, S3's part bounds and that a
// slow completion sends whitespace before its answer follow S3's API reference; none was checked against an account.

import { presignGet } from './sigv4'
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
/** How often a part (or the single object) is sent when S3 answers it with a retryable error. */
export const S3_PART_ATTEMPTS = 3
/** The deadline of `CompleteMultipartUpload`, which S3 may take minutes to answer. */
export const S3_COMPLETE_TIMEOUT_MS = 10 * 60 * 1000
/** How long the build's read of the source stays valid: it fetches within minutes of the start. */
export const S3_PRESIGNED_READ_SECONDS = 15 * 60
/** A bucket's name: lower-case letters, digits and hyphens, no dot (a dotted name breaks the wildcard certificate). */
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
/** An object's key: segments of unreserved characters, none of them `.` or `..`, as the signer takes a path. */
const OBJECT_KEY = /^(?=.{1,1024}$)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/
/** A region code. */
const REGION = /^[a-z]{2,4}(?:-[a-z]{1,10}){1,3}-\d{1,2}$/
/** A 12-digit account id. */
const ACCOUNT_ID = /^\d{12}$/
/** An upload id, as S3 writes it: printable ASCII. */
const UPLOAD_ID = /^[\x21-\x7e]{1,1024}$/
/** An entity tag, as S3 writes it: a quoted token. */
const ETAG = /^"[\x21\x23-\x7e]{1,256}"$/
/** An application's id and environment, as they name the source's key. */
const NAME_PART = /^[a-z0-9][a-z0-9-]{0,62}$/
/** A build token: a lowercase UUID. */
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The virtual-hosted origin of `bucket` in `region` in the commercial partition: `https://<bucket>.s3.<region>.amazonaws.com`. */
export function s3BucketOrigin(bucket: string, region: string): string {
	if (!BUCKET.test(bucket) || !REGION.test(region)) throw new Error('S3: the bucket or region is not one this provider names')
	return `https://${bucket}.s3.${region}.amazonaws.com`
}

/**
 * The key of one run's source archive: under the application environment's own prefix, with the run's build token, so
 * no two attempts share a key and a role scoped to `sources/<app>/<env>/` reaches no other application's archive.
 */
export function awsSourceKey(appId: string, env: string, buildToken: string): string {
	if (!NAME_PART.test(appId) || !NAME_PART.test(env) || !TOKEN.test(buildToken)) throw new Error('S3: the source key is not one this provider names')
	return `sources/${appId}/${env}/${buildToken}.tar.gz`
}

/** Where one object lives: its bucket, the bucket's region and owning account, and its key. */
export interface S3ObjectAddress {
	readonly bucket: string
	readonly region: string
	readonly accountId: string
	readonly key: string
}

function checkAddress(address: S3ObjectAddress): void {
	if (!BUCKET.test(address.bucket) || !REGION.test(address.region) || !ACCOUNT_ID.test(address.accountId) || !OBJECT_KEY.test(address.key)) {
		throw new Error('S3: the bucket, region, account or key is not one this provider names')
	}
}

/**
 * A presigned `GET` of the object, valid `expiresInSeconds` (60 to 3600): the URL the build fetches the source with,
 * signed by this package's signer (`presignGet`) with the credentials current now, the bucket in the host. The URL is a
 * credential that opens this one object until it expires: it reaches the build as a Parameter Store value, never a
 * plain variable, and is never logged.
 */
export async function s3PresignedGet(
	credentials: AwsCredentialSource,
	address: S3ObjectAddress,
	at: Date,
	expiresInSeconds = S3_PRESIGNED_READ_SECONDS,
): Promise<string> {
	checkAddress(address)
	if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 3600) {
		throw new Error('S3: the expiry is not one this provider signs')
	}
	return presignGet(
		{ origin: s3BucketOrigin(address.bucket, address.region), path: `/${address.key}` },
		await credentials.current(),
		{ region: address.region, service: 's3' },
		at,
		expiresInSeconds,
	)
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

/** S3's XML, read after the whitespace a slow answer may send before it to keep the connection open. */
function parsedAnswer(text: string): XmlElement {
	return parseXml(text.replace(/^[ \t\r\n]+/, ''))
}

/** Waits `ms`, or rejects once `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
			return
		}
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop)
			resolve()
		}, ms)
		const stop = (): void => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		signal.addEventListener('abort', stop, { once: true })
	})
}

/**
 * The object at `address` (the bucket at `options.origin`, which is `s3BucketOrigin` of it), written in parts. The writer
 * refuses calls out of the order Control makes them: a part out of turn or of another size, `complete` with counts that
 * disagree with the parts written, a second `complete`.
 */
export function s3PartWriter(options: AwsClientOptions, address: S3ObjectAddress): S3PartWriter {
	checkAddress(address)
	const { key } = address
	const path = `/${key}`
	const headers = { 'x-amz-expected-bucket-owner': address.accountId }
	let uploadId: string | null = null
	const etags: string[] = []
	let completeCalled = false
	// Whether a call that makes the object was sent: only then does `abort` delete it.
	let objectMayExist = false
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
		callOptions: AwsClientOptions = options,
	): Promise<AwsExchange> => {
		const answer = await awsExchange('s3', callOptions, operation, { ...request, path, headers, bodyDigestHeader: true }, signal)
		if (answer.ok) return answer
		let code = 'unknown'
		let requestId = answer.requestId
		try {
			const error = parsedAnswer(answer.text)
			const read = error.name === 'Error' ? xmlText(error, 'Code') : null
			if (read !== null && ERROR_CODE.test(read)) code = read
			const id = requestId ?? (error.name === 'Error' ? xmlText(error, 'RequestId') : null)
			requestId = id !== null && REQUEST_ID.test(id) ? id : null
		} catch {
			// An error answer without a readable body keeps the code `unknown`.
		}
		throw new AwsError(operation, code, answer.status, requestId, retryable(code, answer.status))
	}
	/** A call S3 may answer with a retryable error, sent again with a short backoff, at most `S3_PART_ATTEMPTS` times. */
	const repeated = async (
		operation: string,
		request: { readonly method: 'PUT'; readonly query: readonly (readonly [string, string])[]; readonly body: Uint8Array<ArrayBuffer> },
		signal: AbortSignal,
	): Promise<AwsExchange> => {
		for (let attempt = 1;; attempt += 1) {
			try {
				return await call(operation, request, signal)
			} catch (error) {
				if (!(error instanceof AwsError) || !error.retryable || attempt >= S3_PART_ATTEMPTS || signal.aborted) throw error
				await pause(200 * 4 ** (attempt - 1), signal)
			}
		}
	}
	const invalid = (operation: string, answer: AwsExchange): AwsError =>
		new AwsError(operation, 'invalid_answer', answer.status, answer.requestId, false)
	/** The answer's XML root, named `name` and naming this key, else `invalid_answer`. */
	const result = (operation: string, answer: AwsExchange, name: string): XmlElement => {
		let root: XmlElement
		try {
			root = parsedAnswer(answer.text)
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
			const uploaded = await repeated(
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
				objectMayExist = true
				etagOf(operation, await repeated(operation, { method: 'PUT', query: [], body: body(upload.last) }, signal))
				return
			}
			const id = uploadId
			const last = await repeated('UploadPart', {
				method: 'PUT',
				query: [['partNumber', String(written + 1)], ['uploadId', id]],
				body: body(upload.last),
			}, signal)
			etags.push(etagOf('UploadPart', last))
			const parts = etags.map((etag, index) => `<Part><PartNumber>${index + 1}</PartNumber><ETag>${escaped(etag)}</ETag></Part>`).join('')
			const operation = 'CompleteMultipartUpload'
			objectMayExist = true
			const completed = await call(
				operation,
				{ method: 'POST', query: [['uploadId', id]], body: `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>` },
				signal,
				{ ...options, timeoutMs: Math.max(options.timeoutMs ?? 0, S3_COMPLETE_TIMEOUT_MS) },
			)
			result(operation, completed, 'CompleteMultipartUploadResult')
		},

		async abort(signal) {
			// Best effort, the caller ignores a failure. In order: a completion still running may make the object after a
			// delete, so the upload is aborted first. An upload whose start answer was lost has no id here; only the
			// bucket's rule that aborts incomplete uploads (the namespace stack's) reclaims it.
			if (uploadId !== null) {
				try {
					await call('AbortMultipartUpload', { method: 'DELETE', query: [['uploadId', uploadId]], body: '' }, signal)
				} catch (error) {
					// An upload S3 no longer knows (completed, or aborted already) has no parts left to drop.
					if (!(error instanceof AwsError && error.code === 'NoSuchUpload')) throw error
				}
			}
			if (objectMayExist) await call('DeleteObject', { method: 'DELETE', query: [], body: '' }, signal)
		},
	}
}
