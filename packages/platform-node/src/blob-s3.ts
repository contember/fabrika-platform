// `BlobStore` over S3-compatible object storage, using Bun's built-in S3 client (`Bun.S3Client`).
//
// ONE implementation covers both targets the platform has: Cloudflare R2 and Zerops object storage
// (MinIO) are both S3-compatible, so the only difference is the endpoint and the credentials. That is
// also why this does not depend on `@aws-sdk/client-s3` — the built-in client speaks the same
// protocol, ships with the runtime, and keeps credentials in one object instead of a middleware stack.
//
// Divergence from the R2 binding worth knowing: R2's `get()` returns null for a missing key in the
// same round trip, whereas S3 needs a HEAD first. `get()` therefore costs one extra request on a hit.
// Nothing here logs the credentials, the endpoint, or an error object that might quote a signed URL.

import {
	type BlobStore,
	type FileObjectStore,
	ObjectExistsError,
	type ObjectMetadata,
	ObjectTooLargeError,
	type ObjectWriteOptions,
	type StoredObject,
} from '@fabrika/platform'

/** Connection details for an S3-compatible bucket. `endpoint` is what makes it R2, MinIO, or AWS. */
export interface S3BlobStoreOptions {
	bucket: string
	accessKeyId: string
	secretAccessKey: string
	/** e.g. `https://<account>.r2.cloudflarestorage.com` (R2) or `http://storage:9000` (Zerops/MinIO). */
	endpoint?: string
	/** Required by AWS; R2 wants `auto`; MinIO ignores it. */
	region?: string
	/** Temporary-credential session token, when the deployment uses one. */
	sessionToken?: string
	/** `https://<bucket>.<host>` addressing. MinIO normally wants this OFF (path-style). */
	virtualHostedStyle?: boolean
}

/** The blob body handed back by `get()` — a stream, opened lazily and only once, plus a text shortcut. */
interface BlobBody {
	body: ReadableStream
	text(): Promise<string>
}

export class S3BlobStore implements BlobStore, FileObjectStore {
	constructor(private readonly client: Bun.S3Client) {}

	/** Build a store from plain connection options. Never logs them. */
	static connect(options: S3BlobStoreOptions): S3BlobStore {
		return new S3BlobStore(
			new Bun.S3Client({
				bucket: options.bucket,
				accessKeyId: options.accessKeyId,
				secretAccessKey: options.secretAccessKey,
				...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
				...(options.region !== undefined ? { region: options.region } : {}),
				...(options.sessionToken !== undefined ? { sessionToken: options.sessionToken } : {}),
				...(options.virtualHostedStyle !== undefined ? { virtualHostedStyle: options.virtualHostedStyle } : {}),
			}),
		)
	}

	async put(key: string, value: string | ArrayBuffer | ReadableStream): Promise<void> {
		// The S3 client takes bytes or a Response, not a bare stream — wrapping a stream in a Response
		// is what lets it be uploaded without buffering the whole body first.
		const payload = value instanceof ReadableStream ? new Response(value) : value
		await this.client.write(key, payload)
	}

	async get(key: string): Promise<BlobBody | null> {
		const file = this.client.file(key)
		if (!(await file.exists())) {
			return null
		}
		let stream: ReadableStream | undefined
		return {
			// Lazy + memoised, matching R2: the body is one stream, consumable once.
			get body(): ReadableStream {
				stream ??= file.stream()
				return stream
			},
			text: () => file.text(),
		}
	}

	async delete(key: string): Promise<void> {
		await this.client.delete(key)
	}

	async write(key: string, body: ReadableStream<Uint8Array>, options: ObjectWriteOptions): Promise<ObjectMetadata> {
		// Bun's client sends no `If-None-Match`; a file's key is a fresh UUID behind a unique row, and a download checks
		// the version the scan recorded, so this check refuses a reused key rather than racing a concurrent writer.
		if ((await statOrNull(this.client.file(key))) !== null) {
			await body.cancel()
			throw new ObjectExistsError()
		}
		let size = 0
		// Erroring the transform cancels `body` and fails the upload, so no more than one chunk past the limit is read.
		const bounded = body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					size += chunk.byteLength
					if (size > options.maxBytes) {
						controller.error(new ObjectTooLargeError(options.maxBytes))
						return
					}
					controller.enqueue(chunk)
				},
			}),
		)
		try {
			await this.client.write(key, new Response(bounded), { type: options.contentType })
		} catch (error) {
			await this.client.delete(key).catch(() => undefined)
			throw size > options.maxBytes ? new ObjectTooLargeError(options.maxBytes) : error
		}
		return { size, contentType: options.contentType }
	}

	read(key: string, signal?: AbortSignal): Promise<StoredObject | null> {
		return this.#get(key, {}, signal)
	}

	readVersion(key: string, version: string, signal?: AbortSignal): Promise<StoredObject | null> {
		return this.#get(key, { 'If-Match': version }, signal)
	}

	/**
	 * One GET through a short-lived presigned URL, so the ETag, the size and the body come from the same answer and a
	 * conditional header can be sent, which `Bun.S3File` does not offer. Errors never carry the URL: it is signed.
	 */
	async #get(key: string, headers: Readonly<Record<string, string>>, signal: AbortSignal | undefined): Promise<StoredObject | null> {
		const url = this.client.file(key).presign({ method: 'GET', expiresIn: PRESIGNED_READ_SECONDS })
		let response: Response
		try {
			response = await fetch(url, { headers, ...(signal === undefined ? {} : { signal }) })
		} catch {
			throw new Error(signal?.aborted === true ? 'the object read was stopped' : 'the object store did not answer a read')
		}
		if (response.status === 404 || response.status === 412) {
			await response.body?.cancel()
			return null
		}
		const version = response.headers.get('ETag')
		const size = Number(response.headers.get('Content-Length'))
		if (!response.ok || response.body === null || version === null || !Number.isSafeInteger(size)) {
			await response.body?.cancel()
			throw new Error(`the object store answered a read with ${response.status}`)
		}
		const type = response.headers.get('Content-Type')
		return { size, contentType: type === null || type === '' ? null : type, version, body: response.body }
	}
}

const PRESIGNED_READ_SECONDS = 60

/** One HEAD; a missing key is `null`, any other failure propagates. */
async function statOrNull(file: Bun.S3File): Promise<Bun.S3Stats | null> {
	try {
		return await file.stat()
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'NoSuchKey') {
			return null
		}
		throw error
	}
}
