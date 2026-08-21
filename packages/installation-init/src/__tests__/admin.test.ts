import type { GrantDto, PrincipalDetail, PrincipalListItem } from '@fabrika/iam-contract'
import { describe, expect, test } from 'bun:test'
import { createIamAdminClient, ensureFirstAdministrator, type IamAdminClient } from '../admin'

const ORIGIN = 'https://iam.example.test'
const KEY = 'px_provisioning'

type PasswordState = 'unavailable' | 'disabled' | 'pending' | 'enabled'

interface FakePrincipal {
	item: PrincipalListItem
	grants: GrantDto[]
	password: PasswordState
}

interface RecordedCall {
	readonly method: string
	readonly input: unknown
	readonly url: string
	readonly authorization: string | null
}

interface FakeIam {
	readonly client: IamAdminClient
	readonly calls: RecordedCall[]
	readonly principals: FakePrincipal[]
	readonly issued: string[]
}

const user = (id: string, email: string, status: 'invited' | 'active' | 'disabled', password: PasswordState): FakePrincipal => ({
	item: { id, type: 'user', label: email, email, externalId: null, status, createdAt: 1 },
	grants: [],
	password,
})

const crossAppAdminGrant = (principalId: string): GrantDto => ({
	id: `grant-${principalId}`,
	principalId,
	roleKey: 'admin',
	permissions: null,
	scopeType: null,
	scopeValue: null,
	app: null,
	grantedBy: null,
	expiresAt: null,
	createdAt: 1,
	dangling: false,
})

interface FakeOptions {
	readonly principals?: FakePrincipal[]
	/** Force the pagination loop: a page is full at this many rows even though the caller asked for more. */
	readonly pageSize?: number
	/** Answer one procedure with an error envelope instead of a result. */
	readonly refuse?: { readonly method: string; readonly status: number; readonly message: string }
	/** Nothing answers at this origin at all. */
	readonly unreachable?: boolean
	/** Something answers, but it is not an admin RPC surface: JSON with no envelope, or no JSON at all. */
	readonly misdirected?: 'json' | 'html'
	/** The installation delivers password actions by email, so the URL never comes back to the caller. */
	readonly emailDelivery?: boolean
	/** Answer the first invite with the 409 a concurrent run produces, and let that run's principal win. */
	readonly inviteRace?: boolean
}

/** An in-memory `/admin/rpc`: the five procedures this flow uses, over the real wire envelope. */
const fakeIam = (options: FakeOptions = {}): FakeIam => {
	const principals = [...(options.principals ?? [])]
	const calls: RecordedCall[] = []
	const issued: string[] = []
	let nextId = principals.length + 1

	const detail = (found: FakePrincipal): PrincipalDetail => ({
		...found.item,
		grants: found.grants,
		permissions: [],
		authentication: { oidc: { state: 'unavailable' }, password: { state: found.password } },
	})

	/** The one refusal the flow is expected to absorb rather than report. */
	const RACED = Symbol('409')

	const answer = (method: string, input: unknown): unknown => {
		if (method === 'principals.list') {
			const query = typeof input === 'object' && input !== null ? input : {}
			const q = String(Reflect.get(query, 'q') ?? '')
			const before = Reflect.get(query, 'before')
			const matched = principals.filter((entry) => (entry.item.email ?? '').includes(q))
			const start = typeof before === 'string' ? matched.findIndex((entry) => entry.item.id === before) + 1 : 0
			const size = options.pageSize ?? matched.length
			const page = matched.slice(start, start + size)
			const more = start + page.length < matched.length
			return { items: page.map((entry) => entry.item), nextCursor: more ? (page.at(-1)?.item.id ?? null) : null }
		}
		if (method === 'principals.invite') {
			const spelling = String(Reflect.get(Object(input), 'email'))
			const mailbox = spelling.trim().toLocaleLowerCase('en-US')
			if (options.inviteRace === true && !principals.some((entry) => entry.item.email === mailbox)) {
				// The concurrent run's principal lands between our list and our invite; IAM answers 409.
				principals.push(user(`principal-${nextId++}`, mailbox, 'invited', 'pending'))
				return RACED
			}
			if (principals.some((entry) => entry.item.email === mailbox)) {
				throw new Error('the fake was asked to invite a mailbox it already holds')
			}
			const created = user(`principal-${nextId++}`, mailbox, 'invited', 'disabled')
			principals.push(created)
			return created.item
		}
		const id = String(Reflect.get(Object(input), 'id'))
		if (method === 'principals.get') {
			const found = principals.find((entry) => entry.item.id === id)
			return found === undefined ? undefined : detail(found)
		}
		if (method === 'grants.create') {
			const principalId = String(Reflect.get(Object(input), 'principalId'))
			const found = principals.find((entry) => entry.item.id === principalId)
			if (found === undefined) {
				throw new Error('the fake was asked to grant to a principal it does not hold')
			}
			const grant = crossAppAdminGrant(principalId)
			found.grants.push(grant)
			return grant
		}
		if (method === 'passwords.issueEnrollment') {
			const found = principals.find((entry) => entry.item.id === id)
			if (found === undefined || found.password === 'enabled') {
				throw new Error('the fake was asked to enroll a principal that cannot be enrolled')
			}
			found.password = 'pending'
			const url = `${ORIGIN}/auth/password/enroll?token=enrollment-${issued.length + 1}`
			issued.push(url)
			return options.emailDelivery === true
				? { delivery: 'email', email: found.item.email, expiresAt: 1_700_000_000 }
				: { delivery: 'manual', url, expiresAt: 1_700_000_000 }
		}
		throw new Error(`the fake does not serve ${method}`)
	}

	const client = createIamAdminClient({
		origin: ORIGIN,
		provisioningKey: KEY,
		fetch: async (input, init) => {
			if (options.unreachable === true) {
				throw new TypeError('connection refused')
			}
			const body: unknown = JSON.parse(String(init?.body ?? '{}'))
			const method = String(Reflect.get(Object(body), 'method'))
			calls.push({
				method,
				input: Reflect.get(Object(body), 'input'),
				url: String(input),
				authorization: new Headers(init?.headers).get('authorization'),
			})
			if (options.misdirected === 'json') {
				return Response.json({ errors: [{ code: 404, message: 'Route not found' }] }, { status: 404 })
			}
			if (options.misdirected === 'html') {
				return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
			}
			if (options.refuse !== undefined && options.refuse.method === method) {
				return Response.json({ error: { type: 'auth', message: options.refuse.message } }, { status: options.refuse.status })
			}
			const result = answer(method, Reflect.get(Object(body), 'input'))
			if (typeof result === 'symbol') {
				return Response.json({ error: { type: 'conflict', message: 'a user with this email already exists' } }, { status: 409 })
			}
			return Response.json({ result })
		},
	})
	return { client, calls, principals, issued }
}

const methods = (iam: FakeIam): string[] => iam.calls.map((call) => call.method)

describe('the first administrator', () => {
	test('invites, grants cross-app admin, and issues one enrollment URL on a fresh installation', async () => {
		const iam = fakeIam()
		const result = await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })

		expect(result.principal).toBe('invited')
		expect(result.grant).toBe('created')
		expect(result.enrollment).toEqual({ state: 'issued', url: iam.issued[0] ?? '', expiresAt: 1_700_000_000 })
		expect(iam.issued).toHaveLength(1)
		expect(methods(iam)).toEqual(['principals.list', 'principals.invite', 'principals.get', 'grants.create', 'passwords.issueEnrollment'])
	})

	test('the grant is cross-app and role `admin` — an app-scoped one leaves the Access plane refusing', async () => {
		const iam = fakeIam()
		await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })

		const created = iam.calls.find((call) => call.method === 'grants.create')
		expect(created?.input).toEqual({ principalId: iam.principals[0]?.item.id ?? '', roleKey: 'admin', app: null })
	})

	test('sends `principalId` to grants.create and `id` to the procedures taking PrincipalIdInput', async () => {
		const iam = fakeIam()
		await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })
		const id = iam.principals[0]?.item.id ?? ''

		expect(iam.calls.find((call) => call.method === 'grants.create')?.input).toMatchObject({ principalId: id })
		expect(iam.calls.find((call) => call.method === 'principals.get')?.input).toEqual({ id })
		expect(iam.calls.find((call) => call.method === 'passwords.issueEnrollment')?.input).toEqual({ id })
	})

	test('every call carries the provisioning key as a bearer, at the admin RPC path', async () => {
		const iam = fakeIam()
		await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })

		expect(iam.calls.every((call) => call.authorization === `Bearer ${KEY}`)).toBe(true)
		expect(iam.calls.every((call) => call.url === `${ORIGIN}/admin/rpc`)).toBe(true)
	})

	test('a re-run invites nobody twice, grants nothing twice and issues no second enrollment', async () => {
		const existing = user('principal-1', 'operator@example.test', 'invited', 'pending')
		existing.grants.push(crossAppAdminGrant('principal-1'))
		const iam = fakeIam({ principals: [existing] })

		const result = await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })

		expect(result).toEqual({
			principalId: 'principal-1',
			email: 'operator@example.test',
			principal: 'existing',
			grant: 'present',
			enrollment: { state: 'outstanding' },
		})
		expect(iam.issued).toHaveLength(0)
		expect(methods(iam)).toEqual(['principals.list', 'principals.get'])
	})

	test('a password that is already set is reported, never re-enrolled', async () => {
		const existing = user('principal-1', 'operator@example.test', 'active', 'enabled')
		existing.grants.push(crossAppAdminGrant('principal-1'))
		const iam = fakeIam({ principals: [existing] })

		const result = await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })

		expect(result.enrollment).toEqual({ state: 'already-set' })
		expect(methods(iam)).not.toContain('passwords.issueEnrollment')
	})

	test('`reissueEnrollment` is the only way an outstanding enrollment is replaced', async () => {
		const existing = user('principal-1', 'operator@example.test', 'invited', 'pending')
		const iam = fakeIam({ principals: [existing] })

		const result = await ensureFirstAdministrator(iam.client, { email: 'operator@example.test', reissueEnrollment: true })

		expect(result.enrollment.state).toBe('issued')
		expect(iam.issued).toHaveLength(1)
	})

	test('an expired grant does not count as present', async () => {
		const existing = user('principal-1', 'operator@example.test', 'active', 'enabled')
		existing.grants.push({ ...crossAppAdminGrant('principal-1'), expiresAt: 1 })
		const iam = fakeIam({ principals: [existing] })

		expect((await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })).grant).toBe('created')
	})

	test('an app-scoped admin grant does not count as present either', async () => {
		const existing = user('principal-1', 'operator@example.test', 'active', 'enabled')
		existing.grants.push({ ...crossAppAdminGrant('principal-1'), app: 'vozka' })
		const iam = fakeIam({ principals: [existing] })

		expect((await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })).grant).toBe('created')
	})

	test('matches the mailbox the way IAM stores it, whatever spelling the operator typed', async () => {
		const iam = fakeIam({ principals: [user('principal-1', 'operator@example.test', 'active', 'enabled')] })

		const result = await ensureFirstAdministrator(iam.client, { email: '  Operator@Example.TEST ' })

		expect(result).toMatchObject({ principalId: 'principal-1', principal: 'existing', email: 'operator@example.test' })
	})

	test('invites the spelling the operator typed — IAM normalizes the mailbox and keeps that as the label', async () => {
		const iam = fakeIam()

		await ensureFirstAdministrator(iam.client, { email: '  Operator@Example.TEST ' })

		expect(iam.calls.find((call) => call.method === 'principals.invite')?.input).toEqual({ email: 'Operator@Example.TEST' })
	})

	test('a lost invite race converges on the principal that won instead of failing', async () => {
		const iam = fakeIam({ inviteRace: true })

		const result = await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })

		expect(result.principal).toBe('existing')
		expect(result.grant).toBe('created')
		// It re-read rather than assumed: the second list is what resolved the winner.
		expect(methods(iam).filter((method) => method === 'principals.list')).toHaveLength(2)
		expect(iam.principals).toHaveLength(1)
	})

	test('an installation that delivers by email reports the mailbox and hands back no URL', async () => {
		const iam = fakeIam({ emailDelivery: true })

		const result = await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })

		expect(result.enrollment).toEqual({ state: 'emailed', email: 'operator@example.test', expiresAt: 1_700_000_000 })
	})

	test('reads past the first page rather than inviting a principal that already exists', async () => {
		const iam = fakeIam({
			principals: [
				user('principal-1', 'other.operator@example.test', 'active', 'enabled'),
				user('principal-2', 'operator@example.test', 'active', 'enabled'),
			],
			pageSize: 1,
		})

		const result = await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })

		expect(result.principal).toBe('existing')
		expect(result.principalId).toBe('principal-2')
		expect(methods(iam).filter((method) => method === 'principals.list')).toHaveLength(2)
	})

	test('refuses a disabled principal instead of admitting one that cannot sign in', async () => {
		const iam = fakeIam({ principals: [user('principal-1', 'operator@example.test', 'disabled', 'enabled')] })

		await expect(ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })).rejects.toThrow(
			'principal principal-1 holds operator@example.test and is disabled',
		)
	})

	test('refuses an installation that offers no password method, rather than reporting half an administrator', async () => {
		const iam = fakeIam({ principals: [user('principal-1', 'operator@example.test', 'active', 'unavailable')] })

		await expect(ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })).rejects.toThrow(
			'offers no password authentication',
		)
		expect(iam.issued).toHaveLength(0)
	})

	test('a refused key fails closed, naming the procedure and the status', async () => {
		const iam = fakeIam({ refuse: { method: 'principals.list', status: 401, message: 'unauthorized' } })

		await expect(ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })).rejects.toThrow(
			'principals.list failed: unauthorized (HTTP 401)',
		)
		expect(iam.issued).toHaveLength(0)
	})

	test('an unreachable IAM fails closed and says so', async () => {
		const iam = fakeIam({ unreachable: true })

		await expect(ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })).rejects.toThrow(
			'principals.list failed: IAM did not answer',
		)
	})

	test('a host that answers JSON but is not IAM fails on the address, not several calls later', async () => {
		const iam = fakeIam({ misdirected: 'json' })

		await expect(ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })).rejects.toThrow(
			'principals.list answered no result — the address answered, but not as an IAM admin RPC surface',
		)
	})

	test('a host answering something other than JSON is reported as the wrong host, not as silence', async () => {
		const iam = fakeIam({ misdirected: 'html' })

		await expect(ensureFirstAdministrator(iam.client, { email: 'operator@example.test' })).rejects.toThrow(
			"is that IAM's public host?",
		)
	})

	test('no failure message ever quotes the provisioning key', async () => {
		const cases: FakeOptions[] = [
			{ refuse: { method: 'principals.list', status: 401, message: 'unauthorized' } },
			{ unreachable: true },
			{ misdirected: 'json' },
			{ misdirected: 'html' },
			{ principals: [user('principal-1', 'operator@example.test', 'disabled', 'enabled')] },
			{ principals: [user('principal-1', 'operator@example.test', 'active', 'unavailable')] },
		]
		for (const options of cases) {
			const iam = fakeIam(options)
			const failure = await ensureFirstAdministrator(iam.client, { email: 'operator@example.test' }).then(
				() => new Error('the call was expected to fail'),
				(cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
			)
			expect(failure.message).not.toContain(KEY)
			expect(failure.message).not.toContain('Bearer')
		}
	})

	test('refuses something that is not an email before contacting anything', async () => {
		const iam = fakeIam()

		await expect(ensureFirstAdministrator(iam.client, { email: 'operator' })).rejects.toThrow('`operator` is not an email address')
		expect(iam.calls).toHaveLength(0)
	})
})
