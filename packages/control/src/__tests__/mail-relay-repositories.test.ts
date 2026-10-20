// The mail relay's persistence: platform transport keys, mail messages and gate rules, against SQLite always and
// Postgres when FABRIKA_TEST_POSTGRES_URL is set. The SQL runs against the shipped schema of each dialect.

import { type SqlDatabase, uuidv7 } from '@fabrika/platform'
import { afterEach, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories, type MailMessageInput } from '../db'
import { createHarness } from './helpers/harness'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`mail-relay-repositories.test.ts Postgres half ${skipReason}`)

interface Backend {
	repositories: ControlRepositories
	db: SqlDatabase
	close(): Promise<void>
}

const backends: { name: string; skip: boolean; open(): Promise<Backend> }[] = [
	{
		name: 'sqlite',
		skip: false,
		open: () => {
			const harness = createHarness()
			return Promise.resolve({
				repositories: harness.repositories,
				db: harness.d1,
				close: () => {
					harness.sqlite.close()
					return Promise.resolve()
				},
			})
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async () => {
			const fixture = await createPostgres('vozka_mail')
			return { repositories: createControlRepositories(fixture.db), db: fixture.db, close: () => fixture.close() }
		},
	},
]

const T0 = 1_800_000_000

async function registerEnvironment(repositories: ControlRepositories, appId: string, env: string): Promise<void> {
	if ((await repositories.registry.getApp(appId)) === null) await repositories.registry.createApp({ id: appId, repoUrl: `github.com/acme/${appId}` })
	await repositories.registry.upsertAppEnv({ appId, env, namespaceId: null, provider: 'test', providerTargetJson: '{}', providerArtifactJson: '{}' })
}

const keyRow = (keyId: string, hash: string, expiresAt: number, createdAt: number, receiver = 'mail') => ({
	app_id: 'notes',
	env: 'prod',
	receiver,
	key_id: keyId,
	key_hash: hash,
	value_ref: `vault:platform:platform-key:notes@prod:${receiver}`,
	expires_at: expiresAt,
	created_at: createdAt,
})

const message = (overrides: Partial<MailMessageInput> = {}): MailMessageInput => ({
	id: uuidv7(),
	sender: 'notes@prod',
	idempotency_key: 'invite:1',
	fingerprint: 'f'.repeat(64),
	recipient_domain: 'example.com',
	state: 'queued',
	rule_id: null,
	content: '{"to":"ada@example.com"}',
	...overrides,
})

for (const backend of backends) {
	describe.skipIf(backend.skip)(`mail relay repositories (${backend.name})`, () => {
		let opened: Backend | null = null
		const open = async (): Promise<ControlRepositories> => {
			opened = await backend.open()
			return opened.repositories
		}
		afterEach(async () => {
			await opened?.close()
			opened = null
		})

		describe('platform transport keys', () => {
			test('a key is found by its hash until it expires, and only then', async () => {
				const repositories = await open()
				await registerEnvironment(repositories, 'notes', 'prod')
				const keys = repositories.platformTransportKeys
				await keys.insert(keyRow('k1', 'hash-1', T0 + 100, T0))
				expect(await keys.findValidByHash('hash-1', T0 + 99)).toEqual(keyRow('k1', 'hash-1', T0 + 100, T0))
				expect(await keys.findValidByHash('hash-1', T0 + 100)).toBeNull()
				expect(await keys.findValidByHash('hash-2', T0)).toBeNull()
			})

			test('a rotated key keeps verifying beside the new one; expired keys are deleted, and a hash is unique', async () => {
				const repositories = await open()
				await registerEnvironment(repositories, 'notes', 'prod')
				const keys = repositories.platformTransportKeys
				await keys.insert(keyRow('k1', 'hash-1', T0 + 100, T0))
				await keys.insert(keyRow('k2', 'hash-2', T0 + 200, T0 + 50))
				expect((await keys.listForAppEnv('notes', 'prod')).map((row) => row.key_id)).toEqual(['k2', 'k1'])
				expect(await keys.findValidByHash('hash-1', T0 + 60)).not.toBeNull()
				expect(await keys.deleteExpired(T0 + 100)).toBe(1)
				expect((await keys.listForAppEnv('notes', 'prod')).map((row) => row.key_id)).toEqual(['k2'])
				await expect(keys.insert(keyRow('k3', 'hash-2', T0 + 300, T0 + 60))).rejects.toThrow()
			})

			test("deleting one receiver's keys leaves the other receivers' and environments' keys", async () => {
				const repositories = await open()
				await registerEnvironment(repositories, 'notes', 'prod')
				await registerEnvironment(repositories, 'notes', 'stage')
				const keys = repositories.platformTransportKeys
				await keys.insert(keyRow('k1', 'hash-1', T0 + 100, T0))
				await keys.insert(keyRow('k2', 'hash-2', T0 + 100, T0, 'audit'))
				await keys.insert({ ...keyRow('k3', 'hash-3', T0 + 100, T0), env: 'stage' })
				expect(await keys.deleteForAppEnv('notes', 'prod', 'mail')).toBe(1)
				expect((await keys.listForAppEnv('notes', 'prod')).map((row) => row.key_id)).toEqual(['k2'])
				expect((await keys.listForAppEnv('notes', 'stage')).map((row) => row.key_id)).toEqual(['k3'])
			})

			test('keys need a registered environment and go with it', async () => {
				const repositories = await open()
				await expect(repositories.platformTransportKeys.insert(keyRow('k1', 'hash-1', T0 + 100, T0))).rejects.toThrow()
				await registerEnvironment(repositories, 'notes', 'prod')
				await repositories.platformTransportKeys.insert(keyRow('k1', 'hash-1', T0 + 100, T0))
				await repositories.registry.deleteAppEnv('notes', 'prod')
				expect(await repositories.platformTransportKeys.findValidByHash('hash-1', T0)).toBeNull()
			})
		})

		describe('mail messages', () => {
			test('a repeat under the same sender and key finds the first row; another sender records its own', async () => {
				const repositories = await open()
				const messages = repositories.mailMessages
				const first = await messages.insertOrFind(message(), T0)
				expect(first.created).toBe(true)
				expect(first.row).toMatchObject({ sender: 'notes@prod', state: 'queued', attempts: 0, created_at: T0, updated_at: T0, decided_by: null })
				const repeat = await messages.insertOrFind(message({ fingerprint: 'e'.repeat(64), state: 'held' }), T0 + 1)
				expect(repeat).toEqual({ row: first.row, created: false })
				const other = await messages.insertOrFind(message({ sender: 'installation:iam' }), T0 + 2)
				expect(other.created).toBe(true)
				expect(other.row.id).not.toBe(first.row.id)
				expect(await messages.get(first.row.id)).toEqual(first.row)
				expect(await messages.get(uuidv7())).toBeNull()
			})

			test('a held message is released or dropped once, by a person', async () => {
				const repositories = await open()
				const messages = repositories.mailMessages
				const held = (await messages.insertOrFind(message({ state: 'held' }), T0)).row
				const other = (await messages.insertOrFind(message({ state: 'held', idempotency_key: 'invite:2' }), T0)).row
				expect(await messages.release(held.id, 'user:ada', T0 + 5)).toBe(true)
				expect(await messages.release(held.id, 'user:ada', T0 + 6)).toBe(false)
				expect(await messages.drop(held.id, 'user:bob', T0 + 6)).toBe(false)
				expect(await messages.get(held.id)).toMatchObject({ state: 'queued', decided_by: 'user:ada', updated_at: T0 + 5 })
				expect(await messages.drop(other.id, 'user:bob', T0 + 7)).toBe(true)
				expect(await messages.get(other.id)).toMatchObject({ state: 'dropped', decided_by: 'user:bob' })
			})

			test('a person requeues a final message in an allowed state with its content kept, with its attempts spent anew', async () => {
				const repositories = await open()
				const messages = repositories.mailMessages
				const failed = (await messages.insertOrFind(message({ idempotency_key: 'failed' }), T0)).row
				await messages.claim(failed.id, 0, T0)
				await messages.markUndelivered(failed.id, 'failed', 'provider_unavailable', 1, T0)
				const unknown = (await messages.insertOrFind(message({ idempotency_key: 'unknown' }), T0)).row
				await messages.claim(unknown.id, 0, T0)
				await messages.markUndelivered(unknown.id, 'unknown', 'network_error', 1, T0)
				const purged = (await messages.insertOrFind(message({ idempotency_key: 'purged' }), T0)).row
				await messages.claim(purged.id, 0, T0)
				await messages.markUndelivered(purged.id, 'failed', 'provider_unavailable', 1, T0)
				await messages.purgeContent(purged.id)
				const held = (await messages.insertOrFind(message({ idempotency_key: 'held', state: 'held' }), T0)).row

				expect(await messages.requeue(unknown.id, ['failed'], 'user:ada', T0 + 5)).toBe(false)
				expect(await messages.requeue(purged.id, ['failed', 'unknown'], 'user:ada', T0 + 5)).toBe(false)
				expect(await messages.requeue(held.id, ['failed', 'unknown'], 'user:ada', T0 + 5)).toBe(false)
				expect(await messages.requeue(failed.id, ['failed'], 'user:ada', T0 + 5)).toBe(true)
				expect(await messages.requeue(failed.id, ['failed'], 'user:ada', T0 + 5)).toBe(false)
				expect(await messages.get(failed.id)).toMatchObject({
					state: 'queued',
					attempts: 0,
					next_attempt_at: null,
					decided_by: 'user:ada',
					error_code: 'provider_unavailable',
					updated_at: T0 + 5,
				})
				expect(await messages.requeue(unknown.id, ['failed', 'unknown'], 'user:bob', T0 + 6)).toBe(true)
				expect(await messages.get(unknown.id)).toMatchObject({ state: 'queued', decided_by: 'user:bob' })
			})

			test('one consumer claims a queued, due attempt; only the claim settles it', async () => {
				const repositories = await open()
				const messages = repositories.mailMessages
				const sent = (await messages.insertOrFind(message(), T0)).row
				expect(await messages.claim(sent.id, 0, T0 + 1)).toBe(true)
				// A second consumer that read the same attempts claims nothing.
				expect(await messages.claim(sent.id, 0, T0 + 1)).toBe(false)
				expect(await messages.get(sent.id)).toMatchObject({ state: 'sending', attempts: 1, updated_at: T0 + 1 })
				expect(await messages.defer(sent.id, 1, T0 + 60, 'provider_unavailable', T0 + 2)).toBe(true)
				expect(await messages.defer(sent.id, 1, T0 + 60, 'provider_unavailable', T0 + 2)).toBe(false)
				expect(await messages.get(sent.id)).toMatchObject({ state: 'queued', attempts: 1, next_attempt_at: T0 + 60, error_code: 'provider_unavailable' })
				// Not due before its next attempt.
				expect(await messages.claim(sent.id, 1, T0 + 59)).toBe(false)
				expect(await messages.claim(sent.id, 1, T0 + 60)).toBe(true)
				// A settle under an older claim is refused.
				expect(await messages.markSent(sent.id, 'provider-0', 1, T0 + 61)).toBe(false)
				expect(await messages.markSent(sent.id, 'provider-1', 2, T0 + 61)).toBe(true)
				expect(await messages.get(sent.id)).toMatchObject({
					state: 'sent',
					attempts: 2,
					provider_message_id: 'provider-1',
					next_attempt_at: null,
					error_code: null,
				})
				expect(await messages.markSent(sent.id, 'provider-2', 2, T0 + 62)).toBe(false)
				expect(await messages.defer(sent.id, 2, T0 + 120, 'network_error', T0 + 62)).toBe(false)

				const failed = (await messages.insertOrFind(message({ idempotency_key: 'invite:2' }), T0)).row
				expect(await messages.markUndelivered(failed.id, 'unknown', 'request_timeout', 1, T0 + 3)).toBe(false)
				await messages.claim(failed.id, 0, T0 + 3)
				expect(await messages.markUndelivered(failed.id, 'unknown', 'request_timeout', 1, T0 + 3)).toBe(true)
				expect(await messages.get(failed.id)).toMatchObject({ state: 'unknown', error_code: 'request_timeout', attempts: 1 })
				expect(await messages.markUndelivered(failed.id, 'failed', 'provider_rejected', 1, T0 + 4)).toBe(false)

				const held = (await messages.insertOrFind(message({ idempotency_key: 'invite:3', state: 'held' }), T0)).row
				expect(await messages.claim(held.id, 0, T0 + 1)).toBe(false)
				expect(await messages.markSent(held.id, 'provider-3', 0, T0 + 1)).toBe(false)
			})

			test('a stale claim is claimed again once, and a fresh one not', async () => {
				const repositories = await open()
				const messages = repositories.mailMessages
				const row = (await messages.insertOrFind(message(), T0)).row
				await messages.claim(row.id, 0, T0)
				expect(await messages.reclaim(row.id, 1, T0 - 1, T0 + 600)).toBe(false)
				expect(await messages.reclaim(row.id, 1, T0, T0 + 600)).toBe(true)
				expect(await messages.reclaim(row.id, 1, T0 + 600, T0 + 600)).toBe(false)
				expect(await messages.get(row.id)).toMatchObject({ state: 'sending', attempts: 2, updated_at: T0 + 600 })
			})

			test('lists newest first, filtered by state and sender, a page at a time', async () => {
				const repositories = await open()
				const messages = repositories.mailMessages
				const ids: string[] = []
				const variants: Partial<MailMessageInput>[] = [{}, { state: 'held' }, { sender: 'installation:iam' }, { state: 'held' }]
				for (const [index, overrides] of variants.entries()) {
					ids.push((await messages.insertOrFind(message({ idempotency_key: `k${index}`, ...overrides }), T0)).row.id)
				}
				const newestFirst = [...ids].reverse()
				expect((await messages.list({ limit: 10 })).map((row) => row.id)).toEqual(newestFirst)
				const firstPage = await messages.list({ limit: 2 })
				expect(firstPage.map((row) => row.id)).toEqual(newestFirst.slice(0, 2))
				expect((await messages.list({ limit: 10, before: firstPage[1]?.id ?? '' })).map((row) => row.id)).toEqual(newestFirst.slice(2))
				expect((await messages.list({ limit: 10, state: 'held' })).map((row) => row.id)).toEqual([ids[3], ids[1]])
				expect((await messages.list({ limit: 10, sender: 'installation:iam' })).map((row) => row.id)).toEqual([ids[2]])
				expect((await messages.list({ limit: 10, sender: 'notes@prod', state: 'queued' })).map((row) => row.id)).toEqual([ids[0]])
			})

			test('lists messages the dispatcher may have lost: stale and due queued ones, and stale claims, the oldest first', async () => {
				const repositories = await open()
				const messages = repositories.mailMessages
				const lost = (await messages.insertOrFind(message({ idempotency_key: 'lost' }), T0)).row
				const deferred = (await messages.insertOrFind(message({ idempotency_key: 'deferred' }), T0)).row
				await messages.claim(deferred.id, 0, T0)
				await messages.defer(deferred.id, 1, T0 + 3600, 'rate_limited', T0)
				const claimed = (await messages.insertOrFind(message({ idempotency_key: 'claimed' }), T0)).row
				await messages.claim(claimed.id, 0, T0 + 300)
				const recent = (await messages.insertOrFind(message({ idempotency_key: 'recent' }), T0 + 590)).row
				await messages.insertOrFind(message({ idempotency_key: 'held', state: 'held' }), T0)
				const now = T0 + 600
				expect((await messages.listStalled(now - 600, now - 600, now, 10)).map((row) => row.id)).toEqual([lost.id])
				expect((await messages.listStalled(now - 600, now - 300, now, 10)).map((row) => row.id)).toEqual([lost.id, claimed.id])
				expect((await messages.listStalled(T0 + 3600, T0, T0 + 3600, 10)).map((row) => row.id)).toEqual([lost.id, deferred.id, recent.id])
				expect((await messages.listStalled(T0 + 3600, T0, T0 + 3600, 1)).map((row) => row.id)).toEqual([lost.id])
			})

			test('content is purged only from final rows: one at once, or every one older than a cutoff', async () => {
				const repositories = await open()
				const messages = repositories.mailMessages
				const sent = (await messages.insertOrFind(message({ idempotency_key: 'sent', sender: 'installation:iam' }), T0)).row
				const queued = (await messages.insertOrFind(message({ idempotency_key: 'queued' }), T0)).row
				const dropped = (await messages.insertOrFind(message({ idempotency_key: 'dropped', state: 'held' }), T0)).row
				const late = (await messages.insertOrFind(message({ idempotency_key: 'late', state: 'held' }), T0)).row
				expect(await messages.purgeContent(queued.id)).toBe(false)
				await messages.claim(sent.id, 0, T0 + 1)
				await messages.markSent(sent.id, 'provider-1', 1, T0 + 1)
				expect(await messages.purgeContent(sent.id)).toBe(true)
				expect(await messages.purgeContent(sent.id)).toBe(false)
				await messages.drop(dropped.id, 'user:ada', T0 + 10)
				await messages.drop(late.id, 'user:ada', T0 + 20)
				expect(await messages.purgeFinalContent(T0 + 10)).toBe(1)
				const contents = await Promise.all([sent, queued, dropped, late].map(async (row) => (await messages.get(row.id))?.content ?? null))
				expect(contents).toEqual([null, message().content, null, message().content])
				expect((await messages.get(dropped.id))?.updated_at).toBe(T0 + 10)
			})

			test('the schema refuses a state the relay does not have', async () => {
				await open()
				const db = opened?.db
				const insert = async (): Promise<void> => {
					await db?.prepare(
						`INSERT INTO mail_messages (id, sender, idempotency_key, fingerprint, recipient_domain, state, attempts, created_at, updated_at)
						VALUES (?, 'notes@prod', 'k', 'f', 'example.com', 'released', 0, ?, ?)`,
					).bind(uuidv7(), T0, T0).run()
				}
				await expect(insert()).rejects.toThrow()
			})
		})

		describe('mail rules', () => {
			test('the most specific rule decides: exact scope before *, then exact domain before *', async () => {
				const repositories = await open()
				const rules = repositories.mailRules
				expect(await rules.resolve('notes@prod', 'example.com')).toBeNull()
				const anyAny = await rules.upsert({ id: uuidv7(), scope: '*', domain: '*', action: 'hold' }, T0)
				expect(await rules.resolve('notes@prod', 'example.com')).toEqual(anyAny)
				const anyDomain = await rules.upsert({ id: uuidv7(), scope: '*', domain: 'example.com', action: 'pass' }, T0)
				expect(await rules.resolve('notes@prod', 'example.com')).toEqual(anyDomain)
				const scopeAny = await rules.upsert({ id: uuidv7(), scope: 'notes@prod', domain: '*', action: 'drop' }, T0)
				expect(await rules.resolve('notes@prod', 'example.com')).toEqual(scopeAny)
				const exact = await rules.upsert({ id: uuidv7(), scope: 'notes@prod', domain: 'example.com', action: 'pass' }, T0)
				expect(await rules.resolve('notes@prod', 'example.com')).toEqual(exact)
				expect(await rules.resolve('notes@prod', 'other.com')).toEqual(scopeAny)
				expect(await rules.resolve('notes@stage', 'example.com')).toEqual(anyDomain)
				expect(await rules.resolve('notes@stage', 'other.com')).toEqual(anyAny)
			})

			test('setting a rule of an existing scope and domain changes its action and keeps its id', async () => {
				const repositories = await open()
				const rules = repositories.mailRules
				const created = await rules.upsert({ id: uuidv7(), scope: 'notes@prod', domain: 'example.com', action: 'hold' }, T0)
				expect(created).toMatchObject({ action: 'hold', created_at: T0, updated_at: T0 })
				const changed = await rules.upsert({ id: uuidv7(), scope: 'notes@prod', domain: 'example.com', action: 'pass' }, T0 + 5)
				expect(changed).toEqual({ ...created, action: 'pass', updated_at: T0 + 5 })
				expect(await rules.list()).toEqual([changed])
			})

			test('lists by scope and domain; a removed rule decides nothing', async () => {
				const repositories = await open()
				const rules = repositories.mailRules
				const notes = await rules.upsert({ id: uuidv7(), scope: 'notes@prod', domain: '*', action: 'hold' }, T0)
				const any = await rules.upsert({ id: uuidv7(), scope: '*', domain: 'example.com', action: 'drop' }, T0)
				expect(await rules.list()).toEqual([any, notes])
				expect(await rules.remove(notes.id)).toBe(true)
				expect(await rules.remove(notes.id)).toBe(false)
				expect(await rules.resolve('notes@prod', 'other.com')).toBeNull()
			})
		})
	})
}
