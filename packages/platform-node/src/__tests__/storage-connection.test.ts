// One storage connection for the three stores (N5 in docs/ideas/cloud-providers.md): what the variables under a prefix
// mean, the container credentials a container cloud's task signs with, and the client that follows their rotation.
// No backend: the container credentials endpoint is a fake fetch, and the clients are recorded, not built.

import { describe, expect, spyOn, test } from 'bun:test'
import { type S3ClientOptions, storageClients } from '../blob-s3'
import {
	containerCredentials,
	CREDENTIAL_REFRESH_BEFORE_MS,
	CREDENTIAL_RETRY_MS,
	credentialProvider,
	parseStorageConnection,
	type StorageConnection,
	StorageConnectionError,
	storageConnectionProblems,
} from '../storage-connection'

const HOUR = 3_600_000
const PREFIX = 'FABRIKA_APP_STORAGE'
const SECRET = 's'.repeat(40)
const URI = '/v2/credentials/0f1e2d3c-task'
const staticSet = (extra: Record<string, string> = {}): Record<string, string> => ({
	FABRIKA_APP_STORAGE_ENDPOINT: 'https://storage.example.test',
	FABRIKA_APP_STORAGE_BUCKET: 'notes-files',
	FABRIKA_APP_STORAGE_ACCESS_KEY_ID: 'access-key-id',
	FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY: SECRET,
	...extra,
})
const options = { defaultRegion: 'us-east-1', endpoint: 'required' as const, environment: { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: URI } }

function problems(variables: Record<string, string>, environment: Record<string, string> = options.environment): readonly string[] {
	try {
		parseStorageConnection(variables, PREFIX, { ...options, environment })
	} catch (error) {
		expect(error).toBeInstanceOf(StorageConnectionError)
		expect(String(error)).not.toContain(SECRET)
		return storageConnectionProblems(error) ?? []
	}
	throw new Error('the connection was not refused')
}

describe('parseStorageConnection', () => {
	test('nothing set opens nothing', () => {
		expect(parseStorageConnection({}, PREFIX, options)).toBeUndefined()
		expect(parseStorageConnection({ OTHER_BUCKET: 'x' }, PREFIX, options)).toBeUndefined()
	})

	test("today's variables read as before: the key pair, path-style, the caller's default region", () => {
		expect(parseStorageConnection(staticSet(), PREFIX, options)).toEqual({
			bucket: 'notes-files',
			endpoint: 'https://storage.example.test',
			region: 'us-east-1',
			addressing: 'path',
			credentials: { kind: 'static', accessKeyId: 'access-key-id', secretAccessKey: SECRET },
		})
	})

	test('a region, virtual addressing and an explicit static source are taken', () => {
		const connection = parseStorageConnection(
			staticSet({ FABRIKA_APP_STORAGE_REGION: 'eu-central-1', FABRIKA_APP_STORAGE_ADDRESSING: 'virtual', FABRIKA_APP_STORAGE_CREDENTIALS: 'static' }),
			PREFIX,
			options,
		)
		expect(connection).toMatchObject({ region: 'eu-central-1', addressing: 'virtual', credentials: { kind: 'static' } })
	})

	test('container credentials take no key pair and no endpoint, and read the path from the container environment', () => {
		const connection = parseStorageConnection(
			{ FABRIKA_APP_STORAGE_BUCKET: 'notes-files', FABRIKA_APP_STORAGE_REGION: 'eu-central-1', FABRIKA_APP_STORAGE_CREDENTIALS: 'container' },
			PREFIX,
			{ ...options, endpoint: 'optional' },
		)
		expect(connection).toEqual({
			bucket: 'notes-files',
			region: 'eu-central-1',
			addressing: 'path',
			credentials: { kind: 'container', relativeUri: URI },
		})
	})

	test('each malformed or missing value is named, and none is quoted', () => {
		expect(problems(staticSet({ FABRIKA_APP_STORAGE_REGION: 'EU Central' }))).toEqual([
			'FABRIKA_APP_STORAGE_REGION is not a region name (lowercase letters, digits and hyphens)',
		])
		expect(problems(staticSet({ FABRIKA_APP_STORAGE_ADDRESSING: 'subdomain' }))).toEqual(["FABRIKA_APP_STORAGE_ADDRESSING is 'path' or 'virtual'"])
		expect(problems(staticSet({ FABRIKA_APP_STORAGE_CREDENTIALS: 'instance' }))).toContain("FABRIKA_APP_STORAGE_CREDENTIALS is 'static' or 'container'")
		for (
			const endpoint of [
				`https://user:${SECRET}@storage.example.test`,
				'https://storage.example.test/?x=1',
				'https://storage.example.test/#f',
				'https:storage.example.test',
				'ftp://storage.example.test',
			]
		) {
			expect(problems(staticSet({ FABRIKA_APP_STORAGE_ENDPOINT: endpoint }))).toEqual([
				'FABRIKA_APP_STORAGE_ENDPOINT is not an http(s) URL without credentials, a query or a fragment',
			])
		}
		// A path is kept: the form of Zerops' `apiUrl` is not recorded.
		expect(parseStorageConnection(staticSet({ FABRIKA_APP_STORAGE_ENDPOINT: 'https://storage.example.test/s3' }), PREFIX, options)?.endpoint).toBe(
			'https://storage.example.test/s3',
		)
		expect(problems({ FABRIKA_APP_STORAGE_REGION: 'eu-central-1' })).toContain('FABRIKA_APP_STORAGE_BUCKET is not set')
		expect(problems({ FABRIKA_APP_STORAGE_BUCKET: 'notes-files', FABRIKA_APP_STORAGE_ACCESS_KEY_ID: 'access-key-id' })).toEqual([
			'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY is not set; the platform writes every FABRIKA_APP_STORAGE_* variable together',
			'FABRIKA_APP_STORAGE_ENDPOINT is not set; the platform writes every FABRIKA_APP_STORAGE_* variable together',
		])
	})

	test('a key pair beside container credentials, or a container without its endpoint path, is refused', () => {
		expect(problems(staticSet({ FABRIKA_APP_STORAGE_CREDENTIALS: 'container' }))).toEqual([
			"FABRIKA_APP_STORAGE_ACCESS_KEY_ID is set, but FABRIKA_APP_STORAGE_CREDENTIALS is 'container'",
			"FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY is set, but FABRIKA_APP_STORAGE_CREDENTIALS is 'container'",
		])
		const container = { FABRIKA_APP_STORAGE_BUCKET: 'notes-files', FABRIKA_APP_STORAGE_CREDENTIALS: 'container' }
		for (const uri of ['', 'v2/credentials', '//attacker.test/x', '/v2/../../etc', 'http://attacker.test/x', '/v2/credentials?x=1']) {
			expect(problems(container, { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: uri })).toEqual([
				"FABRIKA_APP_STORAGE_CREDENTIALS is 'container', but AWS_CONTAINER_CREDENTIALS_RELATIVE_URI is not a path the container credentials endpoint serves",
			])
		}
	})

	test('an optional endpoint may be left out of a static set', () => {
		const withoutEndpoint = Object.fromEntries(Object.entries(staticSet()).filter(([name]) => name !== 'FABRIKA_APP_STORAGE_ENDPOINT'))
		expect(parseStorageConnection(withoutEndpoint, PREFIX, { ...options, endpoint: 'optional' })).not.toHaveProperty('endpoint')
	})
})

/** A fake container credentials endpoint: each answer in turn, and every request it was sent. */
function endpoint(answers: readonly (() => Response)[]) {
	const requests: { readonly url: string; readonly redirect: RequestRedirect | undefined }[] = []
	let next = 0
	const fetch = (url: string, init: RequestInit): Promise<Response> => {
		requests.push({ url, redirect: init.redirect })
		const answer = answers[Math.min(next++, answers.length - 1)]
		return Promise.resolve(answer === undefined ? new Response(null, { status: 500 }) : answer())
	}
	return { fetch, requests }
}

const credentials = (id: string, expiresAt: number): Response =>
	Response.json({ AccessKeyId: id, SecretAccessKey: `${id}-secret`, Token: `${id}-token`, Expiration: new Date(expiresAt).toISOString() })

/** Lets a refresh the provider started in the background settle. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The error lines `work` logged. */
async function logged(work: () => Promise<void>): Promise<string[]> {
	const lines: string[] = []
	const log = spyOn(console, 'error').mockImplementation((line: unknown) => {
		lines.push(String(line))
	})
	try {
		await work()
	} finally {
		log.mockRestore()
	}
	return lines
}

describe('containerCredentials', () => {
	test('fetches at the link-local origin with no redirect followed; near the expiry the held set answers while a refresh runs', async () => {
		let now = 1_000_000
		const fake = endpoint([() => credentials('first', 1_000_000 + HOUR), () => credentials('second', 1_000_000 + 2 * HOUR)])
		const provider = containerCredentials(URI, { fetch: fake.fetch, now: () => now })
		expect(await provider.current()).toEqual({
			accessKeyId: 'first',
			secretAccessKey: 'first-secret',
			sessionToken: 'first-token',
			expiresAt: 1_000_000 + HOUR,
		})
		now += HOUR - CREDENTIAL_REFRESH_BEFORE_MS - 1
		expect((await provider.current()).accessKeyId).toBe('first')
		expect(fake.requests).toHaveLength(1)
		now += 1
		expect((await provider.current()).accessKeyId).toBe('first')
		await settled()
		expect((await provider.current()).accessKeyId).toBe('second')
		expect(fake.requests).toEqual([
			{ url: `http://169.254.170.2${URI}`, redirect: 'manual' },
			{ url: `http://169.254.170.2${URI}`, redirect: 'manual' },
		])
	})

	test('a failing refresh is retried only after its wait, keeps the valid set, and logs once per failing streak', async () => {
		let now = 0
		const fake = endpoint([
			() => credentials('held', HOUR),
			() => new Response(null, { status: 500 }),
			() => new Response(null, { status: 500 }),
			() => credentials('next', 2 * HOUR),
		])
		const provider = containerCredentials(URI, { fetch: fake.fetch, now: () => now })
		const lines = await logged(async () => {
			expect((await provider.current()).accessKeyId).toBe('held')
			now = HOUR - CREDENTIAL_REFRESH_BEFORE_MS
			for (let call = 0; call < 5; call++) {
				expect((await provider.current()).accessKeyId).toBe('held')
				await settled()
			}
			expect(fake.requests).toHaveLength(2)
			now += CREDENTIAL_RETRY_MS
			expect((await provider.current()).accessKeyId).toBe('held')
			await settled()
			expect(fake.requests).toHaveLength(3)
			now += CREDENTIAL_RETRY_MS
			await provider.current()
			await settled()
			expect((await provider.current()).accessKeyId).toBe('next')
		})
		expect(lines).toEqual(['fabrika: the container credentials could not be refreshed'])
	})

	test('a set that is already expired, or no longer than the held one, never replaces it', async () => {
		let now = 0
		const fake = endpoint([() => credentials('held', HOUR), () => credentials('stale', 10), () => credentials('shorter', HOUR - 1)])
		const provider = containerCredentials(URI, { fetch: fake.fetch, now: () => now })
		await logged(async () => {
			expect((await provider.current()).accessKeyId).toBe('held')
			now = HOUR - CREDENTIAL_REFRESH_BEFORE_MS
			await provider.current()
			await settled()
			now += CREDENTIAL_RETRY_MS
			await provider.current()
			await settled()
			expect((await provider.current()).accessKeyId).toBe('held')
			// The shorter set started a wait: the next call within it asks nothing.
			await provider.current()
			await settled()
			expect(fake.requests).toHaveLength(3)
		})
	})

	test('a first set that arrives expired is no credentials, and a call within the wait fails without asking', async () => {
		let now = HOUR
		const fake = endpoint([() => credentials('stale', 10)])
		const provider = containerCredentials(URI, { fetch: fake.fetch, now: () => now })
		await logged(async () => {
			await expect(provider.current()).rejects.toThrow('the container credentials could not be read')
			now += 1_000
			await expect(provider.current()).rejects.toThrow('the container credentials could not be read')
		})
		expect(fake.requests).toHaveLength(1)
	})

	test('an answer is read until the limit and no further', async () => {
		let pulled = 0
		let cancelled = false
		const endless = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++
				controller.enqueue(new Uint8Array(4096))
			},
			cancel() {
				cancelled = true
			},
		})
		await logged(async () => {
			await expect(containerCredentials(URI, { fetch: endpoint([() => new Response(endless)]).fetch }).current()).rejects.toThrow()
			const declared = () => new Response('{}', { headers: { 'Content-Length': String(64 * 1024) } })
			await expect(containerCredentials(URI, { fetch: endpoint([declared]).fetch }).current()).rejects.toThrow()
		})
		expect(cancelled).toBe(true)
		expect(pulled).toBeLessThan(8)
	})

	test('callers that ask together share one fetch', async () => {
		const fake = endpoint([() => credentials('only', Date.now() + HOUR)])
		const provider = containerCredentials(URI, { fetch: fake.fetch })
		const sets = await Promise.all([provider.current(), provider.current(), provider.current()])
		expect(new Set(sets.map((set) => set.accessKeyId))).toEqual(new Set(['only']))
		expect(fake.requests).toHaveLength(1)
	})

	test('a failed refresh keeps a set that is still valid, and an expired one fails with a fixed message', async () => {
		let now = 0
		const fake = endpoint([() => credentials('held', HOUR), () => new Response('internal detail', { status: 500 })])
		const provider = containerCredentials(URI, { fetch: fake.fetch, now: () => now })
		await logged(async () => {
			expect((await provider.current()).accessKeyId).toBe('held')
			now = HOUR - 1_000
			expect((await provider.current()).accessKeyId).toBe('held')
			await settled()
			now = HOUR
			const raised = await provider.current().then(() => null, (error: unknown) => error)
			expect(String(raised)).toBe('Error: the container credentials could not be read')
		})
	})

	test('a redirect, a malformed answer and an oversized one are no credentials', async () => {
		for (
			const answer of [
				() => new Response(null, { status: 302, headers: { location: 'http://attacker.test/' } }),
				() => Response.json({ AccessKeyId: 'a', SecretAccessKey: 'b' }),
				() => Response.json({ AccessKeyId: 'a', SecretAccessKey: 'b', Token: 'c', Expiration: 'soon' }),
				() => new Response('not json'),
				() => new Response('x'.repeat(17 * 1024)),
			]
		) {
			const provider = containerCredentials(URI, { fetch: endpoint([answer]).fetch })
			await logged(async () => {
				await expect(provider.current()).rejects.toThrow('the container credentials could not be read')
			})
		}
	})

	test('a static source hands its key pair as given, without a fetch', async () => {
		const provider = credentialProvider({ kind: 'static', accessKeyId: 'id', secretAccessKey: SECRET })
		expect(await provider.current()).toEqual({ accessKeyId: 'id', secretAccessKey: SECRET })
	})
})

describe('storageClients', () => {
	const connection: StorageConnection = {
		bucket: 'notes-files',
		region: 'eu-central-1',
		addressing: 'virtual',
		credentials: { kind: 'container', relativeUri: URI },
	}

	test('builds one client per set of credentials, with the connection and the set it signs with', async () => {
		let now = 0
		const fake = endpoint([() => credentials('first', HOUR), () => credentials('second', 2 * HOUR)])
		const built: S3ClientOptions[] = []
		const clients = storageClients(connection, containerCredentials(URI, { fetch: fake.fetch, now: () => now }), (options) => {
			built.push(options)
			return new Bun.S3Client(options)
		})
		const first = await clients()
		expect(await clients()).toBe(first)
		now = HOUR
		expect(await clients()).not.toBe(first)
		expect(built).toEqual([
			{
				bucket: 'notes-files',
				accessKeyId: 'first',
				secretAccessKey: 'first-secret',
				sessionToken: 'first-token',
				region: 'eu-central-1',
				virtualHostedStyle: true,
			},
			{
				bucket: 'notes-files',
				accessKeyId: 'second',
				secretAccessKey: 'second-secret',
				sessionToken: 'second-token',
				region: 'eu-central-1',
				virtualHostedStyle: true,
			},
		])
	})

	test('fixed credentials keep one client', async () => {
		let count = 0
		const fixed: StorageConnection = {
			...connection,
			endpoint: 'http://127.0.0.1:1',
			addressing: 'path',
			credentials: { kind: 'static', accessKeyId: 'id', secretAccessKey: SECRET },
		}
		const clients = storageClients(fixed, credentialProvider(fixed.credentials), (options) => {
			count++
			expect(options).toMatchObject({ endpoint: 'http://127.0.0.1:1', virtualHostedStyle: false })
			return new Bun.S3Client(options)
		})
		await clients()
		await clients()
		expect(count).toBe(1)
	})
})
