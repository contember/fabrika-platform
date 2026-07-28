// Opt-in setup for the S3-backed tests. Same rule as the Postgres helper: configure it and they run,
// leave it unconfigured and they skip with a message. Point it at MinIO (what Zerops object storage
// is) or at a real R2 bucket — the implementation under test is the same either way.
//
//   docker run --rm -d -p 59000:9000 -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
//     quay.io/minio/minio server /data
//   docker run --rm --network host --entrypoint sh quay.io/minio/mc -c \
//     'mc alias set local http://127.0.0.1:59000 minioadmin minioadmin && mc mb local/fabrika-test'
//   FABRIKA_TEST_S3_ENDPOINT=http://127.0.0.1:59000 FABRIKA_TEST_S3_BUCKET=fabrika-test \
//     FABRIKA_TEST_S3_ACCESS_KEY_ID=… FABRIKA_TEST_S3_SECRET_ACCESS_KEY=… bun test
//
// The credentials are read here and passed straight into the client — never logged, never asserted on.

import type { S3BlobStoreOptions } from '../../blob-s3'

const PREFIX = 'FABRIKA_TEST_S3_'

/** Connection options from the environment, or null when these tests should skip. */
export const s3Options: S3BlobStoreOptions | null = readOptions()

/** True when a real S3-compatible endpoint is configured. Use as `describe.skipIf(!hasS3)`. */
export const hasS3 = s3Options !== null

export const skipReason =
	`skipped: set ${PREFIX}ENDPOINT / ${PREFIX}BUCKET / ${PREFIX}ACCESS_KEY_ID / ${PREFIX}SECRET_ACCESS_KEY to run the S3-backed tests`

function readOptions(): S3BlobStoreOptions | null {
	const bucket = process.env[`${PREFIX}BUCKET`]
	const accessKeyId = process.env[`${PREFIX}ACCESS_KEY_ID`]
	const secretAccessKey = process.env[`${PREFIX}SECRET_ACCESS_KEY`]
	if (bucket === undefined || accessKeyId === undefined || secretAccessKey === undefined) {
		return null
	}
	const endpoint = process.env[`${PREFIX}ENDPOINT`]
	return {
		bucket,
		accessKeyId,
		secretAccessKey,
		// MinIO defaults to path-style addressing; R2 and AWS accept it too, so it is the portable default.
		virtualHostedStyle: false,
		region: process.env[`${PREFIX}REGION`] ?? 'auto',
		...(endpoint !== undefined ? { endpoint } : {}),
	}
}
