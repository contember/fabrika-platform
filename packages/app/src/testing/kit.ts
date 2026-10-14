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
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	type IamMembershipRpc,
	isNormalizedMailbox,
	type Jwks,
	MAX_ACCESS_TOKEN_BYTES,
	normalizeEmailIdentity,
	PROXY_TOKEN_HEADER,
	SESSION_COOKIE,
	TOKEN_ALG,
	UNTRUSTED_FORWARD_HEADERS,
	workloadKeyVariable,
} from '@fabrika/auth-core'
import type { Database } from '@fabrika/db'
import { refuseInProduction } from '@fabrika/db/production'
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
import type { FILE_SCAN_JOB, FileScanner } from '../files/scan'
import { boot, type ContractApp } from '../implement/boot'
import type { ChallengeFetch } from '../implement/challenge'
import { type ConnectFetch, connectVariables } from '../implement/connect'
import type { SpaAssets } from '../implement/dispatch'
import type { ApplicationEnvironment, ContractImplementation } from '../implement/implement'
import type { WorkloadKindOf, WorkloadTokenSource } from '../implement/workload'
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
import { credentialCallers, type KitMembership, kitMembership, type MintedToken, type TestMembership } from './membership'
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
	 * that person. Throws for an invitation that is not open, and in a kit given its own `membership`.
	 */
	acceptInvitation(invitationId: string, person?: LabelledTestCaller): LabelledTestCaller
	/**
	 * Runs the cron job `name` once, as `fabrika job run <name>` does: under its lease, with the actions IAM signs for
	 * its key, its writes fenced. It first waits for the runs a form's `then` kicked, so it never races them.
	 * `FILE_SCAN_JOB` runs the scan of `scan: true` collections with the kit's `scanner`. Needs the application's data
	 * layer on Postgres.
	 */
	runJob(name: JobName<C> | typeof FILE_SCAN_JOB, options?: JobRunOptions): Promise<JobRunResult>
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
	return input instanceof Request ? new Request(input, init) : new Request(new URL(input, origin), init)
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

function bootTestKit<C extends AnyContract>(
	app: ContractImplementation<C>,
	options: TestKitOptions,
): { readonly kit: TestKit<C>; readonly standIn: KitMembership | null } {
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
	// The kit stands in for Control too: every job and webhook gets a key, which its stand-in IAM signs the declared actions for.
	const workloadVariables: Record<string, string> = {}
	const workloadsByKey = new Map<string, { readonly kind: WorkloadKindOf; readonly name: string; readonly actions: readonly string[] }>()
	const declaredWorkloads = [
		...Object.entries(artifact.jobs).map(([workload, job]) => ({ kind: 'job' as const, name: workload, actions: job.actions })),
		...Object.entries(artifact.mounts).flatMap(([workload, mount]) =>
			mount.kind === 'webhook' ? [{ kind: 'webhook' as const, name: workload, actions: mount.actions }] : []
		),
	]
	for (const workload of declaredWorkloads) {
		const key = `${API_KEY_PREFIX}test_${crypto.randomUUID().replaceAll('-', '')}`
		workloadVariables[workloadKeyVariable(workload.kind, workload.name)] = key
		workloadsByKey.set(key, workload)
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
			return {
				ok: true,
				token: await new SignJWT({ ...claims }).setProtectedHeader({ alg: TOKEN_ALG, kid: KEY_ID }).sign(privateKey),
				expiresAt: claims.exp,
			}
		},
	}
	const byKey = new Map<string, TestCaller>()
	const bySession = new Map<string, TestCaller>()
	const byToken = new Map<string, MintedToken>()
	const memberships = new Map<TestCaller, readonly TestMembership[]>()
	const directoryCallers = credentialCallers(appId, byKey, byToken, () => [...memberships].map(([caller, held]) => ({ caller, memberships: held })))
	// The stand-in answers the member directory from the kit's own callers and the writes under IAM's rules; it also
	// issues the proxy's delegation grants.
	const standIn = options.membership === undefined ? kitMembership(artifact, directoryCallers) : null
	const membership = options.membership ?? standIn?.rpc
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
		membership,
		connectBindings,
		workloadTokens,
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
		const credentials = {
			id: callerOptions.id ?? `${kind}-${issued}`,
			affiliation,
			disabled,
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

	const iam: IamGateway = {
		async mintToken({ app: audience, session }) {
			const caller = session === null || audience !== appId ? undefined : bySession.get(session)
			if (caller === undefined) {
				return { ok: false, reason: session === null ? 'no_session' : 'invalid_session' }
			}
			return mint(caller)
		},
		async mintFromKey({ app: audience, key }) {
			const caller = audience === appId ? byKey.get(key) : undefined
			if (caller === undefined) {
				return { ok: false, reason: 'invalid_key' }
			}
			return mint(caller)
		},
		// The kit issues sessions directly, so no handoff code exists to redeem.
		exchangeAuthCode: () => Promise.resolve({ ok: false, reason: 'invalid_code' }),
		getJwks: () => jwks,
	}

	const proxy = endpointProxy({ artifact, appId, host, iam, issuer: TEST_ISSUER, delegations: membership ?? null })

	// What requests leave running: a job a form's `then` kicked, or a failure's report.
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
		return application.fetch(new Request(request, { headers }), exec)
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
			return kitFetch(new Request(request, { headers }))
		}
	}

	const runJob = async (name: string, runOptions?: JobRunOptions): Promise<JobRunResult> => {
		while (background.size > 0) {
			await Promise.all(background)
		}
		return application.jobs.run(name, runOptions)
	}

	const acceptInvitation = (invitationId: string, person?: LabelledTestCaller): LabelledTestCaller => {
		if (standIn === null) {
			throw new Error('this kit was given its own membership transport, so its IAM holds no invitation to accept')
		}
		if (person !== undefined && (person.kind !== 'human' || !memberships.has(person))) {
			throw new Error('an invitation is accepted by a person of this kit: kit.testCaller(grants)')
		}
		const accepted = standIn.accept(invitationId, person?.id)
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
		kit: Object.freeze({ origin, appId, artifact, testCaller, scope, fetch: kitFetch, browser, iam, runJob, acceptInvitation }),
		standIn,
	}
}
