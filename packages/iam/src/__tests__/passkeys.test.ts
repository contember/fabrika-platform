// Passkeys on IAM's own host, on both engines: adding and removing one on the account page's ceremony pages, the step-up
// seam over `/admin/rpc` (a challenge Control asks for, answered on IAM's step-up page, then verified by its issuer), the
// administrator's reset, and the passkeys an upgrade removed because they answered on the console's host. The
// authenticator is a WebCrypto key pair (`helpers/webauthn.ts`); IAM's verifier is real. Postgres runs when
// FABRIKA_TEST_POSTGRES_URL is set and skips cleanly otherwise.

import { SESSION_COOKIE } from '@fabrika/auth-core'
import {
	NO_PASSKEY_ERROR,
	type PasskeyCreationOptions,
	type PasskeyRequestOptions,
	type PasskeyStepUpChallenge,
	type VerifiedPasskeyAssertion,
} from '@fabrika/iam-contract'
import { uuidv7 } from '@fabrika/platform'
import { unusedDatabase } from '@fabrika/platform/testing'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createIamApp } from '../app'
import { ACCOUNT_PATH, PASSKEYS_PATH } from '../auth/account'
import { STEP_UP_PATH } from '../auth/passkey-pages'
import { handleAuth } from '../auth/routes'
import { createPostgresIamRepositories, type IamRepositories } from '../db'
import { prop } from '../json'
import { randomToken } from '../oidc'
import { issueRegistrationChallenge, recordMovedPasskeys, relyingParty } from '../passkeys'
import { unixNow } from '../repositories/sql'
import { hashToken } from '../secret'
import { adminTokenFor, createHarness, makeServicesFor, TEST_SIGNING_KEYS } from './helpers/harness'
import { migrationFile, migrationsBefore } from './helpers/migrations'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'
import { type CeremonyOverrides, TestAuthenticator } from './helpers/webauthn'

if (!hasPostgres) {
	console.warn(`passkeys.test.ts ${skipReason}`)
}

const ISSUER = 'https://iam.example.test'
const RP_ID = 'iam.example.test'
const CONSOLE = 'https://console.example.test'

let postgres: PostgresFixture | null = null

beforeAll(async () => {
	if (hasPostgres) postgres = await createPostgres('iam_passkeys')
})

afterAll(async () => {
	await postgres?.close()
})

interface Engine {
	readonly repositories: IamRepositories
	/** Run a statement against the engine's own database, to age or seed a row. */
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

const SAME_ORIGIN = { origin: ISSUER, 'sec-fetch-site': 'same-origin' }

/** One installation: IAM's pages, its admin RPC, and the people of a test, each signed in. */
async function installation(engine: Engine) {
	const { repositories } = engine
	const services = makeServicesFor(repositories, { issuer: ISSUER, authentication: { oidc: false, password: true } })
	const tag = crypto.randomUUID()
	const cookies = new Map<string, string>()
	let seq = 0
	const person = async () => {
		seq += 1
		const id = (await repositories.principals.createUser(`sub-${tag}-${seq}`, `person-${seq}-${tag}@example.test`)).id
		const token = randomToken(32)
		await repositories.sessions.createSession({
			tokenHash: await hashToken(token),
			principalId: id,
			authenticationMethod: 'password',
			expiresAt: unixNow() + 3600,
		})
		cookies.set(id, `${SESSION_COOKIE}=${token}`)
		return id
	}
	const cookieOf = (principalId: string | null): Record<string, string> => {
		const cookie = principalId === null ? undefined : cookies.get(principalId)
		return cookie === undefined ? {} : { cookie }
	}
	const send = (request: Request) =>
		handleAuth(request, services, { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }, { waitUntil() {} }, null, 'req-passkeys')
	const get = (principalId: string | null, path: string) => send(new Request(`${ISSUER}${path}`, { headers: cookieOf(principalId) }))
	const post = (principalId: string, path: string, fields: Record<string, string>, headers: Record<string, string> = SAME_ORIGIN) =>
		send(
			new Request(`${ISSUER}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookieOf(principalId), ...headers },
				body: new URLSearchParams(fields),
			}),
		)
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
	/** The console's call for `principalId`, with its signed-in session's token, as Control's gateway forwards it. */
	const as = async (principalId: string, method: string, input: unknown = null): Promise<Answer> =>
		rpc(await adminTokenFor(repositories, principalId, { issuer: ISSUER }), method, input)
	const labels = async (principalId: string) => (await repositories.passkeys.list(principalId)).map((row) => row.label)
	return { repositories, services, run: engine.run, person, get, post, rpc, as, labels }
}

type Installation = Awaited<ReturnType<typeof installation>>

function result<T>(answer: Answer, guard: (value: unknown) => value is T): T {
	const value = prop(answer.body, 'result')
	if (answer.status !== 200 || !guard(value)) throw new Error(`expected a result, got ${answer.status} ${JSON.stringify(answer.body)}`)
	return value
}

const refusal = (answer: Answer): [number, unknown] => [answer.status, prop(prop(answer.body, 'error'), 'message')]

const isStepUp = (value: unknown): value is PasskeyStepUpChallenge =>
	typeof prop(value, 'challengeId') === 'string' && typeof prop(value, 'url') === 'string'
const isVerified = (value: unknown): value is VerifiedPasskeyAssertion => typeof prop(value, 'at') === 'number'
const isCreation = (value: unknown): value is PasskeyCreationOptions => typeof prop(prop(value, 'rp'), 'id') === 'string'
const isRequest = (value: unknown): value is PasskeyRequestOptions => typeof prop(value, 'rpId') === 'string'

const NOT_COMPLETED: [number, unknown] = [409, 'the passkey check was not completed, or it expired or was used already; confirm it again']

function unescapeHtml(value: string): string {
	return value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

/** A ceremony page: which ceremony, its options and the hidden fields its form posts. */
interface Ceremony {
	readonly ceremony: string
	readonly options: unknown
	readonly fields: Record<string, string>
}

async function ceremonyOf(response: Response): Promise<Ceremony> {
	const html = await response.text()
	const form = /<form id="webauthn"[^>]*data-ceremony="(get|create)" data-options="([^"]*)"/.exec(html)
	if (response.status !== 200 || form === null) throw new Error(`expected a ceremony page, got ${response.status} ${html.slice(0, 400)}`)
	const fields = Object.fromEntries(
		[...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((
			match,
		) => [unescapeHtml(match[1] ?? ''), unescapeHtml(match[2] ?? '')]),
	)
	return { ceremony: form[1] ?? '', options: JSON.parse(unescapeHtml(form[2] ?? '')), fields }
}

function creation(page: Ceremony): PasskeyCreationOptions {
	expect(page.ceremony).toBe('create')
	if (!isCreation(page.options)) throw new Error('expected creation options')
	return page.options
}

function request(page: Ceremony): PasskeyRequestOptions {
	expect(page.ceremony).toBe('get')
	if (!isRequest(page.options)) throw new Error('expected request options')
	return page.options
}

/** Where a passkey form sent the browser: back to the account page, with its outcome named. */
function outcome(response: Response): string | null {
	expect(response.status).toBe(303)
	const location = new URL(response.headers.get('location') ?? '', ISSUER)
	expect(location.pathname).toBe(ACCOUNT_PATH)
	return location.searchParams.get('done')
}

/** Post a ceremony page's form with the answer. */
function answerPage(i: Installation, principalId: string, path: string, page: Ceremony, credential: unknown): Promise<Response> {
	return i.post(principalId, path, { ...page.fields, credential: JSON.stringify(credential) })
}

/**
 * Add `authenticator` as a passkey through the account page's ceremony; a person who has one confirms with `confirmWith`
 * first. Answers the outcome the page names.
 */
async function added(
	i: Installation,
	principalId: string,
	authenticator: TestAuthenticator,
	options: { label?: string; confirmWith?: TestAuthenticator; overrides?: CeremonyOverrides } = {},
): Promise<string | null> {
	let page = await ceremonyOf(await i.post(principalId, PASSKEYS_PATH, { step: 'add', label: options.label ?? 'Laptop' }))
	if (page.ceremony === 'get') {
		if (options.confirmWith === undefined) throw new Error('adding another passkey asks for a check')
		page = await ceremonyOf(await answerPage(i, principalId, PASSKEYS_PATH, page, await options.confirmWith.assert(request(page), ISSUER)))
	}
	const credential = await authenticator.register(creation(page), ISSUER, options.overrides)
	return outcome(await answerPage(i, principalId, PASSKEYS_PATH, page, credential))
}

/** Control's challenge for `binding`, asked for with the person's console token. */
async function challenged(i: Installation, principalId: string, binding: string): Promise<PasskeyStepUpChallenge> {
	return result(await i.as(principalId, 'passkeys.challenge', { binding }), isStepUp)
}

/** Answer a step-up challenge on IAM's page, as the popup the console opened does. */
async function answered(
	i: Installation,
	principalId: string,
	authenticator: TestAuthenticator,
	issued: PasskeyStepUpChallenge,
	overrides: CeremonyOverrides = {},
): Promise<Response> {
	const url = new URL(issued.url)
	const page = await ceremonyOf(await i.get(principalId, `${url.pathname}${url.search}`))
	return answerPage(i, principalId, STEP_UP_PATH, page, await authenticator.assert(request(page), ISSUER, overrides))
}

const verify = (i: Installation, principalId: string, binding: string, challengeId: string) =>
	i.as(principalId, 'passkeys.verify', { binding, challengeId })

for (const { name, engine, skip } of engines) {
	describe.skipIf(skip)(`passkeys (${name})`, () => {
		describe('on the account page', () => {
			test('the first passkey is added with the session alone, for IAM as the relying party, recorded under the person', async () => {
				const i = await installation(engine())
				const person = await i.person()
				expect(await (await i.get(person, ACCOUNT_PATH)).text()).toContain('You have no passkey.')

				const page = await ceremonyOf(await i.post(person, PASSKEYS_PATH, { step: 'add', label: ' Laptop ' }))
				const options = creation(page)
				expect(options.rp.id).toBe(RP_ID)
				expect(options.authenticatorSelection.userVerification).toBe('required')
				expect(options.attestation).toBe('none')
				expect(outcome(await answerPage(i, person, PASSKEYS_PATH, page, await (await TestAuthenticator.create()).register(options, ISSUER)))).toBe(
					'passkey_added',
				)
				expect(await i.labels(person)).toEqual(['Laptop'])
				const html = await (await i.get(person, `${ACCOUNT_PATH}?done=passkey_added`)).text()
				expect(html).toContain('Passkey added.')
				expect(html).toContain('<strong>Laptop</strong>')
				expect(html).toContain('Never used')

				const events = await i.repositories.audit.listAuditEvents({ principalId: person, limit: 10 })
				expect(events.map((event) => [event.action, event.resource_id])).toEqual([['iam.passkey.register', person]])
			})

			test("a creation for the console's origin, another RP ID, without user verification or for another challenge is refused", async () => {
				const i = await installation(engine())
				const person = await i.person()
				for (
					const overrides of [
						{ origin: CONSOLE },
						{ rpId: 'console.example.test' },
						{ userVerified: false },
						{ challenge: 'bm90LXRoZS1jaGFsbGVuZ2U' },
					]
				) {
					expect(await added(i, person, await TestAuthenticator.create(), { overrides })).toBe('passkey_refused')
				}
				expect(await i.labels(person)).toEqual([])
			})

			test('a challenge answers once, and a name is required', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const page = await ceremonyOf(await i.post(person, PASSKEYS_PATH, { step: 'add', label: 'Laptop' }))
				const credential = await (await TestAuthenticator.create()).register(creation(page), ISSUER)
				expect(outcome(await answerPage(i, person, PASSKEYS_PATH, page, credential))).toBe('passkey_added')
				expect(outcome(await answerPage(i, person, PASSKEYS_PATH, page, credential))).toBe('passkey_refused')
				expect(outcome(await i.post(person, PASSKEYS_PATH, { step: 'add', label: '  ' }))).toBe('passkey_label')
				expect(await i.labels(person)).toEqual(['Laptop'])
			})

			test('another passkey takes a check with a current one, bound to the registration', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const first = await TestAuthenticator.create()
				expect(await added(i, person, first)).toBe('passkey_added')
				const second = await TestAuthenticator.create()

				// A creation challenge issued without the check cannot register another.
				const unchecked = await issueRegistrationChallenge(i.services, relyingParty(i.services.config), await principal(i, person), false)
				if (unchecked === null) throw new Error('challenge')
				expect(
					outcome(
						await i.post(person, PASSKEYS_PATH, {
							step: 'add-finish',
							label: 'Phone',
							challengeId: unchecked.challengeId,
							credential: JSON.stringify(await second.register(unchecked.options, ISSUER)),
						}),
					),
				).toBe('passkey_refused')

				// A check bound to something else (the removal of the first) does not confirm the registration.
				const [held] = await i.repositories.passkeys.list(person)
				const removal = await ceremonyOf(await i.post(person, PASSKEYS_PATH, { step: 'remove', passkey: held?.id ?? '' }))
				expect(
					outcome(
						await i.post(person, PASSKEYS_PATH, {
							step: 'add-confirm',
							label: 'Phone',
							challengeId: removal.fields['challengeId'] ?? '',
							credential: JSON.stringify(await first.assert(request(removal), ISSUER)),
						}),
					),
				).toBe('passkey_refused')

				const confirm = await ceremonyOf(await i.post(person, PASSKEYS_PATH, { step: 'add', label: 'Phone' }))
				expect(request(confirm).allowCredentials.map((descriptor) => descriptor.id)).toEqual([first.credentialId])
				expect(await added(i, person, second, { label: 'Phone', confirmWith: first })).toBe('passkey_added')
				expect(await i.labels(person)).toEqual(['Laptop', 'Phone'])
			})

			test("removing takes a check bound to the removal, the last one may go, and another person's never", async () => {
				const i = await installation(engine())
				const owner = await i.person()
				const stranger = await i.person()
				const ownerKey = await TestAuthenticator.create()
				expect(await added(i, owner, ownerKey)).toBe('passkey_added')
				expect(await added(i, stranger, await TestAuthenticator.create())).toBe('passkey_added')
				const [passkey] = await i.repositories.passkeys.list(owner)
				if (passkey === undefined) throw new Error('passkey')

				expect(outcome(await i.post(stranger, PASSKEYS_PATH, { step: 'remove', passkey: passkey.id }))).toBe('passkey_refused')
				expect(await i.labels(owner)).toEqual(['Laptop'])

				const page = await ceremonyOf(await i.post(owner, PASSKEYS_PATH, { step: 'remove', passkey: passkey.id }))
				expect(request(page).rpId).toBe(RP_ID)
				expect(outcome(await answerPage(i, owner, PASSKEYS_PATH, page, await ownerKey.assert(request(page), ISSUER)))).toBe('passkey_removed')
				expect(await i.labels(owner)).toEqual([])
				const actions = (await i.repositories.audit.listAuditEvents({ principalId: owner, limit: 10 })).map((event) => event.action).sort()
				expect(actions).toEqual(['iam.passkey.register', 'iam.passkey.remove'])
			})

			test('a POST from another origin changes nothing, and a browser without a login is sent to sign in', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const crossSite = await i.post(person, PASSKEYS_PATH, { step: 'add', label: 'Laptop' }, {
					origin: 'https://evil.example.test',
					'sec-fetch-site': 'cross-site',
				})
				expect(crossSite.status).toBe(403)

				const signedOut = await i.get(null, `${STEP_UP_PATH}?challenge=some-id`)
				expect(signedOut.status).toBe(302)
				const location = new URL(signedOut.headers.get('location') ?? '', ISSUER)
				expect(location.pathname).toBe('/auth/login')
				expect(location.searchParams.get('redirect')).toBe(`${ISSUER}${STEP_UP_PATH}?challenge=some-id`)
			})
		})

		describe('the step-up seam', () => {
			test("Control's challenge is answered on IAM's page, then verified once with the binding", async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				expect(await added(i, person, authenticator)).toBe('passkey_added')
				const before = unixNow()
				const issued = await challenged(i, person, 'approval:request-1:digest-a')
				expect(issued.url).toBe(`${ISSUER}${STEP_UP_PATH}?challenge=${issued.challengeId}`)

				const page = await answered(i, person, authenticator, issued)
				expect(page.status).toBe(200)
				expect(await page.text()).toContain('Confirmed. Close this tab and continue in the console.')
				const verified = result(await verify(i, person, 'approval:request-1:digest-a', issued.challengeId), isVerified)
				expect(verified).toEqual({ principalId: person, credentialId: authenticator.credentialId, at: verified.at })
				expect(verified.at).toBeGreaterThanOrEqual(before)
				expect((await i.repositories.passkeys.list(person))[0]?.last_used_at).toBe(verified.at)
				expect(refusal(await verify(i, person, 'approval:request-1:digest-a', issued.challengeId))).toEqual(NOT_COMPLETED)
			})

			test('a verification before the answer refuses and leaves the challenge to answer', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				expect(await added(i, person, authenticator)).toBe('passkey_added')
				const issued = await challenged(i, person, 'approval:item-x')
				expect(refusal(await verify(i, person, 'approval:item-x', issued.challengeId))).toEqual(NOT_COMPLETED)
				expect((await answered(i, person, authenticator, issued)).status).toBe(200)
				expect((await verify(i, person, 'approval:item-x', issued.challengeId)).status).toBe(200)
			})

			test('an answer for one item does not verify another, and is spent either way', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				expect(await added(i, person, authenticator)).toBe('passkey_added')
				const issued = await challenged(i, person, 'approval:item-x:digest-x')
				expect((await answered(i, person, authenticator, issued)).status).toBe(200)
				expect(refusal(await verify(i, person, 'approval:item-y:digest-y', issued.challengeId))).toEqual([
					403,
					'the passkey challenge was issued for something else',
				])
				expect(refusal(await verify(i, person, 'approval:item-x:digest-x', issued.challengeId))).toEqual(NOT_COMPLETED)
			})

			test("another person cannot open, answer or verify someone's challenge", async () => {
				const i = await installation(engine())
				const owner = await i.person()
				const stranger = await i.person()
				const ownerKey = await TestAuthenticator.create()
				expect(await added(i, owner, ownerKey)).toBe('passkey_added')
				expect(await added(i, stranger, await TestAuthenticator.create())).toBe('passkey_added')
				const issued = await challenged(i, owner, 'approval:item-x')
				const url = new URL(issued.url)
				expect((await i.get(stranger, `${url.pathname}${url.search}`)).status).toBe(410)
				expect((await answered(i, owner, ownerKey, issued)).status).toBe(200)
				expect(refusal(await verify(i, stranger, 'approval:item-x', issued.challengeId))).toEqual(NOT_COMPLETED)
				expect((await verify(i, owner, 'approval:item-x', issued.challengeId)).status).toBe(200)
			})

			test('a wrong signature, an unknown credential, no user verification, another origin or RP, or a counter going back fails and spends it', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				expect(await added(i, person, authenticator)).toBe('passkey_added')
				const otherKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
				const refused = async (answerer: TestAuthenticator, overrides: CeremonyOverrides) => {
					const issued = await challenged(i, person, 'b')
					const page = await answered(i, person, answerer, issued, overrides)
					expect(page.status).toBe(403)
					expect(await page.text()).toContain('The passkey was not accepted.')
					const url = new URL(issued.url)
					expect((await i.get(person, `${url.pathname}${url.search}`)).status).toBe(410)
					expect(refusal(await verify(i, person, 'b', issued.challengeId))).toEqual(NOT_COMPLETED)
				}
				await refused(authenticator, { signWith: otherKey.privateKey })
				await refused(await TestAuthenticator.create(), {})
				await refused(authenticator, { userVerified: false })
				await refused(authenticator, { userPresent: false, userVerified: false })
				await refused(authenticator, { origin: CONSOLE })
				await refused(authenticator, { rpId: 'console.example.test' })

				const counted = await challenged(i, person, 'b')
				expect((await answered(i, person, authenticator, counted, { counter: 10 })).status).toBe(200)
				await refused(authenticator, { counter: 10 })
				await refused(authenticator, { counter: 3 })
			})

			test('a person without a passkey gets no challenge, a refusal of its own type', async () => {
				const i = await installation(engine())
				const answer = await i.as(await i.person(), 'passkeys.challenge', { binding: 'approval:item-x' })
				expect(refusal(answer)).toEqual([409, 'no passkey is registered; add one on your IAM account page'])
				expect(prop(prop(answer.body, 'error'), 'type')).toBe(NO_PASSKEY_ERROR)
			})

			test("a token minted from a key, not a person's session, is refused", async () => {
				const i = await installation(engine())
				const person = await i.person()
				const keyToken = await adminTokenFor(i.repositories, person, { issuer: ISSUER, session: false })
				expect((await i.rpc(keyToken, 'passkeys.challenge', { binding: 'x' })).status).toBe(403)
				expect((await i.rpc(keyToken, 'passkeys.verify', { binding: 'x', challengeId: 'y' })).status).toBe(403)
			})
		})

		describe('the administrator’s reset', () => {
			test('an installation administrator lists and removes every passkey of a person, recorded once', async () => {
				const i = await installation(engine())
				const admin = await i.person()
				await i.repositories.grants.createGrant({ principalId: admin, roleKey: 'admin' })
				const person = await i.person()
				const authenticator = await TestAuthenticator.create()
				expect(await added(i, person, authenticator)).toBe('passkey_added')
				const pending = await challenged(i, person, 'approval:item-x')

				const listed = await i.as(admin, 'passkeys.listOf', { principalId: person })
				expect(listed.status).toBe(200)
				expect(JSON.stringify(listed.body)).toContain('Laptop')
				expect(prop(prop(await i.as(admin, 'passkeys.reset', { principalId: person }), 'body'), 'result')).toEqual({ removed: 1 })
				expect(await i.labels(person)).toEqual([])
				// Its open challenges went with it.
				const url = new URL(pending.url)
				expect((await i.get(person, `${url.pathname}${url.search}`)).status).toBe(410)
				expect(prop(prop(await i.as(admin, 'passkeys.reset', { principalId: person }), 'body'), 'result')).toEqual({ removed: 0 })
				const resets = (await i.repositories.audit.listAuditEvents({ principalId: admin, limit: 20 })).filter((event) =>
					event.action === 'iam.passkey.reset'
				)
				expect(resets.map((event) => event.resource_id)).toEqual([person])

				// A person who administers nothing reaches neither.
				expect((await i.as(person, 'passkeys.listOf', { principalId: admin })).status).toBe(403)
				expect((await i.as(person, 'passkeys.reset', { principalId: admin })).status).toBe(403)
			})
		})

		describe('passkeys registered on the console', () => {
			test('the maintenance pass records each one the upgrade removed once, as a reset with the reason rp_moved', async () => {
				const i = await installation(engine())
				const person = await i.person()
				const moved = [uuidv7(), uuidv7()]
				for (const [index, id] of moved.entries()) {
					await i.run('INSERT INTO passkeys_rp_moved (id, principal_id, label, created_at) VALUES (?, ?, ?, ?)', id, person, `Key ${index}`, 1_700_000_000)
				}
				expect(await recordMovedPasskeys(i.services)).toBeGreaterThanOrEqual(2)
				const records = await i.repositories.audit.listAuditEvents({ action: 'iam.passkey.reset', resourceId: person, limit: 10 })
				expect(records.map((record) => [record.principal_id, record.principal_label, JSON.parse(record.metadata ?? 'null')]).reverse()).toEqual(
					moved.map((id, index) => [null, 'iam-maintenance', { passkeyId: id, label: `Key ${index}`, reason: 'rp_moved' }]),
				)
				expect(await recordMovedPasskeys(i.services)).toBe(0)
			})
		})
	})
}

describe('migration 0047 on SQLite', () => {
	test("removes every passkey and open challenge registered on the console's host, keeping each to record", async () => {
		const h = createHarness(migrationsBefore('0047_passkeys_on_iam.sql'))
		const person = (await h.repositories.principals.createUser('sub-moved', 'moved@example.test')).id
		h.sqlite.prepare(`INSERT INTO passkeys (id, principal_id, credential_id, public_key, sign_count, transports, label, created_at)
			VALUES (?, ?, ?, ?, 0, '[]', 'Laptop', 1700000000)`).run('pk-1', person, 'cred-1', 'key-1')
		h.sqlite.prepare(`INSERT INTO passkey_challenges (id, principal_id, kind, challenge, binding, created_at, expires_at)
			VALUES ('ch-1', ?, 'assertion', 'c', 'b', 1, 9999999999)`).run(person)
		h.sqlite.exec(migrationFile('0047_passkeys_on_iam.sql'))
		const count = (table: string) => h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
		expect(count('passkeys')).toEqual({ n: 0 })
		expect(count('passkey_challenges')).toEqual({ n: 0 })
		expect(h.sqlite.prepare('SELECT id, principal_id, label, created_at FROM passkeys_rp_moved').all()).toEqual([
			{ id: 'pk-1', principal_id: person, label: 'Laptop', created_at: 1_700_000_000 },
		])
		expect(await recordMovedPasskeys(makeServicesFor(h.repositories, { issuer: ISSUER }))).toBe(1)
	})
})

async function principal(i: Installation, id: string) {
	const row = await i.repositories.principals.getPrincipalById(id)
	if (row === null) throw new Error('principal')
	return row
}
