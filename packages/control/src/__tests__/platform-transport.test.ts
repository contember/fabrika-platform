// The platform transport key of an application environment: Control issues it, keeps its hash for the relay and its
// value sealed in the vault, rotates it at half its life while the replaced key stays valid until its own expiry, and
// forgets it with the need.

import { hashPlatformKey } from '@fabrika/email/platform'
import { describe, expect, test } from 'bun:test'
import {
	PLATFORM_KEY_LIFETIME_SECONDS,
	PLATFORM_KEY_ROTATE_BELOW_SECONDS,
	platformKeyPurpose,
	type PlatformTransportPort,
	VaultPlatformTransport,
} from '../platform-transport'
import { Vault } from '../vault'
import { createHarness, queryRows } from './helpers/harness'

const VAULT_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const T0 = 1_800_000_000
const KEY_FORMAT = /^px_[A-Za-z0-9_-]{27}$/

async function setup() {
	const harness = createHarness()
	const { registry, platformTransportKeys } = harness.repositories
	await registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
	for (const env of ['prod', 'stage']) {
		await registry.upsertAppEnv({ appId: 'notes', env, namespaceId: null, provider: 'test', providerTargetJson: '{}', providerArtifactJson: '{}' })
	}
	const vault = await Vault.create(harness.d1, VAULT_KEY)
	const clock = { now: T0 }
	const transport = new VaultPlatformTransport(platformTransportKeys, () => Promise.resolve(vault), () => clock.now)
	return { harness, vault, clock, transport, keys: platformTransportKeys }
}

async function issued(transport: PlatformTransportPort, env = 'prod'): Promise<string> {
	const key = await transport.reconcile('notes', env, 'mail', true)
	if (key === null) throw new Error('no key was issued')
	return key
}

describe('VaultPlatformTransport', () => {
	test('issues a px_ key of 160 bits for <app>@<env>, which the relay finds by its hash, and answers it while it is fresh', async () => {
		const { harness, clock, transport, keys } = await setup()
		const key = await issued(transport)
		expect(key).toMatch(KEY_FORMAT)
		const row = await keys.findValidByHash(await hashPlatformKey(key), T0)
		expect(row).toMatchObject({ app_id: 'notes', env: 'prod', receiver: 'mail', expires_at: T0 + PLATFORM_KEY_LIFETIME_SECONDS, created_at: T0 })
		expect(queryRows(harness.sqlite, 'SELECT scope, label FROM vault')).toEqual([{ scope: 'platform', label: 'platform:platform-key:notes@prod:mail' }])
		clock.now = T0 + PLATFORM_KEY_LIFETIME_SECONDS - PLATFORM_KEY_ROTATE_BELOW_SECONDS - 1
		expect(await issued(transport)).toBe(key)
		expect(await keys.listForAppEnv('notes', 'prod')).toHaveLength(1)
	})

	test('rotates once less than half its life is left; the replaced key stays valid until its own expiry, then its row goes', async () => {
		const { harness, clock, transport, keys } = await setup()
		const first = await issued(transport)
		clock.now = T0 + PLATFORM_KEY_LIFETIME_SECONDS - PLATFORM_KEY_ROTATE_BELOW_SECONDS + 1
		const second = await issued(transport)
		expect(second).not.toBe(first)
		expect(second).toMatch(KEY_FORMAT)
		expect(await keys.findValidByHash(await hashPlatformKey(first), clock.now)).not.toBeNull()
		expect(await keys.findValidByHash(await hashPlatformKey(second), clock.now)).not.toBeNull()
		// Only the newest value is ever handed out again, so only it stays in the vault.
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault')).toEqual([{ label: 'platform:platform-key:notes@prod:mail' }])
		expect(await issued(transport)).toBe(second)

		clock.now = T0 + PLATFORM_KEY_LIFETIME_SECONDS
		expect(await keys.findValidByHash(await hashPlatformKey(first), clock.now)).toBeNull()
		clock.now = T0 + PLATFORM_KEY_LIFETIME_SECONDS + 1
		const third = await issued(transport)
		const remaining = await keys.listForAppEnv('notes', 'prod')
		expect(remaining.map((row) => row.key_hash).sort()).toEqual([await hashPlatformKey(second), await hashPlatformKey(third)].sort())
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault')).toHaveLength(1)
	})

	test('a key whose hash row fails to record is never handed out: its vault value goes, and the retry issues another', async () => {
		const { harness, vault, clock, keys } = await setup()
		let failNextInsert = false
		const flaky = new VaultPlatformTransport(
			{
				listForAppEnv: (appId, env) => keys.listForAppEnv(appId, env),
				deleteForAppEnv: (appId, env, receiver) => keys.deleteForAppEnv(appId, env, receiver),
				deleteExpired: (now) => keys.deleteExpired(now),
				insert: (row) => {
					if (failNextInsert) {
						failNextInsert = false
						return Promise.reject(new Error('the database went away'))
					}
					return keys.insert(row)
				},
			},
			() => Promise.resolve(vault),
			() => clock.now,
		)
		const first = await issued(flaky)
		clock.now = T0 + PLATFORM_KEY_LIFETIME_SECONDS - PLATFORM_KEY_ROTATE_BELOW_SECONDS + 1
		failNextInsert = true
		await expect(flaky.reconcile('notes', 'prod', 'mail', true)).rejects.toThrow('the database went away')
		expect((await keys.listForAppEnv('notes', 'prod')).map((row) => row.key_hash)).toEqual([await hashPlatformKey(first)])
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault')).toHaveLength(1)
		const retried = await issued(flaky)
		expect(retried).not.toBe(first)
		expect(await keys.findValidByHash(await hashPlatformKey(retried), clock.now)).not.toBeNull()
		expect(await keys.findValidByHash(await hashPlatformKey(first), clock.now)).not.toBeNull()
	})

	test('stores only the hash and a vault ref, and the vault only ciphertext', async () => {
		const { harness, transport } = await setup()
		const key = await issued(transport)
		const stored = JSON.stringify([
			...queryRows(harness.sqlite, 'SELECT * FROM platform_transport_keys'),
			...queryRows(harness.sqlite, 'SELECT * FROM vault'),
		])
		expect(stored).not.toContain(key)
	})

	test('the sealed value opens only for its own environment and receiver', async () => {
		const { vault, transport, keys } = await setup()
		await issued(transport)
		const [row] = await keys.listForAppEnv('notes', 'prod')
		if (row === undefined) throw new Error('no key row')
		await expect(vault.getSecretForPurpose(row.value_ref, platformKeyPurpose('notes', 'stage', 'mail'))).rejects.toThrow()
	})

	test("forgets every key of the environment once it needs none, issues none without need, and keeps another environment's", async () => {
		const { harness, clock, transport, keys } = await setup()
		await issued(transport)
		clock.now = T0 + PLATFORM_KEY_LIFETIME_SECONDS - PLATFORM_KEY_ROTATE_BELOW_SECONDS + 1
		await issued(transport)
		const stage = await issued(transport, 'stage')
		expect(await transport.reconcile('notes', 'prod', 'mail', false)).toBeNull()
		expect(await transport.reconcile('notes', 'prod', 'mail', false)).toBeNull()
		expect(await keys.listForAppEnv('notes', 'prod')).toEqual([])
		expect(queryRows(harness.sqlite, 'SELECT label FROM vault')).toEqual([{ label: 'platform:platform-key:notes@stage:mail' }])
		expect(await issued(transport, 'stage')).toBe(stage)
		expect(await transport.reconcile('notes', 'dev', 'mail', false)).toBeNull()
	})
})
