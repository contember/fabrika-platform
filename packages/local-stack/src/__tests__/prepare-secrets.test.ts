import { decodeZeropsNamespaceProxySource, verifyZeropsNamespaceProxySource } from '@fabrika/provider-zerops'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { LOCAL_SOURCE_FIXTURE_DIRECTORY, LOCAL_SOURCE_PLATFORM_REPOSITORY } from '../local-source-contract'
import { loadLocalSourceFixtures } from '../local-source-fixtures/fixture'
import { COMPOSE_FILE, prepareLocalSecrets, prepareLocalSourceConfiguration } from '../prepare'
import { LOCAL_GITHUB_APPS_FILE, LOCAL_SOURCE_CONNECTIONS, readLocalGitHubApps } from '../source-connection-fixture'

let directory: string

beforeEach(() => {
	directory = mkdtempSync(resolve(tmpdir(), 'fabrika-storage-'))
})

afterEach(() => {
	rmSync(directory, { recursive: true, force: true })
})

const control = 'FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID=existing-key\n'
	+ 'FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY=existing-secret=with-padding\n'

const operations = 'FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID=existing-key\n'
	+ 'FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY=existing-secret=with-padding\n'

const notes = 'FABRIKA_PROXY_SECRET=existing-proxy-secret\n'
	+ 'FABRIKA_APP_STORAGE_ACCESS_KEY_ID=notes\n'
	+ 'FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY=existing-storage-secret\n'

async function seedExistingState(): Promise<void> {
	for (
		const file of [
			'platform-db.env',
			'apps-db.env',
			'iam.env',
			'platform-proxy.env',
			'apps-proxy.env',
			'apps-proxy-secret.env',
			'emulator.env',
		]
	) {
		await Bun.write(resolve(directory, file), 'EXISTING_VALUE=must-not-rotate\n')
	}
	await Bun.write(resolve(directory, 'notes.env'), notes)
	await Bun.write(resolve(directory, 'control.env'), control)
	await Bun.write(resolve(directory, 'operations.env'), operations)
}

async function snapshotEnvironment(): Promise<Record<string, string>> {
	const files = readdirSync(directory).filter((file) => file.endsWith('.env'))
	return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await Bun.file(resolve(directory, file)).text()])))
}

describe('local storage preparation', () => {
	test('migrates existing credentials without rotating any environment or requiring minio.env', async () => {
		await seedExistingState()
		const before = await snapshotEnvironment()
		await prepareLocalSecrets(directory)
		expect(await snapshotEnvironment()).toEqual(before)
		expect(await Bun.file(resolve(directory, 'object-storage-identities.json')).json()).toEqual({
			identities: [{
				name: 'fabrika-local',
				credentials: [{ accessKey: 'existing-key', secretKey: 'existing-secret=with-padding' }],
				actions: [
					'Read:run-logs',
					'Write:run-logs',
					'List:run-logs',
					'Read:operations-payloads',
					'Write:operations-payloads',
					'List:operations-payloads',
				],
			}],
		})
		rmSync(resolve(directory, 'object-storage-identities.json'))
		await prepareLocalSecrets(directory)
		expect(await snapshotEnvironment()).toEqual(before)
	})

	test("gives the apps storage the Notes bucket's identity, and asks for a reset when notes.env predates the contract", async () => {
		await seedExistingState()
		await prepareLocalSecrets(directory)
		expect(await Bun.file(resolve(directory, 'apps-storage-identities.json')).json()).toEqual({
			identities: [{
				name: 'notes',
				credentials: [{ accessKey: 'notes', secretKey: 'existing-storage-secret' }],
				actions: ['Read:notes-files', 'Write:notes-files', 'List:notes-files'],
			}],
		})
		await Bun.write(resolve(directory, 'notes.env'), 'NOTES_DATABASE_URL=postgres://legacy\n')
		await expect(prepareLocalSecrets(directory)).rejects.toThrow('explicitly reset the local stack')
	})

	test('retains a legacy minio.env unchanged and takes credentials from the services', async () => {
		await seedExistingState()
		const legacy = 'MINIO_ROOT_USER=unused-legacy-key\nMINIO_ROOT_PASSWORD=unused-legacy-secret\n'
		await Bun.write(resolve(directory, 'minio.env'), legacy)
		await prepareLocalSecrets(directory)
		expect(await Bun.file(resolve(directory, 'minio.env')).text()).toBe(legacy)
		expect(await Bun.file(resolve(directory, 'object-storage-identities.json')).text()).not.toContain('unused-legacy')
	})

	test('creates a fresh authenticated store and reuses its generated keys on subsequent preparation', async () => {
		await prepareLocalSecrets(directory)
		const before = await snapshotEnvironment()
		const controlEnv = before['control.env'] ?? ''
		const operationsEnv = before['operations.env'] ?? ''
		const secret = controlEnv.match(/^FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY=(.+)$/m)?.[1]
		expect(secret).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{42}$/)
		expect(operationsEnv).toContain(`FABRIKA_OPERATIONS_BLOB_SECRET_ACCESS_KEY=${secret}\n`)
		expect(await Bun.file(resolve(directory, 'object-storage-identities.json')).json()).toMatchObject({
			identities: [{ credentials: [{ accessKey: 'fabrika-local', secretKey: secret }] }],
		})
		expect(existsSync(resolve(directory, 'minio.env'))).toBe(false)
		await prepareLocalSecrets(directory)
		expect(await snapshotEnvironment()).toEqual(before)
	})

	test.each([
		['missing', 'FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID=existing-key\n'],
		['mismatched', operations.replace('existing-secret', 'different-secret')],
		['duplicate', `${operations}FABRIKA_OPERATIONS_BLOB_ACCESS_KEY_ID=another-key\n`],
		['malformed', `${operations}not-an-environment-entry\n`],
	])('rejects %s storage credentials without changing existing files', async (_name, contents) => {
		await seedExistingState()
		await Bun.write(resolve(directory, 'operations.env'), contents)
		const before = await snapshotEnvironment()
		await expect(prepareLocalSecrets(directory)).rejects.toThrow()
		expect(await snapshotEnvironment()).toEqual(before)
		expect(existsSync(resolve(directory, 'object-storage-identities.json'))).toBe(false)
	})

	test('refuses incomplete state rather than rotating IAM and database credentials', async () => {
		await seedExistingState()
		rmSync(resolve(directory, 'apps-db.env'))
		const before = await snapshotEnvironment()
		await expect(prepareLocalSecrets(directory)).rejects.toThrow('local credentials are incomplete')
		expect(await snapshotEnvironment()).toEqual(before)
	})

	test('adds the fixture pin without rotating existing credentials and refuses a conflicting pin', async () => {
		await seedExistingState()
		const before = await snapshotEnvironment()
		await prepareLocalSourceConfiguration(directory)
		const after = await snapshotEnvironment()
		const serialized = after['control.env']?.split('\n').find(line => line.startsWith('FABRIKA_ZEROPS_PROXY_SOURCE_JSON='))
			?.slice('FABRIKA_ZEROPS_PROXY_SOURCE_JSON='.length)
		if (serialized === undefined) throw new Error('missing fixture pin')
		const pin = decodeZeropsNamespaceProxySource(JSON.parse(serialized))
		await verifyZeropsNamespaceProxySource(pin)
		const fixtures = await loadLocalSourceFixtures(resolve(directory, LOCAL_SOURCE_FIXTURE_DIRECTORY))
		expect(pin.repository).toEqual(LOCAL_SOURCE_PLATFORM_REPOSITORY)
		expect(pin.commitSha).toBe(fixtures.platform.commitSha)
		expect(pin.descriptor.sha256).toBe(fixtures.platform.descriptorSha256)
		expect(after).toEqual({ ...before, 'control.env': `${control}FABRIKA_ZEROPS_PROXY_SOURCE_JSON=${serialized}\n` })
		await prepareLocalSourceConfiguration(directory)
		expect(await snapshotEnvironment()).toEqual(after)
		await Bun.write(resolve(directory, 'control.env'), `${control}FABRIKA_ZEROPS_PROXY_SOURCE_JSON={}\n`)
		const conflicting = await snapshotEnvironment()
		await expect(prepareLocalSourceConfiguration(directory)).rejects.toThrow('explicitly reset')
		expect(await snapshotEnvironment()).toEqual(conflicting)
	})

	test('gives every fixture GitHub App its own key once, keeps it across preparation and refuses a stale key file', async () => {
		await seedExistingState()
		await prepareLocalSecrets(directory)
		const file = resolve(directory, LOCAL_GITHUB_APPS_FILE)
		const generated = await Bun.file(file).text()
		const apps = await readLocalGitHubApps(directory)
		expect(apps.apps.map((app) => app.connectionId)).toEqual(LOCAL_SOURCE_CONNECTIONS.map((connection) => connection.connectionId))
		expect(new Set(apps.apps.map((app) => app.privateKeyPem)).size).toBe(LOCAL_SOURCE_CONNECTIONS.length)
		await prepareLocalSecrets(directory)
		expect(await Bun.file(file).text()).toBe(generated)
		await Bun.write(file, JSON.stringify({ version: 1, apps: apps.apps.slice(1) }))
		await expect(prepareLocalSecrets(directory)).rejects.toThrow('explicitly reset the local stack')
	})

	test('waits for both native startup buckets before starting storage consumers', async () => {
		const compose = Bun.YAML.parse(await Bun.file(COMPOSE_FILE).text())
		expect(compose).toMatchObject({
			services: {
				'object-storage': {
					image: 'chrislusf/seaweedfs:4.42',
					environment: { S3_BUCKET: 'run-logs,operations-payloads' },
					volumes: ['object-storage:/data', './.state/object-storage-identities.json:/etc/seaweedfs/identities.json:ro'],
					healthcheck: {
						test: ['CMD-SHELL', expect.stringMatching(/buckets\/run-logs\/.*&&.*buckets\/operations-payloads\//)],
					},
				},
				control: { depends_on: { 'object-storage': { condition: 'service_healthy' } } },
				operations: { depends_on: { 'object-storage': { condition: 'service_healthy' } } },
			},
		})
	})
})
