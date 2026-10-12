// The per-request pipeline of a contract application (ADR-0012 §5): canonical path and endpoint selection, the
// endpoint the proxy applied (ADR-0022 rule 5), the token, the caller kind, the requirement, admission, strict input, the access form, the handler, output
// projection. The caller-kind, requirement and access checks are authorization; the same-origin and content-type
// checks are admission. Neither is the proxy's decision: the proxy has already decided that the request may reach us.
// The anonymous kinds (health, form, webhook, the share SPA) read no token and take their own fixed steps.

import type { IamMembership } from '@fabrika/auth'
import {
	type CompiledEndpointTable,
	type CredentialedEndpoint,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	type EndpointDirectory,
	type EndpointPlan,
	type EndpointRow,
	type ExportDescription,
	type LinkTokenClaims,
	parseEndpointHeader,
	type PermissionEntry,
	permits,
	planEndpoint,
	PROXY_SECRET_HEADER,
	PROXY_TOKEN_HEADER,
	rawRequestTarget,
	satisfies,
	scopedValues,
} from '@fabrika/auth-core'
import { type CapabilityAuthority, type ContainerGrant, MAX_WITHIN_VALUES } from '@fabrika/db/capability'
import type { DataAccess, FrameworkTables } from '@fabrika/db/framework'
import type { DataKind } from '@fabrika/db/tables'
import type { TokenVerifier } from '@fabrika/jwks'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod/v4'
import { BROWSER_CONFIG_FILE, joinPath, WEBHOOK_BINDING_PARAMETER } from '../contract/defaults'
import type { Schema } from '../contract/define'
import {
	BadRequestError,
	ForbiddenError,
	HttpError,
	isStructuralError,
	jsonResponse,
	NotFoundError,
	toErrorResponse,
	UnauthorizedError,
} from '../errors'
import type { RequestExecutionContext } from '../fetch'
import { FileDownload, fileResponse, withFileTreatment } from '../files/treatment'
import {
	bootstrapPath,
	bootstrapResponse,
	type FormRateLimiter,
	githubAccounts,
	readBoundedBody,
	verifyGithubSignature,
	withBootstrap,
} from './anonymous'
import { CapabilityLimitError, type CapabilityMint, RequestFrame, runInRequest } from './capability'
import { connectContext, type ImportWire } from './connect'
import type { FailureReports } from './failures'
import { ServerFault } from './faults'
import { type HeaderPolicy, withHeaderPolicy } from './headers'
import type { ContractDatabase } from './implement'
import { endpointData, Invocation, siteData, type SiteDeclaration } from './invocation'
import { createScope, type IssuableLink, linkIssuing, memberDirectory, memberManagement, type MembershipRequest } from './membership'
import { presentedBy, type Principal } from './principal'
import { project, ProjectionRefusedError } from './project'
import { deliveryKey, WEBHOOK_REPLAY_RETENTION_MS, type WebhookPrincipal, webhookSubject } from './webhook'
import type { WorkloadCredential } from './workload'

/** SHA-256 of a proxy secret: 32 bytes whatever the secret's length, as `timingSafeEqual` needs. */
export function proxySecretDigest(secret: string): Uint8Array {
	return createHash('sha256').update(secret).digest()
}

/** Serves the files of an SPA mount. The runtime adapter supplies it: Workers Assets, or the build output on disk. */
export interface SpaAssets {
	serve(mount: { readonly prefix: string; readonly dir: string }, request: Request): Promise<Response>
}

/** What a procedure's context carries beyond its access form, decided once from the artifact. */
export interface Facilities {
	/**
	 * `ctx.members`: management where the action is the dimension's `members.manage`; otherwise the member directory of the
	 * nearest dimension, the endpoint's own or one containing it, that declares members (`endpointDirectory`).
	 */
	readonly members: 'manage' | EndpointDirectory | null
	/** The link mounts whose dimension and issuing action are the endpoint's. */
	readonly links: readonly IssuableLink[]
}

export const NO_FACILITIES: Facilities = Object.freeze({ members: null, links: Object.freeze([]) })

/** A staged-kit site: its handler reaches data through `ctx.db`, in the invocation's transaction. */
export interface ServedSite {
	/** A query and an export read only, in a `READ ONLY` transaction; a mutation also writes. */
	readonly kind: DataKind
	readonly declaration: SiteDeclaration
}

export type ServedEndpoint =
	| {
		readonly kind: 'procedure'
		readonly row: CredentialedEndpoint
		readonly input: Schema | null
		readonly output: Schema
		readonly handler: (args: { readonly input: Readonly<Record<string, unknown>>; readonly ctx: object }) => unknown
		readonly facilities: Facilities
		/** An export procedure: its request may only read. */
		readonly readOnly?: true
		/** `ctx.connect`, for an endpoint an import's `usedBy` names. */
		readonly connect?: readonly ImportWire[]
		/** A staged-kit site, which gets `ctx.db`; a handler `implement` bound has none. */
		readonly site?: ServedSite
	}
	/** What an export's consumer vendors, behind the export's own callers. */
	| { readonly kind: 'description'; readonly row: CredentialedEndpoint; readonly description: ExportDescription }
	| { readonly kind: 'spa'; readonly row: CredentialedEndpoint; readonly prefix: string; readonly dir: string }
	/** An SPA anyone opens: anonymous, served without a token. */
	| { readonly kind: 'public-spa'; readonly row: EndpointRow; readonly prefix: string; readonly dir: string }
	| { readonly kind: 'health'; readonly row: EndpointRow }
	| {
		/** A file collection's upload or download, served by `src/files` once the access form minted its target. */
		readonly kind: 'file'
		readonly row: CredentialedEndpoint
		readonly serve: (request: Request, target: unknown) => Promise<Response | FileDownload>
	}
	/** The shell of a link mount's share SPA: anonymous, and served with the fragment bootstrap. */
	| { readonly kind: 'link-spa'; readonly row: EndpointRow; readonly prefix: string; readonly dir: string }
	| { readonly kind: 'form'; readonly row: EndpointRow; readonly form: string; readonly input: Schema }
	| {
		readonly kind: 'webhook'
		readonly row: EndpointRow
		readonly webhook: string
		readonly dimension: string
		readonly actions: readonly string[]
		readonly input: Schema
		readonly handler: (args: { readonly input: unknown; readonly ctx: object }) => unknown
		/** The webhook's key: its refs carry only what IAM signs for it. */
		readonly credential: WorkloadCredential
		/** A staged-kit webhook's declaration: its delivery runs in one transaction, through `ctx.db`. */
		readonly site?: SiteDeclaration
	}

export interface RuntimeParts {
	readonly table: CompiledEndpointTable
	readonly endpoints: ReadonlyMap<string, ServedEndpoint>
	/** Endpoint id → `requirementDigest` of its row: what the proxy's `X-Fabrika-Endpoint` must name. */
	readonly digests: ReadonlyMap<string, string>
	readonly verifier: TokenVerifier
	/** The token audience: this application's IAM id in this environment, `<app>@<env>`. */
	readonly audience: string
	/** `proxySecretDigest` of the proxy secret every request must carry; `null` where the hop is a service binding. */
	readonly proxySecretDigest: Uint8Array | null
	readonly policy: HeaderPolicy
	readonly database: ContractDatabase | null
	/** Dimensions a table owns, so `in` and `on` must find the object. */
	readonly ownedDimensions: ReadonlySet<string>
	/** Each dimension's containers, nearest first; a grant on one reaches every value inside it. */
	readonly containers: ReadonlyMap<string, readonly string[]>
	readonly assets: SpaAssets | null
	/** IAM's membership operations; `boot` refuses a contract that needs them when the adapter supplies none. */
	readonly membership: IamMembership | null
	/** The framework's own writes (inboxes, webhook tables); `boot` refuses a form or webhook without them. */
	readonly framework: FrameworkTables | null
	readonly forms: FormRateLimiter
	/** This runtime's capability mint, which `boot` alone holds, and the authority its stores are bound to. */
	readonly mint: CapabilityMint
	readonly capabilities: CapabilityAuthority
	/** The mini-ORM of the bound `scoped(tables)` layer; `boot` refuses a site without one. */
	readonly data: DataAccess | null
	/** Where a 5xx goes: the server log, and Operations when the application has a DSN. */
	readonly failures: FailureReports
	/** What every SPA mount answers at `<prefix>/__fabrika-config.json`, and nothing else of the environment. */
	readonly browserConfig: BrowserConfig
}

/** The browser-safe Operations settings: the ingest DSN (a public key) and the release, or `null` without them. */
export interface BrowserConfig {
	readonly dsn: string | null
	readonly release: string | null
}

interface Caller {
	readonly principal: Principal
	/** The principal id a capability is granted to: the token's subject. */
	readonly subject: string
	readonly perms: PermissionEntry[]
	/** The verified token, which IAM resolves the caller from on a membership request. */
	readonly token: string
	/** The mount and chain a share-link token is bound to. */
	readonly link: LinkTokenClaims | null
}

/** The proxy's id of this request (proxy-core's `REQUEST_ID_HEADER`); a delegation grant is bound to it. */
const REQUEST_ID_HEADER = 'X-Request-Id'
/** A binding id is a UUID; anything else names no binding and reaches no query. */
const BINDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Access {
	readonly context: Readonly<Record<string, unknown>>
	readonly input: Readonly<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The media type of a `Content-Type` value, without parameters, lower-cased. */
function mediaType(header: string | null): string | null {
	const type = header?.split(';')[0]?.trim().toLowerCase()
	return type === undefined || type === '' ? null : type
}

function describeRequirement(row: CredentialedEndpoint): string {
	return row.requirement.kind === 'member' ? 'a permission in this application' : `'${row.requirement.action}' in some scope`
}

export class ContractRuntime {
	readonly #parts: RuntimeParts

	constructor(parts: RuntimeParts) {
		this.#parts = parts
	}

	/**
	 * Every answer of a download endpoint, a denial included, carries the file treatment; every other one the policy.
	 * `exec` keeps a failure's report alive past the response, where the runtime would otherwise end it.
	 */
	async fetch(request: Request, exec?: RequestExecutionContext): Promise<Response> {
		const plan = planEndpoint(this.#parts.table, request.method, rawRequestTarget(request.url).pathname)
		const answer = await this.#answer(request, plan, exec)
		if (answer instanceof FileDownload) {
			return fileResponse(answer)
		}
		return plan.outcome === 'endpoint' && plan.endpoint.kind === 'download' ? withFileTreatment(answer) : withHeaderPolicy(answer, this.#parts.policy)
	}

	async #answer(request: Request, plan: EndpointPlan, exec: RequestExecutionContext | undefined): Promise<Response | FileDownload> {
		let where = 'request'
		try {
			const served = plan.outcome === 'endpoint' ? this.#parts.endpoints.get(plan.endpoint.id) : undefined
			// Before any other answer: a direct dial learns nothing, not even whether its path exists.
			if (served?.kind !== 'health' && !this.#throughProxy(request)) {
				throw new ForbiddenError('This application answers only its proxy')
			}
			if (plan.outcome === 'non-canonical') {
				throw new BadRequestError('The request path is not canonical')
			}
			if (plan.outcome !== 'endpoint' || served === undefined) {
				throw new NotFoundError(`No endpoint serves ${request.method} ${rawRequestTarget(request.url).pathname}`)
			}
			where = served.row.id
			this.#checkEndpoint(served, request)
			switch (served.kind) {
				case 'health':
					return jsonResponse({ status: 'ok' }, 200)
				case 'spa': {
					await this.#authorize(served.row, request)
					return await this.#spaFile(served, request)
				}
				case 'public-spa':
					return await this.#spaFile(served, request)
				case 'link-spa':
					if (rawRequestTarget(request.url).pathname === bootstrapPath(served.prefix)) {
						return bootstrapResponse()
					}
					return await withBootstrap(await this.#assets().serve({ prefix: served.prefix, dir: served.dir }, request), served.prefix)
				case 'procedure':
					return await this.#procedure(served, request)
				case 'file':
					return await this.#file(served, request, plan.params)
				case 'form':
					return await this.#form(served, request)
				case 'webhook':
					return await this.#webhook(served, request, plan.params)
				case 'description':
					await this.#authorize(served.row, request)
					await readInput({ row: served.row, input: null }, request)
					return jsonResponse({ result: served.description }, 200)
			}
		} catch (error) {
			const response = errorResponse(error, where)
			if (response.status >= 500) {
				const failure = { endpoint: where, requestId: request.headers.get(REQUEST_ID_HEADER), status: response.status, error }
				const delivery = this.#parts.failures.record(failure)
				exec?.waitUntil(delivery)
			}
			return response
		}
	}

	/** An SPA mount's files, and at `<prefix>/__fabrika-config.json` the browser's Operations settings. */
	async #spaFile(served: { readonly prefix: string; readonly dir: string }, request: Request): Promise<Response> {
		if (rawRequestTarget(request.url).pathname === joinPath(served.prefix, BROWSER_CONFIG_FILE)) {
			return jsonResponse(this.#parts.browserConfig, 200)
		}
		return await this.#assets().serve({ prefix: served.prefix, dir: served.dir }, request)
	}

	/**
	 * The proxy proves it sent the request with the secret of this application environment (ADR-0022 rule 5). The
	 * fixed-size digests are compared in constant time, so neither the length nor a prefix of the secret leaks.
	 */
	#throughProxy(request: Request): boolean {
		const expected = this.#parts.proxySecretDigest
		if (expected === null) {
			return true
		}
		const presented = request.headers.get(PROXY_SECRET_HEADER) ?? ''
		return presented !== '' && timingSafeEqual(proxySecretDigest(presented), expected)
	}

	/**
	 * The proxy names the endpoint it selected and the digest of the rules it applied. Any disagreement with this
	 * version's own selection or rules is a 503, so no request is served under rules the proxy did not apply. A
	 * health endpoint answers a constant and is what the platform's liveness probe dials directly, so it alone may
	 * arrive without the header.
	 */
	#checkEndpoint(served: ServedEndpoint, request: Request): void {
		const header = request.headers.get(ENDPOINT_HEADER)
		if (header === null && served.kind === 'health') {
			return
		}
		const named = header === null ? null : parseEndpointHeader(header)
		if (named === null) {
			throw new ServerFault('endpoint_decision_missing', `'${served.row.id}' was reached without the proxy's endpoint decision`, 503)
		}
		if (named.id !== served.row.id || named.digest !== this.#parts.digests.get(served.row.id)) {
			throw new ServerFault(
				'endpoint_decision_mismatch',
				`the proxy applied '${named.id}' with other rules than this version serves '${served.row.id}' with`,
				503,
			)
		}
	}

	#assets(): SpaAssets {
		const assets = this.#parts.assets
		if (assets === null) {
			throw new ServerFault('facility_unbound', 'no asset server serves the SPA')
		}
		return assets
	}

	/** Token, caller kind, requirement, then admission. */
	async #authorize(row: CredentialedEndpoint, request: Request): Promise<Caller> {
		const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
		if (token === '') {
			throw new UnauthorizedError('This endpoint needs a credential, and the request carries none')
		}
		const verified = await this.#parts.verifier.verify(token, this.#parts.audience)
		if (!verified.ok) {
			if (verified.reason === 'unavailable') {
				throw new ServerFault('key_set_unavailable', 'the IAM key set could not be fetched; nothing was checked', 503)
			}
			throw new UnauthorizedError('The credential does not verify')
		}
		const presented = presentedBy(verified.claims)
		if (presented === null || !row.callers.includes(presented.caller)) {
			throw new ForbiddenError(`A ${presented?.caller ?? 'resource'} caller cannot call '${row.id}' (callers: ${row.callers.join(', ')})`)
		}
		if (!satisfies(row.requirement, verified.claims.perms)) {
			throw new ForbiddenError(`'${row.id}' needs ${describeRequirement(row)}, and the caller holds none`)
		}
		admit(row, request)
		return {
			principal: presented.principal,
			subject: verified.claims.sub,
			perms: verified.claims.perms,
			token,
			link: verified.claims.link ?? null,
		}
	}

	/**
	 * A staged-kit site runs in one transaction: its statements commit after the handler returned and the output passed
	 * validation, and roll back on a throw, a refused output or a cancelled request.
	 */
	async #procedure(served: Extract<ServedEndpoint, { kind: 'procedure' }>, request: Request): Promise<Response> {
		const caller = await this.#authorize(served.row, request)
		const input = await readInput(served, request)
		const frame = new RequestFrame(crypto.randomUUID(), { readOnly: served.readOnly === true, endpoint: served.row.id })
		const site = served.site
		const invocation = site === undefined ? null : new Invocation(frame, this.#data(), site.kind === 'query' || served.readOnly === true)
		try {
			let result: unknown
			try {
				result = await runInRequest(frame, async () => {
					const membership = this.#membershipRequest(served.row, caller, request, frame)
					const access = await this.#access(served.row, caller, input, frame, membership)
					const ctx = Object.freeze({
						principal: caller.principal,
						requestId: frame.id,
						...access.context,
						...this.#facilities(served.facilities, served.row, membership, access.context['target']),
						...(served.connect === undefined ? {} : { connect: connectContext(served.connect, frame) }),
						...(site === undefined || invocation === null ? {} : siteContext(served.row, site, invocation, caller.subject, access.context)),
					})
					return await served.handler({ input: access.input, ctx })
				})
			} finally {
				frame.end()
			}
			const output = z.safeParse(served.output, projectOutput(served, result))
			if (!output.success) {
				throw new ServerFault('output_refused', `'${served.row.id}' returned a value its output schema refuses`)
			}
			await invocation?.commit(request.signal)
			return jsonResponse({ result: output.data }, 200)
		} finally {
			await invocation?.rollback()
		}
	}

	#data(): DataAccess {
		const data = this.#parts.data
		if (data === null) {
			throw new ServerFault('facility_unbound', 'a site reaches data through ctx.db, and boot bound no @fabrika/db layer')
		}
		return data
	}

	/** The access form reads its value from the path parameter it names: `:owner` of an upload, `:fileId` of a download. */
	async #file(
		served: Extract<ServedEndpoint, { kind: 'file' }>,
		request: Request,
		params: Readonly<Record<string, string>>,
	): Promise<Response | FileDownload> {
		const caller = await this.#authorize(served.row, request)
		const access = served.row.requirement.kind === 'action' ? served.row.requirement.access : null
		const from = access?.form === 'on' ? access.from : null
		const raw = from === null ? undefined : params[from]
		if (from === null || raw === undefined) {
			throw new ServerFault('contract_inconsistent', `'${served.row.id}' names no path parameter for its access form`)
		}
		const frame = new RequestFrame(crypto.randomUUID())
		try {
			return await runInRequest(frame, async () => {
				const { context } = await this.#access(served.row, caller, { [from]: decodePathParameter(raw) }, frame, null)
				return await served.serve(request, context['target'])
			})
		} finally {
			frame.end()
		}
	}

	/** The caller's authority at IAM for this request, when the endpoint's access form names a dimension and an action. */
	#membershipRequest(row: CredentialedEndpoint, caller: Caller, request: Request, frame: RequestFrame): MembershipRequest | null {
		const iam = this.#parts.membership
		if (iam === null || row.requirement.kind !== 'action') {
			return null
		}
		return {
			iam,
			caller: { credential: caller.token, requestId: request.headers.get(REQUEST_ID_HEADER) ?? frame.id },
			delegation: request.headers.get(DELEGATION_HEADER),
			dimension: row.requirement.access.dimension,
			action: row.requirement.action,
			capabilities: this.#parts.capabilities,
		}
	}

	/** `ctx.members` and `ctx.links`, for exactly the endpoints the artifact gives them. */
	#facilities(
		facilities: Facilities,
		row: CredentialedEndpoint,
		membership: MembershipRequest | null,
		target: unknown,
	): Readonly<Record<string, unknown>> {
		const reads = facilities.members === null || facilities.members === 'manage' || row.requirement.kind !== 'action' ? null : facilities.members
		const containers = row.requirement.kind === 'action' ? (this.#parts.containers.get(row.requirement.access.dimension) ?? []) : []
		const directory = reads === null ? {} : { members: memberDirectory(membership, target, { endpoint: row.id, ...reads, containers }) }
		if (facilities.members !== 'manage' && facilities.links.length === 0) {
			return directory
		}
		if (membership === null) {
			throw new ServerFault('facility_unbound', `'${row.id}' manages members or links, and boot bound no IAM membership transport`)
		}
		const members = facilities.members === 'manage' ? { members: memberManagement(membership) } : directory
		const links = facilities.links.length === 0
			? {}
			: { links: linkIssuing(membership, facilities.links, this.#parts.containers.get(membership.dimension) ?? []) }
		return { ...members, ...links }
	}

	async #access(
		row: CredentialedEndpoint,
		caller: Caller,
		input: Readonly<Record<string, unknown>>,
		frame: RequestFrame,
		membership: MembershipRequest | null,
	): Promise<Access> {
		if (row.requirement.kind === 'member') {
			return { context: {}, input }
		}
		const { action, access } = row.requirement
		switch (access.form) {
			case 'over': {
				const direct = scopedValues(caller.perms, action, access.dimension)
				if (direct === null) {
					return { context: { within: this.#parts.mint.within(frame, access.dimension, action, caller.subject, 'all') }, input }
				}
				const held = this.#heldContainers(caller.perms, action, access.dimension)
				if (direct.length === 0 && held.length === 0) {
					throw new ForbiddenError(`The caller holds '${action}' in no ${access.dimension}`)
				}
				return { context: { within: this.#parts.mint.within(frame, access.dimension, action, caller.subject, direct, held) }, input }
			}
			case 'in': {
				const { value, rest } = takeField(input, access.from)
				const direct = permits(caller.perms, action, { type: access.dimension, value })
				// Without a grant on the value or on a container of its dimension, nothing is read: 403 whether it exists or not.
				if (!direct && this.#heldContainers(caller.perms, action, access.dimension).length === 0) {
					throw new ForbiddenError(`The caller does not hold '${action}' in this ${access.dimension}`)
				}
				const chain = await this.#chain(access.dimension, value)
				if (!holdsOnChain(caller.perms, action, access.dimension, value, chain ?? new Map())) {
					throw new ForbiddenError(`The caller does not hold '${action}' in this ${access.dimension}`)
				}
				if (chain === null) {
					throw new NotFoundError('Not found')
				}
				return { context: { target: this.#parts.mint.ref(frame, access.dimension, action, caller.subject, value, chain) }, input: rest }
			}
			case 'on': {
				if (access.from === null) {
					return await this.#linkTarget(row, caller, action, access.dimension, input, frame)
				}
				const { value, rest } = takeField(input, access.from)
				const chain = await this.#chain(access.dimension, value)
				// An object the caller may not act on is indistinguishable from a missing one.
				if (chain === null || !holdsOnChain(caller.perms, action, access.dimension, value, chain)) {
					throw new NotFoundError('Not found')
				}
				return { context: { target: this.#parts.mint.ref(frame, access.dimension, action, caller.subject, value, chain) }, input: rest }
			}
			case 'creates': {
				if (membership === null) {
					throw new ServerFault('facility_unbound', `'${row.id}' creates a scope, and boot bound no IAM membership transport`)
				}
				const value = await createScope(membership)
				return { context: { created: this.#parts.mint.ref(frame, access.dimension, action, caller.subject, value, new Map()) }, input }
			}
		}
	}

	/**
	 * A link procedure acts on the object its key is bound to. The key's mount must be this endpoint's, and the chain
	 * it was issued for must still be where the object lies: a link for a note moved since stops working.
	 */
	async #linkTarget(
		row: CredentialedEndpoint,
		caller: Caller,
		action: string,
		dimension: string,
		input: Readonly<Record<string, unknown>>,
		frame: RequestFrame,
	): Promise<Access> {
		const link = caller.link
		if (link === null || link.mount !== row.source.name) {
			throw new ForbiddenError(`'${row.id}' admits only a key of the link mount '${row.source.name}'`)
		}
		const [object, ...containers] = link.chain
		if (object === undefined || object.type !== dimension || !permits(caller.perms, action, object)) {
			throw new ForbiddenError(`The link does not grant '${action}' on a ${dimension}`)
		}
		const chain = await this.#chain(dimension, object.value)
		const unchanged = chain !== null && chain.size === containers.length && containers.every((scope) => chain.get(scope.type) === scope.value)
		if (chain === null || !unchanged) {
			throw new NotFoundError('This link no longer reaches its object')
		}
		return { context: { target: this.#parts.mint.ref(frame, dimension, action, caller.subject, object.value, chain) }, input }
	}

	/** A form appends one row of its declared fields to its inbox and answers a constant; it reads nothing. */
	async #form(served: Extract<ServedEndpoint, { kind: 'form' }>, request: Request): Promise<Response> {
		admitContentType(served.row, request)
		if (!this.#parts.forms.take(served.form)) {
			throw new HttpError(429, 'rate_limited', `'${served.row.id}' takes no more submissions right now; try again in a minute`)
		}
		const body = await readBoundedBody(request, maxBytesOf(served.row))
		const values = strictInput(served.row, served.input, parseJson(body))
		await this.#framework().appendToInbox(served.form, values)
		return jsonResponse({ result: { received: true } }, 200)
	}

	/**
	 * A GitHub delivery, in order: the binding the path names, the signature over the raw body with that binding's
	 * secret, the account the payload names, the input, then the delivery key — the hash of the binding and the
	 * signed body, so a replay is ignored whatever its unsigned headers say. The handler gets a `Ref` of the bound
	 * value for each declared action and the key, and runs at least once: a failed run is forgotten and redelivered.
	 */
	async #webhook(served: Extract<ServedEndpoint, { kind: 'webhook' }>, request: Request, params: Readonly<Record<string, string>>): Promise<Response> {
		admitContentType(served.row, request)
		const body = await readBoundedBody(request, maxBytesOf(served.row))
		const tables = this.#framework().webhooks
		const bindingId = params[WEBHOOK_BINDING_PARAMETER] ?? ''
		const binding = BINDING_ID.test(bindingId) ? await tables.binding(served.webhook, bindingId) : null
		if (binding === null) {
			throw new NotFoundError('Not found')
		}
		if (!(await verifyGithubSignature(request.headers.get('X-Hub-Signature-256'), binding.secret, body))) {
			throw new UnauthorizedError('The delivery signature does not verify with this binding')
		}
		const payload = parseJson(body)
		if (!githubAccounts(payload).includes(binding.account)) {
			throw new ForbiddenError('The delivery names another account than its binding accepts')
		}
		const input = strictInput(served.row, served.input, stripped(served, payload))
		if (binding.scope.type !== served.dimension) {
			throw new ServerFault(
				'webhook_binding_mismatch',
				`binding '${binding.id}' reaches a '${binding.scope.type}', and '${served.webhook}' is bound to '${served.dimension}'`,
			)
		}
		const chain = await this.#chain(binding.scope.type, binding.scope.value)
		if (chain === null) {
			throw new NotFoundError('The bound value no longer exists')
		}
		// Asked before the delivery is recorded: a delivery that cannot run is not one GitHub must not redeliver.
		const authority = await served.credential.authority()
		if (!authority.ok) {
			throw new ServerFault('workload_unauthorized', `the key of webhook '${served.webhook}' gives it no authority: ${authority.reason}`, 503)
		}
		const unheld = served.actions.find((action) => !permits([...authority.perms], action))
		if (unheld !== undefined) {
			throw new ServerFault('workload_unauthorized', `the token IAM signed for the key of webhook '${served.webhook}' does not carry '${unheld}'`, 503)
		}
		const key = await deliveryKey(binding.id, body)
		const now = Date.now()
		if (!(await tables.recordDelivery(binding.id, key, now, now - WEBHOOK_REPLAY_RETENTION_MS))) {
			return jsonResponse({ result: { received: true } }, 200)
		}
		const frame = new RequestFrame(crypto.randomUUID())
		const site = served.site
		// A staged-kit delivery is one transaction; the delivery record above stays outside it, so a failure forgets it.
		const invocation = site === undefined ? null : new Invocation(frame, this.#data(), false)
		try {
			try {
				await runInRequest(frame, async () => {
					const subject = webhookSubject(binding.id)
					const refs = Object.freeze(
						Object.fromEntries(
							served.actions.map((action) => [action, this.#parts.mint.ref(frame, served.dimension, action, subject, binding.scope.value, chain)]),
						),
					)
					const principal: WebhookPrincipal = Object.freeze({ kind: 'webhook', bindingId: binding.id })
					const delivery = Object.freeze({ key })
					const data = site === undefined || invocation === null
						? {}
						: { db: siteData(invocation.handles('mutation', site, subject)), ...(site.sql === null ? {} : { sql: invocation.sql(site.sql) }) }
					await served.handler({ input, ctx: Object.freeze({ principal, requestId: frame.id, refs, delivery, ...data }) })
				})
			} finally {
				frame.end()
			}
			await invocation?.commit(null)
		} catch (error) {
			await invocation?.rollback()
			// The provider redelivers a failed delivery; forgetting its key lets the redelivery run. The unsigned
			// delivery header is the caller's word, so the log names only the endpoint.
			console.error(`fabrika: ${served.row.id}: delivery_failed; the provider's redelivery runs it again`)
			await tables.forgetDelivery(binding.id, key)
			throw error
		}
		return jsonResponse({ result: { received: true } }, 200)
	}

	#framework(): FrameworkTables {
		const framework = this.#parts.framework
		if (framework === null) {
			throw new ServerFault('facility_unbound', 'no data layer serves the framework tables')
		}
		return framework
	}

	/** The object's containers, read now, so a Ref carries where it lies today; `null` for a missing object a table owns. */
	async #chain(dimension: string, value: string): Promise<ReadonlyMap<string, string> | null> {
		const database = this.#parts.database
		if (database === null || !this.#parts.ownedDimensions.has(dimension)) {
			return new Map()
		}
		return await database.locate(dimension, value)
	}

	/** The container values of `dimension` in which the caller holds `action`. */
	#heldContainers(perms: PermissionEntry[], action: string, dimension: string): ContainerGrant[] {
		return (this.#parts.containers.get(dimension) ?? []).flatMap((container) => {
			const values = scopedValues(perms, action, container) ?? []
			return values.length === 0 ? [] : [{ dimension: container, values }]
		})
	}
}

/** `ctx.db` (by the access form) and the declared `ctx.sql` of a staged-kit endpoint. */
function siteContext(
	row: CredentialedEndpoint,
	site: ServedSite,
	invocation: Invocation,
	principal: string,
	access: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	const form = row.requirement.kind === 'member' ? 'member' : row.requirement.access.form
	const db = endpointData(invocation.handles(site.kind, site.declaration, principal), form, {
		target: access['target'],
		within: access['within'],
		created: access['created'],
	})
	return site.declaration.sql === null ? { db } : { db, sql: invocation.sql(site.declaration.sql) }
}

/** Whether the caller holds `action` on the value or on any container of its chain; IAM evaluates each as a flat scope. */
function holdsOnChain(perms: PermissionEntry[], action: string, dimension: string, value: string, chain: ReadonlyMap<string, string>): boolean {
	const scopes: (readonly [string, string])[] = [[dimension, value], ...chain]
	return scopes.some(([type, scope]) => permits(perms, action, { type, value: scope }))
}

function projectOutput(served: Extract<ServedEndpoint, { kind: 'procedure' }>, result: unknown): unknown {
	try {
		return project(served.output, result)
	} catch (error) {
		if (error instanceof ProjectionRefusedError) {
			throw new ServerFault('output_refused', `'${served.row.id}' returned a value no branch of its output union accepts`)
		}
		throw error
	}
}

/**
 * Admission. A request that carries no `Authorization` header is authenticated by the session cookie the proxy
 * redeemed; when it is not a `GET`, it must come from this origin. A cross-site page cannot add the header: it is
 * not CORS-safelisted, and the application answers no preflight.
 */
function admit(row: CredentialedEndpoint, request: Request): void {
	if (request.method !== 'GET' && !request.headers.has('Authorization') && request.headers.get('Sec-Fetch-Site') !== 'same-origin') {
		throw new HttpError(403, 'admission', 'A session request that is not a GET must be same-origin (Sec-Fetch-Site: same-origin)')
	}
	admitContentType(row, request)
}

/** The content types an endpoint admits; an anonymous endpoint has no session, so this is its whole admission. */
function admitContentType(row: EndpointRow, request: Request): void {
	if (row.admission !== null) {
		const type = mediaType(request.headers.get('Content-Type'))
		if (type === null || !row.admission.contentTypes.includes(type)) {
			throw new HttpError(400, 'admission', `'${row.id}' admits Content-Type ${row.admission.contentTypes.join(' or ')}`)
		}
	}
}

/** An anonymous endpoint's body limit: the framework's, because the proxy never sees the body. */
function maxBytesOf(row: EndpointRow): number {
	const limit = row.admission?.maxBytes
	if (limit === null || limit === undefined) {
		throw new ServerFault('contract_inconsistent', `'${row.id}' declares no body limit`)
	}
	return limit
}

function parseJson(body: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
	} catch {
		throw new BadRequestError('The body is not JSON')
	}
}

/** A webhook input keeps only the fields it declares: a provider sends many more, and none reaches the handler. */
function stripped(served: Extract<ServedEndpoint, { kind: 'webhook' }>, payload: unknown): unknown {
	try {
		return project(served.input, payload)
	} catch (error) {
		if (error instanceof ProjectionRefusedError) {
			throw new BadRequestError(`'${served.row.id}': the delivery matches no branch of the declared input`)
		}
		throw error
	}
}

/** `value` parsed with the endpoint's strict input schema; a refusal is a 400 naming each issue. */
function strictInput(row: EndpointRow, schema: Schema, value: unknown): Readonly<Record<string, unknown>> {
	const parsed = z.safeParse(schema, value)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message }))
		const first = issues[0]
		throw new HttpError(400, 'validation', first === undefined ? 'Invalid input' : `${first.path || 'input'}: ${first.message}`, { issues })
	}
	if (!isRecord(parsed.data)) {
		throw new BadRequestError(`'${row.id}': the input is not an object`)
	}
	return parsed.data
}

/** The strictly parsed input; a procedure without input takes an empty body or `{}`. */
async function readInput(
	served: { readonly row: CredentialedEndpoint; readonly input: Schema | null },
	request: Request,
): Promise<Readonly<Record<string, unknown>>> {
	const text = await request.text()
	let body: unknown = {}
	if (text.trim() !== '') {
		try {
			body = JSON.parse(text)
		} catch {
			throw new BadRequestError('The body is not JSON')
		}
	}
	if (served.input === null) {
		if (!isRecord(body) || Object.keys(body).length > 0) {
			throw new BadRequestError(`'${served.row.id}' takes no input; send {} or an empty body`)
		}
		return {}
	}
	return strictInput(served.row, served.input, body)
}

/** A canonical path's segments all decode; a value that does not is no id of anything. */
function decodePathParameter(raw: string): string {
	try {
		return decodeURIComponent(raw)
	} catch {
		throw new BadRequestError('A path parameter does not decode')
	}
}

/** Removes the `from` field: the only copy of that id the handler gets is the checked capability. */
function takeField(
	input: Readonly<Record<string, unknown>>,
	field: string,
): { readonly value: string; readonly rest: Readonly<Record<string, unknown>> } {
	const value = input[field]
	if (typeof value !== 'string') {
		throw new BadRequestError(`${field}: a string is required`)
	}
	const rest = Object.fromEntries(Object.entries(input).filter(([name]) => name !== field))
	return { value, rest: Object.freeze(rest) }
}

/** The only body a 5xx carries: what failed stays on the server, because it may quote a credential. */
function serverError(status: number): Response {
	return status === 503
		? jsonResponse({ error: { type: 'unavailable', message: 'Service unavailable' } }, 503)
		: jsonResponse({ error: { type: 'internal', message: 'Internal error' } }, status)
}

/**
 * One envelope, `{ error: { type, message, issues? } }`. A client error keeps its own message and issues; every
 * 5xx and every refused capability answers a fixed message; what made a 5xx reaches only `FailureReports`, as a code.
 */
export function errorResponse(error: unknown, where: string): Response {
	if (isStructuralError(error) && error.httpStatus < 500) {
		return toErrorResponse(error)
	}
	if (error instanceof CapabilityLimitError) {
		console.error(`fabrika: ${where}: capability_limit: the caller holds the action in more scope values than one list may carry`)
		return toErrorResponse(new ForbiddenError(`The caller holds the action in more scope values than one list may carry (${MAX_WITHIN_VALUES})`))
	}
	const name = error instanceof Error ? error.name : ''
	// `@fabrika/db` errors carry no status; they are read by name, never by a cross-package `instanceof`.
	if (name === 'NotFoundError') {
		return toErrorResponse(new NotFoundError('Not found'))
	}
	if (name === 'ConflictError') {
		return toErrorResponse(new HttpError(409, 'conflict', 'The object changed since it was read'))
	}
	if (error instanceof ServerFault) {
		return serverError(error.status)
	}
	return serverError(isStructuralError(error) ? error.httpStatus : 500)
}
