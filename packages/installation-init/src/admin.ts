/**
 * The first administrator of a fresh installation — the admin-RPC calls that admit them, as mechanics
 * rather than a script.
 *
 * `platform install` ends with a provisioning key and nobody who can sign in. What it takes to fix
 * that is provider-neutral: which procedures, in which order, and what makes a second run change
 * nothing. WHERE an installation's IAM answers, and how an operator names it, is the provider's own
 * question and stays in its installation package.
 *
 * Two traps a live bring-up found are encoded here rather than left to each caller:
 *
 *   - **The grant is CROSS-APP (`app: null`).** Grants filter to the calling app, so an `admin` grant
 *     scoped to the console's own app id leaves Delivery and Operations working while the Access plane
 *     refuses. IAM's own app id is not a registered app, so naming it would dangle instead.
 *   - **The two admin inputs disagree.** `grants.create` keys on `principalId` while `principals.get`
 *     and `passwords.issueEnrollment` take `PrincipalIdInput`, which keys on `id` — the obvious call
 *     answers `400 id: Required`. Hidden here deliberately; harmonizing the surface is its own work.
 *
 * The enrollment URL is a CREDENTIAL IN TRANSIT. It is RETURNED, never logged: nothing in this module
 * prints, and `log.ts` deliberately has no helper that takes a secret value.
 */

import { createRpcClient, type InferRpcClient, RpcError, type RpcFetch } from '@fabrika/app'
import type { GrantDto, IamAdminRpcContract, PrincipalListItem } from '@fabrika/iam-contract'

/** The built-in cross-app role. It is the one role that carries `iam.admin`, which the Access plane checks. */
export const ADMIN_ROLE_KEY = 'admin'

/** The typed admin surface, exactly as the console reaches it — one contract, so the two cannot drift. */
export type IamAdminClient = InferRpcClient<IamAdminRpcContract>

/**
 * The slice of that surface this flow calls, and nothing wider.
 *
 * `IamAdminClient` satisfies it, so the real client is passed straight in; a caller testing the flow
 * stands up five procedures instead of the whole administration API.
 */
export interface FirstAdministratorApi {
	readonly principals: Pick<IamAdminClient['principals'], 'get' | 'invite' | 'list'>
	readonly grants: Pick<IamAdminClient['grants'], 'create'>
	readonly passwords: Pick<IamAdminClient['passwords'], 'issueEnrollment'>
}

export interface IamAdminConnection {
	/** IAM's PUBLIC origin — the address the proxy fronts, e.g. `https://iam.example.com`. */
	readonly origin: string
	/** The installation's `px_` provisioning key, sent as `Authorization: Bearer`. */
	readonly provisioningKey: string
	/** Override `fetch` (tests). Defaults to the global one. */
	readonly fetch?: RpcFetch
}

/**
 * A client for `<origin>/admin/rpc` authenticated by the provisioning key.
 *
 * Bearer AND NOTHING ELSE, which is what makes it work at all: IAM's cross-origin guard exempts a
 * request carrying only `Authorization`, and refuses a credential-less one whatever the admin-origin
 * registry holds (`iam/src/admin/router.ts`).
 */
export const createIamAdminClient = ({ origin, provisioningKey, fetch: fetcher }: IamAdminConnection): IamAdminClient => {
	const call = fetcher ?? fetch
	return createRpcClient<IamAdminRpcContract>({
		baseUrl: `${origin.replace(/\/+$/, '')}/admin/rpc`,
		bounceOnAuth: false,
		fetch: (input, init) => {
			const headers = new Headers(init?.headers)
			headers.set('authorization', `Bearer ${provisioningKey}`)
			return call(input, { ...init, headers })
		},
	})
}

export interface FirstAdministratorRequest {
	/** The mailbox that identifies the human. Any spelling; IAM stores the normalized form. */
	readonly email: string
	/**
	 * Issue a second enrollment URL when one is already outstanding. Default false, so a re-run prints
	 * nothing new — but an enrollment that expired unopened would otherwise be unrecoverable, because
	 * the only other way to issue one is a console nobody can sign in to yet.
	 */
	readonly reissueEnrollment?: boolean
}

/** What happened to the password enrollment. Only `issued` carries a URL, and only once. */
export type EnrollmentOutcome =
	| { readonly state: 'issued'; readonly url: string; readonly expiresAt: number }
	| { readonly state: 'emailed'; readonly email: string; readonly expiresAt: number }
	| { readonly state: 'outstanding' }
	| { readonly state: 'already-set' }

export interface FirstAdministratorResult {
	readonly principalId: string
	/** The normalized mailbox, as IAM holds it. */
	readonly email: string
	readonly principal: 'invited' | 'existing'
	readonly grant: 'created' | 'present'
	readonly enrollment: EnrollmentOutcome
}

/** `q` is a substring filter, so a page is read and then matched exactly. */
const PAGE_LIMIT = 50

/** A mailbox matches at most a handful of rows; more than this many pages means the filter is not narrowing. */
const MAX_PAGES = 20

/**
 * IAM's own mailbox normalization (`normalizeEmailIdentity`), restated.
 *
 * `principals.email` is THE NORMALIZED MAILBOX and every comparison against it is plain equality, so a
 * caller matching a listed row has to fold the same way. Three operations, and they are the contract:
 * never widen this without widening IAM's.
 */
const normalizeMailbox = (value: string): string => value.normalize('NFC').trim().toLocaleLowerCase('en-US')

const assertMailbox = (email: string): void => {
	if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
		throw new Error(`\`${email}\` is not an email address`)
	}
}

/**
 * Report an admin-RPC failure as one short line naming the step.
 *
 * Fail closed and say why: an unreachable origin, a refused key and a 4xx are three different things
 * to fix. The message comes off the error envelope, which carries IAM's own wording — never the
 * request, which is the only place a credential appears.
 */
const failed = (what: string, cause: unknown): Error => {
	if (!(cause instanceof RpcError)) {
		return cause instanceof Error ? new Error(`${what} failed: ${cause.message}`) : new Error(`${what} failed`)
	}
	if (cause.type === 'transport') {
		// httpStatus 0 is a request that never got an answer; anything else answered in a shape the RPC
		// client could not read at all — an HTML error page from something that is not IAM.
		return cause.httpStatus === 0
			? new Error(`${what} failed: IAM did not answer (${cause.message})`)
			: new Error(`${what} failed: ${cause.message} — is that IAM's public host?`)
	}
	const status = cause.httpStatus === undefined ? '' : ` (HTTP ${cause.httpStatus})`
	return new Error(`${what} failed: ${cause.message}${status}`)
}

/**
 * One admin-RPC call, failing closed on everything that is not a result.
 *
 * The `undefined` guard is not defensive typing. The RPC client unwraps `{ result }`, throws on
 * `{ error }` — and returns `undefined` for a JSON body carrying NEITHER, which is exactly what a
 * misdirected host answers when its own 404 happens to be JSON. Measured: the flow then failed on a
 * property of `undefined` several calls later instead of on the wrong address.
 */
const step = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
	let result: T
	try {
		result = await call()
	} catch (cause) {
		throw failed(what, cause)
	}
	if (result === undefined) {
		throw new Error(`${what} answered no result — the address answered, but not as an IAM admin RPC surface`)
	}
	return result
}

/** Find the principal holding this mailbox, paging because `q` filters by substring and never by identity. */
const findByEmail = async (client: FirstAdministratorApi, email: string): Promise<PrincipalListItem | undefined> => {
	let before: string | undefined
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const listed = await step(
			'principals.list',
			() => client.principals.list({ type: 'user', q: email, limit: PAGE_LIMIT, ...(before === undefined ? {} : { before }) }),
		)
		const match = listed.items.find((item) => item.email !== null && normalizeMailbox(item.email) === email)
		if (match !== undefined) {
			return match
		}
		if (listed.nextCursor === null) {
			return undefined
		}
		before = listed.nextCursor
	}
	throw new Error(
		`read ${MAX_PAGES * PAGE_LIMIT} principals matching \`${email}\` without finding that exact mailbox — `
			+ 'the directory is larger than this command can scan',
	)
}

/**
 * Invite the mailbox, tolerating the one race this command can lose.
 *
 * IAM answers 409 when the mailbox already exists, which two concurrent runs produce and a re-run that
 * raced its own predecessor produces too. Re-reading rather than failing is what makes both runs
 * converge on ONE principal — and the re-read is authoritative, so nothing is assumed about who won.
 */
const admitPrincipal = async (
	client: FirstAdministratorApi,
	spelling: string,
	mailbox: string,
): Promise<{ principal: PrincipalListItem; state: 'invited' | 'existing' }> => {
	try {
		// The spelling the operator typed, NOT the folded one: IAM normalizes the mailbox itself and keeps
		// what it was handed as the principal's label.
		return { principal: await client.principals.invite({ email: spelling }), state: 'invited' }
	} catch (cause) {
		if (!(cause instanceof RpcError) || cause.httpStatus !== 409) {
			throw failed('principals.invite', cause)
		}
		const raced = await findByEmail(client, mailbox)
		if (raced === undefined) {
			throw failed('principals.invite', cause)
		}
		return { principal: raced, state: 'existing' }
	}
}

/** The grant this command would create, already present: cross-app, global, role `admin`, still valid. */
const isCrossAppAdminGrant = (grant: GrantDto, now: number): boolean =>
	grant.app === null
	&& grant.roleKey === ADMIN_ROLE_KEY
	&& grant.scopeType === null
	&& grant.scopeValue === null
	&& (grant.expiresAt === null || grant.expiresAt > now)

/**
 * Admit the first administrator, idempotently.
 *
 * Four states are reused rather than rewritten: an existing principal for this mailbox, an existing
 * cross-app `admin` grant, an outstanding enrollment, and a password that is already set. A re-run
 * therefore invites nobody twice, grants nothing twice and issues no second URL — and a run that loses
 * the invite race to a concurrent one converges on the principal that won.
 */
export const ensureFirstAdministrator = async (
	client: FirstAdministratorApi,
	request: FirstAdministratorRequest,
): Promise<FirstAdministratorResult> => {
	const email = normalizeMailbox(request.email)
	assertMailbox(email)

	const found = await findByEmail(client, email)
	const admitted = found === undefined
		? await admitPrincipal(client, request.email.trim(), email)
		: { principal: found, state: 'existing' as const }
	const principal = admitted.principal
	if (principal.status === 'disabled') {
		throw new Error(
			`principal ${principal.id} holds ${email} and is disabled — a disabled principal cannot sign in. Name a different `
				+ 'mailbox, or re-enable this one with `principals.update` ({ id, disabled: false }) before running this again',
		)
	}

	// `principals.get` keys on `id`; `grants.create` below keys on `principalId`. Same principal, two
	// spellings — this is the difference the command hides.
	const detail = await step('principals.get', () => client.principals.get({ id: principal.id }))
	const now = Math.floor(Date.now() / 1000)
	const granted = detail.grants.some((grant) => isCrossAppAdminGrant(grant, now))
	if (!granted) {
		// `app: null` is the whole point: an app-scoped admin grant leaves the Access plane refusing.
		await step('grants.create', () => client.grants.create({ principalId: principal.id, roleKey: ADMIN_ROLE_KEY, app: null }))
	}

	return {
		principalId: principal.id,
		email,
		principal: admitted.state,
		grant: granted ? 'present' : 'created',
		enrollment: await ensureEnrollment(client, principal.id, detail.authentication.password.state, request.reissueEnrollment === true),
	}
}

/**
 * Issue the password enrollment EXACTLY ONCE.
 *
 * `enabled` means a password is already set — IAM answers 409 and there is nothing to admit. `pending`
 * means an enrollment was already issued and never completed; a second URL is not issued for it,
 * because "print the URL once" is the property a re-run has to keep, and `reissue` is the explicit way
 * out when the first one expired unopened. `unavailable` means the installation offers no password
 * method at all, which no URL can fix, so it fails rather than reporting a half-admitted administrator.
 */
const ensureEnrollment = async (
	client: FirstAdministratorApi,
	principalId: string,
	state: 'unavailable' | 'disabled' | 'pending' | 'enabled',
	reissue: boolean,
): Promise<EnrollmentOutcome> => {
	if (state === 'unavailable') {
		throw new Error(
			'this installation offers no password authentication, so no enrollment can be issued — the principal and its '
				+ 'cross-app admin grant are in place; enable the password method and run this again',
		)
	}
	if (state === 'enabled') {
		return { state: 'already-set' }
	}
	if (state === 'pending' && !reissue) {
		return { state: 'outstanding' }
	}
	const delivery = await step('passwords.issueEnrollment', () => client.passwords.issueEnrollment({ id: principalId }))
	return delivery.delivery === 'manual'
		? { state: 'issued', url: delivery.url, expiresAt: delivery.expiresAt }
		: { state: 'emailed', email: delivery.email, expiresAt: delivery.expiresAt }
}
