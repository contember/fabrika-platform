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
const REQUIRED_NAMES = [`${PREFIX}BUCKET`, `${PREFIX}ACCESS_KEY_ID`, `${PREFIX}SECRET_ACCESS_KEY`]

export interface S3TestEnvironment {
	[name: string]: string | undefined
}

/** Connection options from the environment, or null when these tests should skip. */
export const s3Options: S3BlobStoreOptions | null = readS3Options(process.env)

/** True when a real S3-compatible endpoint is configured. Use as `describe.skipIf(!hasS3)`. */
export const hasS3 = s3Options !== null

export const skipReason = `skipped: set ${PREFIX}BUCKET / ${PREFIX}ACCESS_KEY_ID / ${PREFIX}SECRET_ACCESS_KEY to run the S3-backed tests`

/** No configuration skips; a partial configuration is an error rather than a false green. */
export function readS3Options(environment: S3TestEnvironment): S3BlobStoreOptions | null {
	const configured = REQUIRED_NAMES.filter((name) => present(environment[name]))
	if (configured.length === 0) {
		return null
	}
	const missing = REQUIRED_NAMES.filter((name) => !present(environment[name]))
	if (missing.length > 0) {
		throw new Error(`Incomplete S3 test configuration; missing ${missing.join(', ')}`)
	}

	const endpoint = optional(environment[`${PREFIX}ENDPOINT`])
	return {
		bucket: required(environment, `${PREFIX}BUCKET`),
		accessKeyId: required(environment, `${PREFIX}ACCESS_KEY_ID`),
		secretAccessKey: required(environment, `${PREFIX}SECRET_ACCESS_KEY`),
		// MinIO defaults to path-style addressing; R2 and AWS accept it too, so it is the portable default.
		virtualHostedStyle: false,
		region: optional(environment[`${PREFIX}REGION`]) ?? 'auto',
		...(endpoint !== undefined ? { endpoint } : {}),
	}
}

function present(value: string | undefined): boolean {
	return value !== undefined && value !== ''
}

function optional(value: string | undefined): string | undefined {
	return present(value) ? value : undefined
}

function required(environment: S3TestEnvironment, name: string): string {
	const value = environment[name]
	if (value === undefined || value === '') {
		throw new Error(`Missing ${name}`)
	}
	return value
}
