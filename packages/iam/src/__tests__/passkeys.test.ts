// Passkeys over `/admin/rpc`, as Control's console gateway forwards them, on both engines: the registration ceremony,
// the person's own list and removal, the step-up seam (a challenge bound to a string and its verification) and the
// administrator's reset. The authenticator is a WebCrypto key pair (`helpers/webauthn.ts`); IAM's verifier is real.
// Postgres runs when FABRIKA_TEST_POSTGRES_URL is set and skips cleanly otherwise.

import {
	NO_PASSKEY_ERROR,
	PASSKEY_REGISTRATION_BINDING,
	type PasskeyAssertion,
	type PasskeyChallenge,
	type PasskeyCreationOptions,
	type PasskeyDto,
	passkeyRemovalBinding,
	type PasskeyRequestOptions,
	type VerifiedPasskeyAssertion,
} from '@fabrika/iam-contract'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { prop } from '../json'
import { adminTokenFor, CONSOLE_APP, createHarness, TEST_SIGNING_KEYS } from './helpers/harness'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'
import { TestAuthenticator } from './helpers/webauthn'

if (!hasPostgres) {
	console.warn(`passkeys.test.ts ${skipReason}`)
}

const ISSUER = 'https://iam.example.test'
const CONSOLE = 'https://console.example.test'
const RP_ID = 'console.example.test'

let postgres: PostgresFixture | null = null

beforeAll(async () => {
	if (hasPostgres) postgres = await createPostgres('iam_passkeys')
})

afterAll(async () => {
	await postgres?.close()
})

interface Engine {
	readonly repositories: IamRepositories
	/** Run a statement against the engine's own database, to age a row. */
	readonly run: (sql: string, ...binds: unknown[]) => Promise<void>
}

const engines: { name: string; engine: () => Engine; skip: boolean }[] = [
	{
		name: 'SQLite',
		engine: () => {
			const h = createHarness()
			return {
				repositories: h.repositories,
				run: (sql, ...binds) => {
					h.sqlite.prepare(sql).run(...binds.map((value) => typeof value === 'number' || typeof value === 'string' ? value : null))
					return Promise.resolve()
				},
			}
		},
		skip: false,
	},
	{
		name: 'Postgres',
		engine: () => {
			const db = postgres?.db
			if (db === undefined) throw new Error('postgres')
			return {
				repositories: createPostgresIamRepositories(db),
				run: async (sql, ...binds) => {
					await db.prepare(sql).bind(...binds).run()
				},
			}
		},
		skip: !hasPostgres,
	},
]

type Answer = { status: number; body: unknown }

/** One installation: a console with a registered origin, and the people of a test. */
async function installation(engine: Engine) {
	const { repositories } = engine
	await repositories.handoff.setReturnOrigins(CONSOLE_APP, [CONSOLE])
	const tag = crypto.randomUUID()
	let seq = 0
	const person = async () => {
		seq += 1
		return (await repositories.principals.createUser(`sub-${tag}-${seq}`, `person-${seq}-${tag}@example.test`)).id
	}
	const rpc = async (bearer: string, method: string, input: unknown): Promise<Answer> => {
		const response = await createIamApp().fetch(
			new Request(`${ISSUER}/admin/rpc`, {
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
				ISSUER,
				FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
				FABRIKA_IAM_PROVISIONING_KEY: '',
				OIDC_ISSUER: 'https://idp.test',
				OIDC_CLIENT_ID: 'client',
				OIDC_CLIENT_SECRET: 'secret',
				OIDC_SCOPES: '',
				OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
			},
			{ waitUntil() {} },
		)
		return { status: response.status, body: await response.json() }
	}
	/** The console's call for `principalId`, with its signed-in session's token. */
	const as = async (principalId: string, method: string, input: unknown = null): Promise<Answer> =>
		rpc(await adminTokenFor(repositories, principalId, { issuer: ISSUER }), method, input)
	return { repositories, run: engine.run, person, rpc, as }
}

type Installation = Awaited<ReturnType<typeof installation>>

function result<T>(answer: Answer, guard: (value: unknown) => value is T): T {
	const value = prop(answer.body, 'result')
	if (answer.status !== 200 || !guard(value)) throw new Error(`expected a result, got ${answer.status} ${JSON.stringify(answer.body)}`)
	return value
}

const refusal = (answer: Answer): [number, unknown] => [answer.status, prop(prop(answer.body, 'error'), 'message')]

function isCreation(value: unknown): value is PasskeyChallenge<PasskeyCreationOptions> {
	return typeof prop(value, 'challengeId') === 'string' && typeof prop(prop(value, 'options'), 'challenge') === 'string'
}
const isRequest = (value: unknown): value is PasskeyChallenge<PasskeyRequestOptions> => isCreation(value)
const isPasskey = (value: unknown): value is PasskeyDto => typeof prop(value, 'id') === 'string' && typeof prop(value, 'label') === 'string'
const isList = (value: unknown): value is { items: PasskeyDto[] } => Array.isArray(prop(value, 'items'))
const isVerified = (value: unknown): value is VerifiedPasskeyAssertion => typeof prop(value, 'at') === 'number'

/** Register `authenticator` for `principalId` through the whole ceremony; the first passkey needs no step-up. */
async function registered(i: Installation, principalId: string, authenticator: TestAuthenticator, label = 'Laptop'): Promise<PasskeyDto> {
	const issued = result(await i.as(principalId, 'passkeys.registrationOptions'), isCreation)
	const credential = await authenticator.register(issued.options, CONSOLE)
	return result(await i.as(principalId, 'passkeys.register', { challengeId: issued.challengeId, label, credential }), isPasskey)
}

/** An answered assertion challenge bound to `binding`. */
async function asserted(
	i: Installation,
	principalId: string,
	authenticator: TestAuthenticator,
	binding: string,
	overrides: Parameters<TestAuthenticator['assert']>[2] = {},
): Promise<PasskeyAssertion> {
	const issued = result(await i.as(principalId, 'passkeys.challenge', { binding }), isRequest)
	return { challengeId: issued.challengeId, credential: await authenticator.assert(issued.options, CONSOLE, overrides) }
}

const NOT_ACCEPTED: [number, unknown] = [403, 'the passkey was not accepted']
const SPENT: [number, unknown] = [409, 'the passkey challenge expired or was already answered; ask for a new one']

for (const { name, engine, skip } of engines) {
	describe.skipIf(skip)(`passkeys (${name})`, () => {
		describe('registration', () => {
			test('a verified attestation registers the passkey for the console, recorded under the person', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const issued = result(await i.as(person, 'passkeys.registrationOptions'), isCreation)
				expect(issued.options.rp.id).toBe(RP_ID)
				expect(issued.options.authenticatorSelection.userVerification).toBe('required')
				expect(issued.options.attestation).toBe('none')

				const credential = await (await TestAuthenticator.create()).register(issued.options, CONSOLE)
				const passkey = result(await i.as(person, 'passkeys.register', { challengeId: issued.challengeId, label: ' Laptop ', credential }), isPasskey)
				expect(passkey).toMatchObject({ label: 'Laptop', lastUsedAt: null })
				expect(result(await i.as(person, 'passkeys.list'), isList).items).toEqual([passkey])

				const events = await i.repositories.audit.listAuditEvents({ principalId: person, limit: 10 })
				expect(events.map((event) => [event.action, event.resource_id])).toEqual([['iam.passkey.register', person]])
			})

			test('a challenge answers once, and not after it expired', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				const issued = result(await i.as(person, 'passkeys.registrationOptions'), isCreation)
				const credential = await authenticator.register(issued.options, CONSOLE)
				const register = () => i.as(person, 'passkeys.register', { challengeId: issued.challengeId, label: 'Laptop', credential })
				expect((await register()).status).toBe(200)
				expect(refusal(await register())).toEqual(SPENT)

				const other = await i.person()
				const late = result(await i.as(other, 'passkeys.registrationOptions'), isCreation)
				await i.run('UPDATE passkey_challenges SET expires_at = ? WHERE id = ?', Math.floor(Date.now() / 1000) - 1, late.challengeId)
				const answer = await (await TestAuthenticator.create()).register(late.options, CONSOLE)
				expect(refusal(await i.as(other, 'passkeys.register', { challengeId: late.challengeId, label: 'Laptop', credential: answer }))).toEqual(SPENT)
				expect(result(await i.as(other, 'passkeys.list'), isList).items).toEqual([])
			})

			test('an attestation made for another origin, another RP ID or without user verification is refused', async () => {
				const i = await installation(engine())
				const person = await i.person()
				for (
					const overrides of [
						{ origin: 'https://evil.example.test' },
						{ rpId: 'evil.example.test' },
						{ userVerified: false },
						{ challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' },
					]
				) {
					const issued = result(await i.as(person, 'passkeys.registrationOptions'), isCreation)
					const credential = await (await TestAuthenticator.create()).register(issued.options, CONSOLE, overrides)
					expect(refusal(await i.as(person, 'passkeys.register', { challengeId: issued.challengeId, label: 'Laptop', credential }))).toEqual(NOT_ACCEPTED)
				}
				expect(result(await i.as(person, 'passkeys.list'), isList).items).toEqual([])
			})

			test("a token minted from a key, not a person's session, is refused", async () => {
				const i = await installation(engine())
				const person = await i.person()
				const keyToken = await adminTokenFor(i.repositories, person, { issuer: ISSUER, session: false })
				for (const method of ['passkeys.list', 'passkeys.registrationOptions', 'passkeys.challenge']) {
					expect((await i.rpc(keyToken, method, method === 'passkeys.challenge' ? { binding: 'x' } : null)).status).toBe(403)
				}
			})

			test('another passkey takes an assertion by a current one, bound to the registration', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const first = await TestAuthenticator.create()
				await registered(i, person, first)

				const second = await TestAuthenticator.create()
				const issued = result(await i.as(person, 'passkeys.registrationOptions'), isCreation)
				expect(issued.options.excludeCredentials.map((descriptor) => descriptor.id)).toEqual([first.credentialId])
				const credential = await second.register(issued.options, CONSOLE)
				expect(refusal(await i.as(person, 'passkeys.register', { challengeId: issued.challengeId, label: 'Phone', credential }))).toEqual([
					403,
					'adding another passkey takes a fresh check with one you already have',
				])

				const again = result(await i.as(person, 'passkeys.registrationOptions'), isCreation)
				const wrongPurpose = await asserted(i, person, first, 'approval:other')
				expect(
					refusal(
						await i.as(person, 'passkeys.register', {
							challengeId: again.challengeId,
							label: 'Phone',
							credential: await second.register(again.options, CONSOLE),
							stepUp: wrongPurpose,
						}),
					)[0],
				).toBe(403)

				const last = result(await i.as(person, 'passkeys.registrationOptions'), isCreation)
				const stepUp = await asserted(i, person, first, PASSKEY_REGISTRATION_BINDING)
				const added = await i.as(person, 'passkeys.register', {
					challengeId: last.challengeId,
					label: 'Phone',
					credential: await second.register(last.options, CONSOLE),
					stepUp,
				})
				expect(added.status).toBe(200)
				expect(result(await i.as(person, 'passkeys.list'), isList).items.map((passkey) => passkey.label)).toEqual(['Laptop', 'Phone'])
			})
		})

		describe('assertion: the step-up seam', () => {
			test('a verified assertion answers who, with which credential and when, and records the use', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				const passkey = await registered(i, person, authenticator)
				const before = Math.floor(Date.now() / 1000)
				const assertion = await asserted(i, person, authenticator, 'approval:request-1:digest-a')
				const verified = result(await i.as(person, 'passkeys.verify', { binding: 'approval:request-1:digest-a', assertion }), isVerified)
				expect(verified).toEqual({ principalId: person, credentialId: authenticator.credentialId, at: verified.at })
				expect(verified.at).toBeGreaterThanOrEqual(before)
				expect(result(await i.as(person, 'passkeys.list'), isList).items).toEqual([{ ...passkey, lastUsedAt: verified.at }])
			})

			test('a challenge bound to one item does not verify for another, and its answer is spent either way', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				await registered(i, person, authenticator)
				const assertion = await asserted(i, person, authenticator, 'approval:item-x:digest-x')
				expect(refusal(await i.as(person, 'passkeys.verify', { binding: 'approval:item-y:digest-y', assertion }))).toEqual([
					403,
					'the passkey challenge was issued for something else',
				])
				expect(refusal(await i.as(person, 'passkeys.verify', { binding: 'approval:item-x:digest-x', assertion }))).toEqual(SPENT)
			})

			test('a second verification of one challenge fails', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create({ counting: false })
				await registered(i, person, authenticator)
				const assertion = await asserted(i, person, authenticator, 'approval:item-x')
				expect((await i.as(person, 'passkeys.verify', { binding: 'approval:item-x', assertion })).status).toBe(200)
				expect(refusal(await i.as(person, 'passkeys.verify', { binding: 'approval:item-x', assertion }))).toEqual(SPENT)
			})

			test("another person's challenge fails, and stays the issuer's to answer", async () => {
				const i = await installation(engine())
				const owner = await i.person()
				const stranger = await i.person()
				const authenticator = await TestAuthenticator.create()
				await registered(i, owner, authenticator)
				await registered(i, stranger, await TestAuthenticator.create())
				const assertion = await asserted(i, owner, authenticator, 'approval:item-x')
				expect(refusal(await i.as(stranger, 'passkeys.verify', { binding: 'approval:item-x', assertion }))).toEqual(SPENT)
				expect((await i.as(owner, 'passkeys.verify', { binding: 'approval:item-x', assertion })).status).toBe(200)
			})

			test('a wrong signature, an unknown credential, no user verification or presence, or a counter going back fails', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				await registered(i, person, authenticator)
				const verify = async (assertion: PasskeyAssertion) => refusal(await i.as(person, 'passkeys.verify', { binding: 'b', assertion }))

				const otherKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
				expect(await verify(await asserted(i, person, authenticator, 'b', { signWith: otherKey.privateKey }))).toEqual(NOT_ACCEPTED)
				expect(await verify(await asserted(i, person, await TestAuthenticator.create(), 'b'))).toEqual(NOT_ACCEPTED)
				expect(await verify(await asserted(i, person, authenticator, 'b', { userVerified: false }))).toEqual(NOT_ACCEPTED)
				expect(await verify(await asserted(i, person, authenticator, 'b', { userPresent: false, userVerified: false }))).toEqual(NOT_ACCEPTED)
				expect(await verify(await asserted(i, person, authenticator, 'b', { origin: 'https://evil.example.test' }))).toEqual(NOT_ACCEPTED)
				expect(await verify(await asserted(i, person, authenticator, 'b', { rpId: 'evil.example.test' }))).toEqual(NOT_ACCEPTED)

				expect(
					(await i.as(person, 'passkeys.verify', { binding: 'b', assertion: await asserted(i, person, authenticator, 'b', { counter: 10 }) })).status,
				)
					.toBe(200)
				expect(await verify(await asserted(i, person, authenticator, 'b', { counter: 10 }))).toEqual(NOT_ACCEPTED)
				expect(await verify(await asserted(i, person, authenticator, 'b', { counter: 3 }))).toEqual(NOT_ACCEPTED)
			})

			test('a person without a passkey gets no challenge, a refusal of its own type', async () => {
				const i = await installation(engine())
				const answer = await i.as(await i.person(), 'passkeys.challenge', { binding: 'approval:item-x' })
				expect(refusal(answer)).toEqual([409, 'no passkey is registered; register one under Account → Passkeys'])
				expect(prop(prop(answer.body, 'error'), 'type')).toBe(NO_PASSKEY_ERROR)
			})
		})

		describe('the person’s own list and removal', () => {
			test('the list and the removal reach only the caller’s own passkeys', async () => {
				const i = await installation(engine())
				const owner = await i.person()
				const stranger = await i.person()
				const ownerKey = await TestAuthenticator.create()
				const strangerKey = await TestAuthenticator.create()
				const owned = await registered(i, owner, ownerKey)
				await registered(i, stranger, strangerKey)
				expect(result(await i.as(stranger, 'passkeys.list'), isList).items.map((passkey) => passkey.id)).not.toContain(owned.id)

				const stepUp = await asserted(i, stranger, strangerKey, passkeyRemovalBinding(owned.id))
				expect(refusal(await i.as(stranger, 'passkeys.remove', { passkeyId: owned.id, stepUp }))).toEqual([404, 'passkey not found'])
				expect(result(await i.as(owner, 'passkeys.list'), isList).items).toHaveLength(1)
			})

			test('removing a passkey takes an assertion bound to its removal, and the last one may go', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				const passkey = await registered(i, person, authenticator)

				const unbound = await asserted(i, person, authenticator, 'approval:item-x')
				expect(refusal(await i.as(person, 'passkeys.remove', { passkeyId: passkey.id, stepUp: unbound }))[0]).toBe(403)
				expect(result(await i.as(person, 'passkeys.list'), isList).items).toHaveLength(1)

				const stepUp = await asserted(i, person, authenticator, passkeyRemovalBinding(passkey.id))
				expect(
					result(await i.as(person, 'passkeys.remove', { passkeyId: passkey.id, stepUp }), (value): value is { ok: true } => prop(value, 'ok') === true),
				)
					.toEqual({ ok: true })
				expect(result(await i.as(person, 'passkeys.list'), isList).items).toEqual([])
				const actions = (await i.repositories.audit.listAuditEvents({ principalId: person, limit: 10 })).map((event) => event.action).sort()
				expect(actions).toEqual(['iam.passkey.register', 'iam.passkey.remove'])
			})
		})

		describe('the administrator’s reset', () => {
			test('an installation administrator lists and removes every passkey of a person, recorded once', async () => {
				const i = await installation(engine())
				const admin = await i.person()
				await i.repositories.grants.createGrant({ principalId: admin, roleKey: 'admin' })
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				const passkey = await registered(i, person, authenticator)
				const pending = result(await i.as(person, 'passkeys.challenge', { binding: 'approval:item-x' }), isRequest)

				expect(result(await i.as(admin, 'passkeys.listOf', { principalId: person }), isList).items).toEqual([passkey])
				expect(
					result(
						await i.as(admin, 'passkeys.reset', { principalId: person }),
						(value): value is { removed: number } => typeof prop(value, 'removed') === 'number',
					),
				)
					.toEqual({ removed: 1 })
				expect(result(await i.as(person, 'passkeys.list'), isList).items).toEqual([])
				// Its open challenges went with it.
				const answer = await authenticator.assert(pending.options, CONSOLE)
				expect(
					refusal(
						await i.as(person, 'passkeys.verify', { binding: 'approval:item-x', assertion: { challengeId: pending.challengeId, credential: answer } }),
					),
				)
					.toEqual(SPENT)
				expect(
					result(
						await i.as(admin, 'passkeys.reset', { principalId: person }),
						(value): value is { removed: number } => typeof prop(value, 'removed') === 'number',
					),
				)
					.toEqual({ removed: 0 })
				const resets = (await i.repositories.audit.listAuditEvents({ principalId: admin, limit: 20 })).filter((event) =>
					event.action === 'iam.passkey.reset'
				)
				expect(resets.map((event) => event.resource_id)).toEqual([person])

				// A person who administers nothing reaches neither.
				expect((await i.as(person, 'passkeys.listOf', { principalId: admin })).status).toBe(403)
				expect((await i.as(person, 'passkeys.reset', { principalId: admin })).status).toBe(403)
			})
		})
	})
}
