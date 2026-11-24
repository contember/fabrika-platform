// The application's object storage as the platform's variables describe it: which region its requests are signed for.
// An S3 bucket refuses a signature for another region than its own, so a provider whose storage checks it writes
// FABRIKA_APP_STORAGE_REGION; without it the store signs for us-east-1, as every release before the variable did.

import { afterAll, describe, expect, test } from 'bun:test'
import { openFileStorage } from '../bun'
import { BootError } from '../implement/boot'

/** Every presigned read the store sent, by its URL. */
const requests: URL[] = []
const server = Bun.serve({
	port: 0,
	hostname: '127.0.0.1',
	fetch: (request) => {
		requests.push(new URL(request.url))
		return new Response(null, { status: 404 })
	},
})
afterAll(() => server.stop(true))

const storage = (extra: Record<string, string> = {}): Record<string, string> => ({
	FABRIKA_APP_STORAGE_ENDPOINT: `http://127.0.0.1:${server.port}`,
	FABRIKA_APP_STORAGE_BUCKET: 'notes-files',
	FABRIKA_APP_STORAGE_ACCESS_KEY_ID: 'access-key-id',
	FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY: 's'.repeat(32),
	...extra,
})

/** The region the store signed its read of `key` for: the third field of `X-Amz-Credential`. */
async function signedRegion(variables: Record<string, string>, key: string): Promise<string | undefined> {
	const store = openFileStorage(variables)
	if (store === undefined) throw new Error('no storage was opened')
	expect(await store.read(key)).toBeNull()
	const request = requests.find((url) => url.pathname.endsWith(`/${key}`))
	return request?.searchParams.get('X-Amz-Credential')?.split('/')[2]
}

describe('openFileStorage', () => {
	test('signs for us-east-1 without a region, as before the variable', async () => {
		expect(await signedRegion(storage(), 'default-region')).toBe('us-east-1')
	})

	test('signs for the region the platform names', async () => {
		expect(await signedRegion(storage({ FABRIKA_APP_STORAGE_REGION: 'eu-central-1' }), 'named-region')).toBe('eu-central-1')
	})

	test('keeps path-style addressing, so the endpoint names the host', async () => {
		await signedRegion(storage({ FABRIKA_APP_STORAGE_REGION: 'auto' }), 'path-style')
		expect(requests.find((url) => url.pathname === '/notes-files/path-style')?.host).toBe(`127.0.0.1:${server.port}`)
	})

	test('opens nothing without any storage variable', () => {
		expect(openFileStorage({})).toBeUndefined()
	})

	test("opens a store over the task's own credentials, their path read from the captured variables, without asking for them yet", () => {
		const container = {
			FABRIKA_APP_STORAGE_BUCKET: 'notes-files',
			FABRIKA_APP_STORAGE_REGION: 'eu-central-1',
			FABRIKA_APP_STORAGE_CREDENTIALS: 'container',
			AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task',
		}
		expect(openFileStorage(container)).toBeDefined()
	})

	test('an endpoint in container mode is taken: an S3 VPC endpoint is one', () => {
		const viaEndpoint = {
			FABRIKA_APP_STORAGE_ENDPOINT: 'https://bucket.vpce-0a1b2c3d.s3.eu-central-1.vpce.amazonaws.com',
			FABRIKA_APP_STORAGE_BUCKET: 'notes-files',
			FABRIKA_APP_STORAGE_CREDENTIALS: 'container',
			AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task',
		}
		expect(openFileStorage(viaEndpoint)).toBeDefined()
	})

	test.each([
		['a region without the storage it names', { FABRIKA_APP_STORAGE_REGION: 'eu-central-1' }],
		['a region no store spells', storage({ FABRIKA_APP_STORAGE_REGION: 'EU Central' })],
		['a partial set', { FABRIKA_APP_STORAGE_ENDPOINT: 'http://127.0.0.1:1', FABRIKA_APP_STORAGE_REGION: 'eu-central-1' }],
		['a key pair beside container credentials', storage({ FABRIKA_APP_STORAGE_CREDENTIALS: 'container' })],
		['container credentials without the endpoint path', { FABRIKA_APP_STORAGE_BUCKET: 'notes-files', FABRIKA_APP_STORAGE_CREDENTIALS: 'container' }],
		['an addressing no store takes', storage({ FABRIKA_APP_STORAGE_ADDRESSING: 'subdomain' })],
	])('stops the boot for %s, quoting no credential', (_name, variables) => {
		let raised: unknown
		try {
			openFileStorage(variables)
		} catch (error) {
			raised = error
		}
		expect(raised).toBeInstanceOf(BootError)
		expect(String(raised)).not.toContain('s'.repeat(32))
	})
})
