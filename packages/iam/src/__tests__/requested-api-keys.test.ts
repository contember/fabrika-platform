// ADR-0083 §8: a key a person approved in Control for the agent that asked, issued by IAM with that person's console
// token, idempotent by the approval request's id, and answered only encrypted to the agent's public key. On SQLite
// always, and on Postgres when FABRIKA_TEST_POSTGRES_URL is set.

import type { AppSchema } from '@fabrika/auth-core'
import { recipientKeyThumbprint, type RecipientPublicKey } from '@fabrika/iam-contract'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterEach, describe, expect, test } from 'bun:test'
import { compactDecrypt, decodeProtectedHeader, exportJWK, generateKeyPair } from 'jose'
import { createIamApp } from '../app'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { mintFromKey } from '../tokens'
import { adminTokenFor, createHarness, makeServicesFor, TEST_SIGNING_KEYS } from './helpers/harness'
import { membershipFixture, ORIGIN } from './helpers/membership'
import { createPostgres, hasPostgres, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`requested-api-keys.test.ts Postgres half ${skipReason}`)

const CONSOLE = 'vozka'
const PROVISIONING_KEY = 'px_provisioning-key-of-the-requested-keys-suite'
const DAY = 24 * 3600

const CONSOLE_SCHEMA: AppSchema = {
	displayName: 'Console',
	scopes: [{ type: 'app', label: 'App' }],
	actions: [
		{ action: 'deploy.trigger', description: 'Deploy' },
		{ action: 'deploy.read', description: 'Read runs' },
		{ action: 'secret.manage', description: 'Manage secrets' },
	],
	roles: {},
}

const backends = [
	{
		name: 'sqlite',
		skip: false,
		open: () => {
			const h = createHarness()
			return Promise.resolve({ repositories: h.repositories, close: () => Promise.resolve(h.sqlite.close()) })
		},
	},
	{
		name: 'postgres',
		skip: !hasPostgres,
		open: async () => {
			const pg = await createPostgres('iam_requested_keys')
			return { repositories: createPostgresIamRepositories(pg.db), close: () => pg.close() }
		},
	},
] as const

for (const backend of backends) {
	describe.skipIf(backend.skip)(`a requested key (${backend.name})`, () => {
		let closing: (() => Promise<void>) | null = null
		afterEach(async () => {
			const close = closing
			closing = null
			await close?.()
		})

		async function world() {
			const opened = await backend.open()
			closing = opened.close
			const repositories: IamRepositories = opened.repositories
			const f = await membershipFixture(repositories)
			expect((await f.putSchema(CONSOLE_SCHEMA, CONSOLE)).status).toBe(200)
			const ada = await f.person('ada')
			await repositories.grants.createGrant({ principalId: ada.id, roleKey: 'admin' })
			const pair = await generateKeyPair('ECDH-ES', { crv: 'P-256', extractable: true })
			const jwk = await exportJWK(pair.publicKey)
			if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('no public key')
			const recipient: RecipientPublicKey = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }

			async function rpc(bearer: string, method: string, input: unknown): Promise<{ status: number; result: unknown; message: string }> {
				const response = await createIamApp().fetch(
					new Request(`${ORIGIN}/admin/rpc`, {
						method: 'POST',
						headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
						body: JSON.stringify({ method, input }),
					}),
					{
						DB: unusedDatabase,
						REPOSITORIES: repositories,
						HUMAN_EMAIL_DOMAINS: '[]',
						HUMAN_EMAILS: '[]',
						IAM_BOOTSTRAP_ADMINS: '[]',
						ENVIRONMENT: 'stage',
						ISSUER: ORIGIN,
						FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
						FABRIKA_IAM_PROVISIONING_KEY: PROVISIONING_KEY,
						OIDC_ISSUER: 'https://idp.test',
						OIDC_CLIENT_ID: 'client',
						OIDC_CLIENT_SECRET: 'secret',
						OIDC_SCOPES: '',
						OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
					},
					{ waitUntil() {} },
				)
				const body: { result?: unknown; error?: { message?: string } } = await response.json()
				return { status: response.status, result: body.result, message: body.error?.message ?? '' }
			}

			const ask = (overrides: Record<string, unknown> = {}) => ({
				label: 'ci deploys',
				app: CONSOLE,
				permissions: ['deploy.trigger', 'deploy.read'],
				scopeType: 'app',
				scopeValue: 'notes',
				expiresAt: Math.floor(Date.now() / 1000) + 7 * DAY,
				recipient,
				approvalRequest: { id: 'request-1', requester: { id: 'kim', label: 'kim via agent', clientId: 'https://agent.test/client.json' } },
				...overrides,
			})

			const asAda = async (method: string, input: unknown) => rpc(await adminTokenFor(repositories, ada.id, { issuer: ORIGIN }), method, input)

			async function open(jwe: string): Promise<string> {
				return new TextDecoder().decode((await compactDecrypt(jwe, pair.privateKey)).plaintext)
			}

			const services = async () => (await repositories.principals.listPrincipals({ type: 'service', limit: 100 })).length
			const before = await services()
			/** The service principals issued since the world was set up. */
			const serviceKeys = async (): Promise<number> => (await services()) - before

			return { repositories, ada, recipient, ask, asAda, rpc, open, serviceKeys }
		}

		test('issued by the approver in a session, encrypted to the recipient: only its private key opens it, and the key mints', async () => {
			const w = await world()
			const issued = await w.asAda('apiKeys.provisionRequested', w.ask())
			expect(issued.status).toBe(200)
			const key = issued.result
			if (typeof key !== 'object' || key === null || !('jwe' in key) || typeof key.jwe !== 'string') throw new Error('no key')
			expect(key.jwe).not.toContain('px_')
			expect(decodeProtectedHeader(key.jwe)).toEqual({
				alg: 'ECDH-ES',
				enc: 'A256GCM',
				kid: recipientKeyThumbprint(w.recipient),
				epk: expect.any(Object),
			})

			const plaintext = await w.open(key.jwe)
			expect(plaintext.startsWith('px_')).toBe(true)
			const minted = await mintFromKey(makeServicesFor(w.repositories, { environment: 'stage', issuer: ORIGIN }), {
				FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
				ENVIRONMENT: 'stage',
			}, { app: CONSOLE, key: plaintext, requestId: 'r' })
			expect(minted.result.ok).toBe(true)
			const audit = await w.repositories.audit.listAuditEvents({ limit: 50 })
			const created = audit.find((row) => row.action === 'iam.apikey.create')
			expect(created?.principal_id).toBe(w.ada.id)
			expect(JSON.parse(created?.metadata ?? 'null')).toMatchObject({
				label: 'ci deploys',
				approvalRequest: { id: 'request-1', requester: { id: 'kim', label: 'kim via agent', clientId: 'https://agent.test/client.json' } },
			})
			// No record holds the plaintext or the JWE.
			expect(JSON.stringify(audit)).not.toContain(plaintext)
			expect(JSON.stringify(audit)).not.toContain(key.jwe)
		})

		test('a repeat under the same request id answers the same key and issues no second; another ask under it is a 409', async () => {
			const w = await world()
			const first = await w.asAda('apiKeys.provisionRequested', w.ask())
			const again = await w.asAda('apiKeys.provisionRequested', w.ask())
			expect(again).toEqual(first)
			expect(await w.serviceKeys()).toBe(1)
			const different = await w.asAda('apiKeys.provisionRequested', w.ask({ permissions: ['secret.manage'] }))
			expect(different.status).toBe(409)
			expect(await w.serviceKeys()).toBe(1)

			const followed = await w.rpc(PROVISIONING_KEY, 'apiKeys.requested', { approvalRequestId: 'request-1' })
			expect(followed.result).toEqual({ key: first.result })
			expect((await w.rpc(PROVISIONING_KEY, 'apiKeys.requested', { approvalRequestId: 'request-2' })).result).toEqual({ key: null })
		})

		test('refused, issuing nothing: a key caller, an expiry past 30 days, a wildcard, a private JWK, another curve', async () => {
			const w = await world()
			expect((await w.rpc(PROVISIONING_KEY, 'apiKeys.provisionRequested', w.ask())).status).toBe(403)
			const now = Math.floor(Date.now() / 1000)
			expect((await w.asAda('apiKeys.provisionRequested', w.ask({ expiresAt: now + 31 * DAY }))).status).toBe(400)
			expect((await w.asAda('apiKeys.provisionRequested', w.ask({ permissions: ['deploy.*'] }))).status).toBe(400)
			expect((await w.asAda('apiKeys.provisionRequested', w.ask({ recipient: { ...w.recipient, d: w.recipient.x } }))).status).toBe(400)
			const other = await w.asAda('apiKeys.provisionRequested', w.ask({ recipient: { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' } }))
			expect(other.status).toBe(400)
			expect(await w.serviceKeys()).toBe(0)
		})

		test('the key holds exactly the actions asked, in the scope asked', async () => {
			const w = await world()
			const issued = await w.asAda('apiKeys.provisionRequested', w.ask())
			const key = issued.result
			if (typeof key !== 'object' || key === null || !('principalId' in key) || typeof key.principalId !== 'string') throw new Error('no key')
			const grants = await w.repositories.grants.listGrants(key.principalId)
			expect(grants).toHaveLength(1)
			expect(JSON.parse(grants[0]?.permissions ?? 'null')).toEqual(['deploy.trigger', 'deploy.read'])
			expect(grants[0]).toMatchObject({ app: CONSOLE, scope_type: 'app', scope_value: 'notes', granted_by: w.ada.id })
		})
	})
}
