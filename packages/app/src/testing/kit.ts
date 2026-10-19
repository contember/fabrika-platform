// The test kit of a contract application: the application booted in-process behind a stand-in for IAM and the
// production proxy decision. A request takes the production path — proxy-core's verify service over the contract's
// endpoint table, a token signed the way IAM signs it, the proxy's header stripping, `X-Fabrika-Endpoint` — into the
// real `boot` and its dispatcher.

import {
	API_KEY_PREFIX,
	buildAccessClaims,
	CLIENT_ADDRESS_HEADER,
	type ContractArtifact,
	contractDigest,
	contractWorkloads,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	type IamMembershipRpc,
	isNormalizedMailbox,
	type Jwks,
	MAX_ACCESS_TOKEN_BYTES,
	normalizeEmailIdentity,
	type PermissionEntry,
	PROXY_TOKEN_HEADER,
	SESSION_COOKIE,
	TOKEN_ALG,
	UNTRUSTED_FORWARD_HEADERS,
	workloadKeyVariable,
} from '@fabrika/auth-core'
import type { Database } from '@fabrika/db'
import { refuseInProduction } from '@fabrika/db/production'
import { MemoryEmailSender } from '@fabrika/email/memory'
import type { FileObjectStore } from '@fabrika/platform'
import { type IamGateway, REQUEST_ID_HEADER, stripFabrikaCookies } from '@fabrika/proxy-core'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RpcFetch } from '../client/transport'
import { compileContract } from '../contract/compile'
import type { AnyContract, DimensionOf } from '../contract/define'
import { diskAssets } from '../disk-assets'
import type { RequestExecutionContext } from '../fetch'
import type { FILE_SWEEP_JOB } from '../files/collections'
import type { FILE_SCAN_JOB, FileScanner } from '../files/scan'
import { boot, type BootOptions, type ContractApp } from '../implement/boot'
import type { ChallengeFetch } from '../implement/challenge'
import { type ConnectFetch, connectVariables } from '../implement/connect'
import type { SpaAssets } from '../implement/dispatch'
import type { ApplicationEnvironment, ContractImplementation } from '../implement/implement'
import type { WorkloadKindOf, WorkloadTokenSource } from '../implement/workload'
import type { MailKeyScope } from '../jobs/mail'
import type { HandlerErrorSink } from '../jobs/runner'
import type { JobRunOptions, JobRunResult } from '../jobs/runner'
import {
	type LabelledTestCaller,
	type LinkTestCaller,
	type PersonTestCaller,
	resolveGrants,
	type TestCaller,
	type TestCallerOptions,
	type TestGrant,
	type TestScope,
} from './caller'
import {
	credentialCallers,
	type JobCredential,
	type KitJobCaller,
	type KitMembership,
	kitMembership,
	type MintedToken,
	type TestMembership,
} from './membership'
import { endpointProxy } from './proxy'

export const TEST_ISSUER = 'https://iam.test'
export const TEST_ENVIRONMENT = 'test'
const KEY_ID = 'test-key'
const TOKEN_TTL_SECONDS = 300

/** Why the kit's IAM signs no token for a caller, as IAM answers the proxy. */
type MintRefusal = { readonly ok: false; readonly reason: 'disabled' | 'token_too_large' }

export interface TestKitOptions {
	/** The application's own variables, as `deps` receives them. */
	readonly env?: ApplicationEnvironment
	/**
	 * The application root an SPA mount's `dir` is relative to; the working directory when omitted. A mount whose built
	 * directory exists there is served from it as the deploy serves it: a file by its path, every other path by the
	 * directory's `index.html`. A mount not built is an empty HTML document.
	 */
	readonly root?: string
	/** Serves the SPA mounts in place of their built directories under `root`. */
	readonly assets?: SpaAssets
	/** The connection a `scoped(tables)` database is bound to, as the runtime adapter supplies it to `boot`. */
	readonly database?: Database
	/** The object storage of the file collections, as the runtime adapter supplies it to `boot`. */
	readonly files?: FileObjectStore
	/** The scanner of the scan job of `scan: true` collections; without it, the job leaves every upload quarantined. */
	readonly scanner?: FileScanner
	/**
	 * IAM's membership operations in place of the kit's own stand-in: `boot` asks it as the adapter's transport, and the
	 * kit's proxy obtains each delegation grant from it. Without it the kit's IAM answers them under IAM's rules.
	 */
	readonly membership?: IamMembershipRpc
	/**
	 * Each import's owner, by the import's name: its origin and edge key, which the platform writes as the import's
	 * framework variables, and how a request reaches it — usually the owner kit's `fetch`.
	 */
	readonly connect?: Readonly<Record<string, TestConnection>>
	/** What answers a form's challenge verification in place of the provider: a stand-in for its siteverify. */
	readonly challengeFetch?: ChallengeFetch
	/** What a job's handler threw, shown on the developer's own machine: `fabrika app dev` sets it, a test need not. */
	readonly revealHandlerErrors?: HandlerErrorSink
	/**
	 * The stand-in for every job's mail transport; a new `MemoryEmailSender` by default. Pass one with other capabilities
	 * to model another provider: `new MemoryEmailSender({ capabilities: { idempotent: false, confirmation: 'queued' } })`.
	 * `'none'` models an installation without a transport: `ctx.mail.available` is false, and every send fails
	 * `mail_not_configured`.
	 */
	readonly mail?: MemoryEmailSender | 'none'
	/**
	 * The origins the environment lists for the contract's `crossOrigin` endpoints, as an operator sets them in
	 * Control; a page on one of them may call such an endpoint with a key. None when omitted.
	 */
	readonly crossOrigins?: readonly string[]
}

export interface TestConnection {
	readonly origin: string
	readonly key: string
	readonly fetch: ConnectFetch
}

export interface TestKit<C extends AnyContract> {
	/** The origin requests are resolved against, `https://<app>.test`. */
	readonly origin: string
	/** The token audience, `<app>@test`. */
	readonly appId: string
	/** The contract as compiled for `boot`. */
	readonly artifact: ContractArtifact
	/** A new principal of the test IAM holding `grants`, with a fresh credential; only a link holder has no label. */
	testCaller(grants: readonly TestGrant<C>[], options: TestCallerOptions & { readonly kind: 'link' }): LinkTestCaller
	testCaller(grants: readonly TestGrant<C>[], options?: TestCallerOptions & { readonly kind?: 'human' }): PersonTestCaller
	testCaller(grants: readonly TestGrant<C>[], options?: TestCallerOptions & { readonly kind?: LabelledTestCaller['kind'] }): LabelledTestCaller
	testCaller(grants: readonly TestGrant<C>[], options?: TestCallerOptions): TestCaller
	/**
	 * One value of the contract's dimension `dimension`, for a grant's `scope`. Stored in a variable it keeps its
	 * dimension, where an object literal's `type` widens to `string`: `const acme = kit.scope('org', 'acme')`.
	 */
	scope<D extends DimensionOf<C>>(dimension: D, value: string): TestScope<D>
	/** A request as it reaches the proxy, credentials as written: a script, a `px_` key, or another site. */
	readonly fetch: RpcFetch
	/** `fetch` from a page of the application: same-origin, with the session cookie of `caller` when given. */
	browser(caller?: TestCaller): RpcFetch
	/** The test IAM as the proxy calls it: it mints for the credentials `testCaller` issued and serves their key set. */
	readonly iam: IamGateway
	/**
	 * The addressee of an invitation the kit's IAM holds open accepts it, as IAM's onboarding does: `person` holds the
	 * invited role in its scope from now on, or, without one, a new person labelled by the invited address does. Answers
	 * that person. Throws, leaving the invitation open, as IAM refuses: an external `person` and a role not declared
	 * external (`not_eligible`), an inviter that can no longer give the role (`not_allowed`). Throws for an invitation
	 * that is not open, and in a kit given its own `membership`.
	 */
	acceptInvitation(invitationId: string, person?: LabelledTestCaller): LabelledTestCaller
	/**
	 * Runs the cron job `name` once, as `fabrika job run <name>` does: under its lease, with the actions IAM signs for
	 * its key, its writes fenced. It first waits for the runs a form's or a mutation's `then` kicked, so it never races them.
	 * `FILE_SCAN_JOB` runs the scan of `scan: true` collections with the kit's `scanner`, `FILE_SWEEP_JOB` the sweep of
	 * removed and orphaned files. Needs the application's data layer on Postgres.
	 */
	runJob(name: JobName<C> | typeof FILE_SCAN_JOB | typeof FILE_SWEEP_JOB, options?: JobRunOptions): Promise<JobRunResult>
	/** Waits for the work requests left running: the runs a form's or a mutation's `then` kicked, a failure's report. */
	drain(): Promise<void>
	/**
	 * The stand-in for every job's transport: what reached it (`accepted`, `handoffs`) and its faults (`refuse`,
	 * `unavailable`, `unreachable`, `loseAnswers`, `during`, `heal`). Each message carries the transport key,
	 * `transportMailKey(kit.mailKeyScope, key)`. Under `mail: 'none'` nothing reaches it.
	 */
	readonly mail: MemoryEmailSender
	/** Whose keys this kit's prefix separates: `mailKeyPrefix(kit.mailKeyScope)` is what a job's key gets in front. */
	readonly mailKeyScope: MailKeyScope
}

/** The names of the contract's cron jobs. */
export type JobName<C> = C extends { readonly surface: { readonly jobs: infer J } } ? keyof J & string : never

/** Each SPA mount from its built directory under `root` when one exists, as the deploy serves it; an empty page otherwise. */
function builtAssets(root: string): SpaAssets {
	const disk = diskAssets(root)
	const empty = () => new Response('<!doctype html><title></title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
	return {
		serve: (mount, request) => (existsSync(resolve(root, mount.dir)) ? disk.serve(mount, request) : Promise.resolve(empty())),
	}
}

function toRequest(origin: string, input: RequestInfo | URL, init: RequestInit | undefined): Request {
	if (!(input instanceof Request)) {
		return new Request(new URL(input, origin), init)
	}
	// Never `new Request(request, …)`: Bun would buffer the body the application must meet as a stream.
	const base = { method: input.method, headers: input.headers, body: input.body, signal: input.signal, redirect: input.redirect }
	return init === undefined ? input : new Request(input.url, { ...base, ...init })
}

/**
 * `request` with `headers`, its body passed on as the stream it is: `new Request(request, { headers })` would have Bun
 * buffer the body, and the application must meet a body as it streams, as it does behind the proxy.
 */
function withHeaders(request: Request, headers: Headers): Request {
	return new Request(request.url, { method: request.method, headers, body: request.body, signal: request.signal, redirect: request.redirect })
}

/** Every header only the proxy may assert, deleted before the decision as Caddy and the proxy Worker delete them. */
function stripClientAsserted(headers: Headers): void {
	for (const header of [...headers.keys()]) {
		if (header.toLowerCase().startsWith('x-fabrika-')) {
			headers.delete(header)
		}
	}
	headers.delete(PROXY_TOKEN_HEADER)
	headers.delete(CLIENT_ADDRESS_HEADER)
	headers.delete(REQUEST_ID_HEADER)
	for (const header of UNTRUSTED_FORWARD_HEADERS) {
		headers.delete(header)
	}
}

/** Boots `app` the way its generated entrypoint would, behind the test proxy and IAM. Throws `BootError` like `boot`. */
export function testKit<C extends AnyContract>(app: ContractImplementation<C>, options: TestKitOptions = {}): TestKit<C> {
	return bootTestKit(app, options).kit
}

/** The kit of the generated tests, and its stand-in IAM, which seeds the invitations and links a case names. */
export interface StandInIamKit<C extends AnyContract> {
	readonly kit: TestKit<C>
	readonly standIn: KitMembership
}

/** The kit of the generated tests, with a handle on its stand-in IAM to seed what a case names. */
export function standInIamKit<C extends AnyContract>(
	app: ContractImplementation<C>,
	options: Omit<TestKitOptions, 'membership'> = {},
): StandInIamKit<C> {
	const { kit, standIn } = bootTestKit(app, options)
	if (standIn === null) {
		throw new Error('a kit without its own membership transport stands in for IAM')
	}
	return { kit, standIn }
}

/** A booted kit, and its stand-in IAM unless it was given a membership transport. */
export interface BootedTestKit<C extends AnyContract> {
	readonly kit: TestKit<C>
	readonly standIn: KitMembership | null
	/** The caller `value` is when `testCaller` or `acceptInvitation` of this kit made it; `undefined` for any other value. */
	callerOf(value: unknown): TestCaller | undefined
}

/** What only `fabrika app dev`'s kit boots with, never a test's. */
export type DevBootOptions = Pick<BootOptions, 'repeatableChallengeToken'>

export function bootTestKit<C extends AnyContract>(
	app: ContractImplementation<C>,
	options: TestKitOptions,
	dev: DevBootOptions = {},
): BootedTestKit<C> {
	refuseInProduction('@fabrika/app/testing')
	const name = app.contract.vocabulary.app
	const appId = `${name}@${TEST_ENVIRONMENT}`
	const host = `${name}.test`
	const origin = `https://${host}`
	const artifact = compileContract(app.contract, app.database?.tables ?? {})
	const signing = generateKeyPair(TOKEN_ALG)
	const jwks: Promise<Jwks> = signing.then(async ({ publicKey }) => {
		const { kty, crv, x, y } = await exportJWK(publicKey)
		if (kty === undefined) {
			throw new Error('the generated signing key exported no key type')
		}
		return { keys: [{ kty, crv, x, y, kid: KEY_ID, alg: TOKEN_ALG, use: 'sig' }] }
	})
	const connectVariablesOf: Record<string, string> = {}
	const connectBindings: Record<string, ConnectFetch> = {}
	for (const [name, connection] of Object.entries(options.connect ?? {})) {
		const variables = connectVariables(name)
		connectVariablesOf[variables.url] = connection.origin
		connectVariablesOf[variables.key] = connection.key
		connectBindings[variables.binding] = connection.fetch
	}
	// The kit stands in for Control too: every workload gets a key, which its stand-in IAM signs the declared actions for.
	const workloadVariables: Record<string, string> = {}
	const workloadsByKey = new Map<string, { readonly kind: WorkloadKindOf; readonly name: string; readonly actions: readonly string[] }>()
	// A job's key and the tokens signed for it are its credential at the stand-in IAM's link operations, as at IAM's.
	const jobCredentials = new Map<string, JobCredential>()
	const jobCallerOf = (name: string): KitJobCaller | undefined => {
		const job = Object.hasOwn(artifact.jobs, name) ? artifact.jobs[name] : undefined
		return job === undefined ? undefined : { id: `job-${name}`, actions: job.actions, issues: artifact.declared?.[`job:${name}`]?.issues ?? null }
	}
	for (const workload of contractWorkloads(artifact)) {
		const key = `${API_KEY_PREFIX}test_${crypto.randomUUID().replaceAll('-', '')}`
		workloadVariables[workloadKeyVariable(workload.kind, workload.name)] = key
		workloadsByKey.set(key, workload)
		const job = workload.kind === 'job' ? jobCallerOf(workload.name) : undefined
		if (job !== undefined) jobCredentials.set(key, { job, expiresAt: null })
	}
	const workloadTokens: WorkloadTokenSource = {
		async exchange({ app: audience, key }) {
			const workload = audience === appId ? workloadsByKey.get(key) : undefined
			if (workload === undefined) {
				return { ok: false, reason: 'invalid_key' }
			}
			const now = Math.floor(Date.now() / 1000)
			const claims = buildAccessClaims({
				iss: TEST_ISSUER,
				app: appId,
				subject: `${workload.kind}-${workload.name}`,
				type: workload.kind,
				workload: workload.name,
				label: `${workload.kind}:${workload.name}`,
				permissions: workload.actions.map((action) => ({ action, scope: null, source: 'grant' })),
				issuedAt: now,
				expiresAt: now + TOKEN_TTL_SECONDS,
			})
			const { privateKey } = await signing
			const token = await new SignJWT({ ...claims }).setProtectedHeader({ alg: TOKEN_ALG, kid: KEY_ID }).sign(privateKey)
			const job = jobCredentials.get(key)?.job
			if (job !== undefined) jobCredentials.set(token, { job, expiresAt: claims.exp })
			return { ok: true, token, expiresAt: claims.exp }
		},
	}
	const byKey = new Map<string, TestCaller>()
	const bySession = new Map<string, TestCaller>()
	const byToken = new Map<string, MintedToken>()
	const memberships = new Map<TestCaller, readonly TestMembership[]>()
	const directoryCallers = credentialCallers(
		appId,
		byKey,
		byToken,
		() => [...memberships].map(([caller, held]) => ({ caller, memberships: held })),
		jobCredentials,
	)
	// The stand-in answers the member directory from the kit's own callers and the writes under IAM's rules; it also
	// issues the proxy's delegation grants.
	const standIn = options.membership === undefined ? kitMembership(artifact, directoryCallers) : null
	const membership = options.membership ?? standIn?.rpc
	const mail = options.mail === undefined || options.mail === 'none' ? new MemoryEmailSender() : options.mail
	const mailKeyScope: MailKeyScope = Object.freeze({ issuer: TEST_ISSUER, appId })
	const application: ContractApp = boot(app, {
		environment: {
			// The deploy writes the approved contract's digest; the kit's contract is the approved one by definition.
			framework: {
				[FABRIKA_IAM_APP_ID]: appId,
				[FABRIKA_IAM_ISSUER]: TEST_ISSUER,
				[FABRIKA_CONTRACT_DIGEST]: contractDigest(artifact),
				...connectVariablesOf,
				...workloadVariables,
			},
			application: options.env ?? {},
		},
		iam: { getJwks: () => jwks },
		assets: options.assets ?? builtAssets(options.root ?? process.cwd()),
		database: options.database,
		files: options.files,
		...(options.scanner === undefined ? {} : { scanner: options.scanner }),
		...(options.challengeFetch === undefined ? {} : { challengeFetch: options.challengeFetch }),
		...dev,
		...(options.revealHandlerErrors === undefined ? {} : { revealHandlerErrors: options.revealHandlerErrors }),
		membership,
		connectBindings,
		workloadTokens,
		mailStandIn: options.mail === 'none' ? 'none' : mail,
	})

	let issued = 0

	function testCaller(grants: readonly TestGrant<C>[], options: TestCallerOptions & { readonly kind: 'link' }): LinkTestCaller
	function testCaller(grants: readonly TestGrant<C>[], options?: TestCallerOptions & { readonly kind?: 'human' }): PersonTestCaller
	function testCaller(
		grants: readonly TestGrant<C>[],
		options?: TestCallerOptions & { readonly kind?: LabelledTestCaller['kind'] },
	): LabelledTestCaller
	function testCaller(grants: readonly TestGrant<C>[], options?: TestCallerOptions): TestCaller
	function testCaller(grants: readonly TestGrant<C>[], callerOptions: TestCallerOptions = {}): TestCaller {
		return issue(grants, callerOptions)
	}

	/** `testCaller` over the contract's names as plain strings, which `acceptInvitation` reads from its stand-in IAM. */
	function issue(grants: readonly TestGrant<AnyContract>[], callerOptions: TestCallerOptions): TestCaller {
		const kind = callerOptions.kind ?? 'human'
		const via = kind === 'human' ? (callerOptions.via ?? 'session') : 'key'
		issued += 1
		const credential = crypto.randomUUID().replaceAll('-', '')
		const consumer = kind === 'app' ? (callerOptions.app ?? '') : null
		if (consumer === '') {
			throw new Error("an app caller names the consuming application: testCaller(grants, { kind: 'app', app: '<id>' })")
		}
		if (callerOptions.link !== undefined && kind !== 'link') {
			throw new Error("only a link holder's key is bound to an object: testCaller(grants, { kind: 'link', link: { mount, chain } })")
		}
		if (callerOptions.email !== undefined && kind !== 'human') {
			throw new Error('only a person has an address: testCaller(grants, { email }) is a human')
		}
		const email = kind === 'human' ? normalizeEmailIdentity(callerOptions.email ?? `${kind}-${issued}@${name}.test`) : null
		if (email !== null && !isNormalizedMailbox(email)) {
			throw new Error(`a test caller's email is an address, not '${email}'`)
		}
		const affiliation = callerOptions.affiliation ?? 'internal'
		if (affiliation === 'external') {
			if (kind !== 'human') {
				throw new Error("only a human is external: testCaller(grants, { affiliation: 'external' })")
			}
			const roles = app.contract.vocabulary.roles
			for (const grant of grants) {
				if (!('role' in grant) || !Object.hasOwn(roles, grant.role) || roles[grant.role]?.external !== true) {
					throw new Error('an external caller holds only roles the contract declares external: { member: { … }, external: true }')
				}
			}
		}
		const disabled = callerOptions.disabled ?? false
		if (disabled && kind === 'link') {
			throw new Error('a link holder is no principal, so no operator disables it: disable a person, a script or a connector')
		}
		if (callerOptions.lastSignInAt !== undefined && kind !== 'human') {
			throw new Error('only a person signs in: testCaller(grants, { lastSignInAt }) is a human')
		}
		const credentials = {
			id: callerOptions.id ?? `${kind}-${issued}`,
			affiliation,
			disabled,
			lastSignInAt: callerOptions.lastSignInAt ?? null,
			perms: Object.freeze(resolveGrants<AnyContract>(app.contract, grants)),
			key: via === 'key' ? `${API_KEY_PREFIX}test_${credential}` : null,
			cookie: via === 'session' ? `${SESSION_COOKIE}=${credential}` : null,
		}
		const link = callerOptions.link
		const caller: TestCaller = kind === 'link'
			? Object.freeze({
				...credentials,
				kind,
				app: null,
				label: null,
				email: null,
				link: link === undefined
					? null
					: Object.freeze({ mount: link.mount, chain: Object.freeze(link.chain.map((scope) => Object.freeze({ ...scope }))) }),
			})
			: Object.freeze({ ...credentials, kind, app: consumer, label: callerOptions.label ?? `${kind}-${issued}@${name}.test`, email, link: null })
		memberships.set(
			caller,
			grants.flatMap((grant) => ('role' in grant ? [{ role: grant.role, scope: grant.scope ?? null }] : [])),
		)
		if (caller.key !== null) {
			byKey.set(caller.key, caller)
		} else {
			bySession.set(credential, caller)
		}
		return caller
	}

	const scope = <D extends DimensionOf<C>>(dimension: D, value: string): TestScope<D> => Object.freeze({ type: dimension, value })

	/** The caller's token, or why IAM signs none: a disabled principal, or a token above `MAX_ACCESS_TOKEN_BYTES`. */
	async function mint(caller: TestCaller): Promise<{ readonly ok: true; readonly token: string; readonly expiresAt: number } | MintRefusal> {
		if (caller.disabled) return { ok: false, reason: 'disabled' }
		const now = Math.floor(Date.now() / 1000)
		const claims = buildAccessClaims({
			iss: TEST_ISSUER,
			app: appId,
			subject: caller.id,
			...(caller.kind === 'link' ? {} : { type: caller.kind === 'human' ? 'user' : caller.kind === 'app' ? 'app' : 'service' }),
			...(caller.app === null ? {} : { workload: caller.app }),
			...(caller.link === null ? {} : { link: { mount: caller.link.mount, chain: [...caller.link.chain] } }),
			label: caller.label,
			...(caller.email === null ? {} : { email: caller.email }),
			permissions: [...(standIn?.permsOf(caller) ?? caller.perms)],
			issuedAt: now,
			expiresAt: now + TOKEN_TTL_SECONDS,
		})
		const { privateKey } = await signing
		const token = await new SignJWT({ ...claims }).setProtectedHeader({ alg: TOKEN_ALG, kid: KEY_ID }).sign(privateKey)
		if (token.length > MAX_ACCESS_TOKEN_BYTES) return { ok: false, reason: 'token_too_large' }
		byToken.set(token, { caller, expiresAt: claims.exp })
		return { ok: true, token, expiresAt: claims.exp }
	}

	/**
	 * The holder of a key the stand-in IAM issued through `ctx.links`, as IAM resolves a link key: the mount's grants on
	 * the link's object, bound to its chain; nothing once the link is revoked.
	 */
	function linkHolderOf(key: string): LinkTestCaller | undefined {
		const link = standIn?.linkOfKey(key)
		const mount = link === undefined ? undefined : artifact.mounts[link.mount]
		const object = link?.chain[0]
		if (link === undefined || mount?.kind !== 'link' || object === undefined) return undefined
		const chain = Object.freeze(link.chain.map((scope) => Object.freeze({ type: scope.type, value: scope.value })))
		return Object.freeze({
			id: link.id,
			affiliation: 'internal',
			disabled: false,
			perms: Object.freeze(
				mount.grants.map((action): PermissionEntry => ({ action, scope: { type: object.type, value: object.value }, source: 'grant' })),
			),
			key,
			cookie: null,
			kind: 'link',
			app: null,
			label: null,
			email: null,
			lastSignInAt: null,
			link: Object.freeze({ mount: link.mount, chain }),
		})
	}

	const iam: IamGateway = {
		async mintToken({ app: audience, session }) {
			const caller = session === null || audience !== appId ? undefined : bySession.get(session)
			if (caller === undefined) {
				return { ok: false, reason: session === null ? 'no_session' : 'invalid_session' }
			}
			return mint(caller)
		},
		async mintFromKey({ app: audience, key }) {
			const caller = audience === appId ? (byKey.get(key) ?? linkHolderOf(key)) : undefined
			if (caller === undefined) {
				return { ok: false, reason: 'invalid_key' }
			}
			return mint(caller)
		},
		// The kit issues sessions directly, so no handoff code exists to redeem.
		exchangeAuthCode: () => Promise.resolve({ ok: false, reason: 'invalid_code' }),
		getJwks: () => jwks,
	}

	const proxy = endpointProxy({
		artifact,
		appId,
		host,
		iam,
		issuer: TEST_ISSUER,
		delegations: membership ?? null,
		...(options.crossOrigins === undefined ? {} : { crossOrigins: options.crossOrigins }),
	})

	// What requests leave running: a job a form's or a mutation's `then` kicked, or a failure's report.
	const background = new Set<Promise<void>>()
	const exec: RequestExecutionContext = {
		waitUntil(promise) {
			const tracked = promise.then(() => undefined, () => undefined)
			background.add(tracked)
			void tracked.then(() => background.delete(tracked))
		},
	}

	const kitFetch: RpcFetch = async (input, init) => {
		const request = toRequest(origin, input, init)
		if (new URL(request.url).origin !== origin) {
			throw new TypeError(`the test kit serves only ${origin}, not ${new URL(request.url).origin}`)
		}
		const headers = new Headers(request.headers)
		stripClientAsserted(headers)
		const outcome = await proxy({ method: request.method, url: request.url, headers: new Headers(headers) })
		if (outcome.outcome === 'answer') {
			// The proxy's own answer carries its header policy, or the file treatment, as in production.
			return outcome.response
		}
		stripFabrikaCookies(headers)
		if (!outcome.keepsAuthorization) {
			headers.delete('Authorization')
		}
		for (const [header, value] of outcome.asserted) {
			headers.set(header, value)
		}
		const answer = await application.fetch(withHeaders(request, headers), exec)
		const decorated = new Headers(answer.headers)
		outcome.decorate(decorated)
		return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: decorated })
	}

	function browser(caller?: TestCaller): RpcFetch {
		if (caller !== undefined && caller.cookie === null) {
			throw new Error(`a browser carries a session; pass the ${caller.kind}'s key to createClient instead`)
		}
		return (input, init) => {
			const request = toRequest(origin, input, init)
			// Bun's Request does not keep its credentials mode, so `init` is the only reliable reading of it.
			const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined)
			const headers = new Headers(request.headers)
			if (!headers.has('Sec-Fetch-Site')) {
				headers.set('Sec-Fetch-Site', 'same-origin')
			}
			if (!headers.has('Sec-Fetch-Mode')) {
				headers.set('Sec-Fetch-Mode', 'cors')
			}
			if (caller !== undefined && caller.cookie !== null && credentials !== 'omit') {
				const cookies = headers.get('Cookie')
				headers.set('Cookie', cookies === null || cookies === '' ? caller.cookie : `${cookies}; ${caller.cookie}`)
			}
			return kitFetch(withHeaders(request, headers))
		}
	}

	const drain = async (): Promise<void> => {
		while (background.size > 0) {
			await Promise.all(background)
		}
	}

	const runJob = async (name: string, runOptions?: JobRunOptions): Promise<JobRunResult> => {
		await drain()
		return application.jobs.run(name, runOptions)
	}

	const acceptInvitation = (invitationId: string, person?: LabelledTestCaller): LabelledTestCaller => {
		if (standIn === null) {
			throw new Error('this kit was given its own membership transport, so its IAM holds no invitation to accept')
		}
		if (person !== undefined && (person.kind !== 'human' || !memberships.has(person))) {
			throw new Error('an invitation is accepted by a person of this kit: kit.testCaller(grants)')
		}
		const accepted = standIn.accept(invitationId, person)
		if (person !== undefined) return person
		const external = app.contract.vocabulary.roles[accepted.role]?.external === true
		const invitee = issue([{ role: accepted.role, scope: accepted.scope }], {
			label: accepted.email,
			email: accepted.email,
			affiliation: external ? 'external' : 'internal',
		})
		if (invitee.kind === 'link') {
			throw new Error('an invitation is accepted by a person')
		}
		return invitee
	}
	return {
		kit: Object.freeze({
			origin,
			appId,
			artifact,
			testCaller,
			scope,
			fetch: kitFetch,
			browser,
			iam,
			runJob,
			drain,
			acceptInvitation,
			mail,
			mailKeyScope,
		}),
		standIn,
		callerOf: (value) => [...memberships.keys()].find((caller) => caller === value),
	}
}
